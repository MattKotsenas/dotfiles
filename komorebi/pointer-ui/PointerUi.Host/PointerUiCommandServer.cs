using System.IO;
using System.IO.Pipes;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Threading.Channels;
using Microsoft.Win32.SafeHandles;
using PointerUi.Protocol;

namespace PointerUi.Host;

internal sealed class PointerUiCommandServer(
    string pipeName,
    int sessionId,
    Func<PointerUiRequest, PointerUiWork> admit,
    Func<PointerUiWork, CancellationToken, Task<PointerUiResponse>>
        handler,
    Func<Task<int>> windowCount,
    Func<Task> disconnected)
{
    private static readonly TimeSpan FrameTimeout =
        TimeSpan.FromSeconds(5);

    private readonly object _admissionGate = new();
    private long _latestSequence = -1;
    private bool _terminal;

    internal Action<PointerUiRequest> BeforeAdmissionGate { get; set; } =
        _ => { };

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await using var pipe = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous
                    | PipeOptions.CurrentUserOnly);
            await pipe.WaitForConnectionAsync(cancellationToken);
            try
            {
                ValidateClientSession(
                    pipe.SafePipeHandle,
                    sessionId);
                await ServeConnectionAsync(
                    pipe,
                    cancellationToken);
            }
            catch (EndOfStreamException)
            {
                Console.Error.WriteLine(
                    "Pointer UI client disconnected.");
            }
            catch (IOException exception)
            {
                Console.Error.WriteLine(
                    $"Pointer UI client disconnected: "
                    + exception.Message);
            }
            catch (TimeoutException exception)
            {
                Console.Error.WriteLine(
                    $"Pointer UI frame timed out: "
                    + exception.Message);
            }
            catch (Exception exception)
                when (exception is InvalidDataException
                    or System.Text.Json.JsonException
                    or ArgumentException)
            {
                Console.Error.WriteLine(
                    $"Invalid pointer UI request: "
                    + exception.Message);
            }
            finally
            {
                await disconnected();
            }
        }
    }

    private async Task ServeConnectionAsync(
        Stream stream,
        CancellationToken cancellationToken)
    {
        lock (_admissionGate)
        {
            _latestSequence = -1;
            _terminal = false;
        }

        using var connectionCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken);
        var fastRequests = RequestChannel();
        var uiRequests = RequestChannel();
        var responses =
            Channel.CreateBounded<PointerUiResponse>(
                new BoundedChannelOptions(16)
                {
                    FullMode = BoundedChannelFullMode.Wait,
                    SingleReader = true,
                    SingleWriter = false,
                    AllowSynchronousContinuations = false,
                });
        var tasks = new[]
        {
            ReadRequestsAsync(
                stream,
                fastRequests.Writer,
                uiRequests.Writer,
                responses.Writer,
                connectionCancellation.Token),
            ProcessRequestsAsync(
                fastRequests.Reader,
                responses.Writer,
                windowCount,
                connectionCancellation.Token),
            ProcessRequestsAsync(
                uiRequests.Reader,
                responses.Writer,
                windowCount,
                connectionCancellation.Token),
            WriteResponsesAsync(
                stream,
                responses.Reader,
                connectionCancellation.Token),
        };
        var completed = await Task.WhenAny(tasks);
        ExceptionDispatchInfo? error = null;
        try
        {
            await completed;
        }
        catch (Exception exception)
        {
            error = ExceptionDispatchInfo.Capture(exception);
        }
        finally
        {
            connectionCancellation.Cancel();
            fastRequests.Writer.TryComplete();
            uiRequests.Writer.TryComplete();
            responses.Writer.TryComplete();
            try
            {
                await Task.WhenAll(tasks);
            }
            catch (OperationCanceledException)
                when (connectionCancellation
                    .IsCancellationRequested)
            {
                Console.Error.WriteLine(
                    "Pointer UI connection stopped.");
            }
            catch (Exception exception)
                when (error is not null)
            {
                Console.Error.WriteLine(
                    $"Pointer UI connection cleanup failed: "
                    + exception.Message);
            }
        }
        error?.Throw();
    }

    private async Task ReadRequestsAsync(
        Stream stream,
        ChannelWriter<PointerUiRequest> fastRequests,
        ChannelWriter<PointerUiRequest> uiRequests,
        ChannelWriter<PointerUiResponse> responses,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var request =
                await PointerUiProtocol.ReadRequestAsync(
                    stream,
                    FrameTimeout,
                    cancellationToken);
            bool terminal;
            lock (_admissionGate)
            {
                terminal = _terminal;
                if (!terminal)
                {
                    _latestSequence = request.Sequence;
                }
            }
            if (terminal)
            {
                await Task.Delay(
                    Timeout.InfiniteTimeSpan,
                    cancellationToken);
                return;
            }
            var writer = request.Mode is PointerUiMode.UiHints
                ? uiRequests
                : fastRequests;
            if (!writer.TryWrite(request))
            {
                await responses.WriteAsync(
                    new PointerUiResponse(
                        PointerUiProtocol.CurrentVersion,
                        request.Sequence,
                        request.Mode,
                        false,
                        await windowCount(),
                        null,
                        false),
                    cancellationToken);
            }
        }
    }

    private async Task ProcessRequestsAsync(
        ChannelReader<PointerUiRequest> requests,
        ChannelWriter<PointerUiResponse> responses,
        Func<Task<int>> getWindowCount,
        CancellationToken cancellationToken)
    {
        await foreach (var request in requests.ReadAllAsync(
            cancellationToken))
        {
            BeforeAdmissionGate(request);
            PointerUiWork? work = null;
            lock (_admissionGate)
            {
                if (request.Sequence == _latestSequence)
                {
                    work = admit(request);
                }
            }
            if (work is null)
            {
                await responses.WriteAsync(
                    new PointerUiResponse(
                        PointerUiProtocol.CurrentVersion,
                        request.Sequence,
                        request.Mode,
                        false,
                        await getWindowCount(),
                        null,
                        false),
                    cancellationToken);
                continue;
            }
            var response = await handler(
                work,
                cancellationToken);
            await responses.WriteAsync(
                response,
                cancellationToken);
        }
    }

    private async Task WriteResponsesAsync(
        Stream stream,
        ChannelReader<PointerUiResponse> responses,
        CancellationToken cancellationToken)
    {
        await foreach (var response in responses.ReadAllAsync(
            cancellationToken))
        {
            PointerUiResponse current;
            bool terminal;
            lock (_admissionGate)
            {
                current = response;
                if (response.Sequence != _latestSequence
                    && response.Error is not null
                    && !response.RestartRequired)
                {
                    current = response with
                    {
                        Applied = false,
                        Error = null,
                    };
                }
                terminal = current.RestartRequired;
                if (terminal)
                {
                    _terminal = true;
                }
            }

            if (terminal)
            {
                try
                {
                    await WriteResponseAsync(
                        stream,
                        current,
                        cancellationToken);
                }
                catch (Exception exception)
                {
                    throw new InvalidOperationException(
                        "Pointer UI terminal response could "
                        + "not be delivered.",
                        exception);
                }
                throw new InvalidOperationException(
                    $"Pointer UI command failed: "
                    + (current.Error
                        ?? "host restart required"));
            }
            await WriteResponseAsync(
                stream,
                current,
                cancellationToken);
        }
    }

    private static Channel<PointerUiRequest>
        RequestChannel() =>
        Channel.CreateBounded<PointerUiRequest>(
            new BoundedChannelOptions(1)
            {
                FullMode = BoundedChannelFullMode.Wait,
                SingleReader = true,
                SingleWriter = true,
                AllowSynchronousContinuations = false,
            });

    private static async Task WriteResponseAsync(
        Stream stream,
        PointerUiResponse response,
        CancellationToken cancellationToken)
    {
        using var timeout =
            CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken);
        timeout.CancelAfter(FrameTimeout);
        try
        {
            await PointerUiProtocol.WriteAsync(
                stream,
                response,
                timeout.Token);
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException(
                "Writing a pointer UI frame exceeded "
                + $"{FrameTimeout.TotalSeconds:0} seconds.");
        }
    }

    private static void ValidateClientSession(
        SafePipeHandle pipe,
        int expectedSessionId)
    {
        if (!GetNamedPipeClientSessionId(
                pipe,
                out var clientSessionId))
        {
            throw new InvalidOperationException(
                "Reading the pointer UI client session failed.",
                new System.ComponentModel.Win32Exception(
                    Marshal.GetLastPInvokeError()));
        }
        if (clientSessionId != (uint)expectedSessionId)
        {
            throw new InvalidDataException(
                $"Pointer UI client session {clientSessionId} "
                + $"does not match host session {expectedSessionId}.");
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientSessionId(
        SafePipeHandle pipe,
        out uint clientSessionId);
}
