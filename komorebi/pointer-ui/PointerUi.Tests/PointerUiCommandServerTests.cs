using System.Diagnostics;
using System.IO.Pipes;
using PointerUi.Host;
using PointerUi.Protocol;

namespace PointerUi.Tests;

public sealed class PointerUiCommandServerTests
{
    [Fact]
    public async Task RecoverableError_KeepsConnectionOpen()
    {
        var calls = 0;
        var fixture = ServerFixture.Create(
            (work, _) =>
            {
                var call = Interlocked.Increment(ref calls);
                return Task.FromResult(new PointerUiResponse(
                    PointerUiProtocol.CurrentVersion,
                    work.Request.Sequence,
                    work.Request.Mode,
                    call > 1,
                    call > 1 ? 1 : 0,
                    call == 1 ? "recoverable" : null,
                    false));
            });
        await using var client = await fixture.ConnectAsync();

        try
        {
            await PointerUiProtocol.WriteAsync(
                client,
                Request(1, PointerUiMode.Indicator));
            var rejected =
                await PointerUiProtocol.ReadResponseAsync(
                    client);
            Assert.Equal("recoverable", rejected.Error);
            Assert.False(rejected.Applied);

            await PointerUiProtocol.WriteAsync(
                client,
                Request(2, PointerUiMode.Indicator));
            var applied =
                await PointerUiProtocol.ReadResponseAsync(
                    client);
            Assert.Null(applied.Error);
            Assert.True(applied.Applied);
            Assert.Equal(2, calls);
        }
        finally
        {
            await fixture.DisposeAsync();
        }
    }

    [Fact]
    public async Task SaturatedUiLane_RejectsWithoutAdmission()
    {
        var admitted = 0;
        var started = NewSignal();
        var release = NewSignal();
        var fixture = ServerFixture.Create(
            async (work, cancellationToken) =>
            {
                started.TrySetResult();
                await release.Task.WaitAsync(
                    cancellationToken);
                return Applied(work.Request);
            },
            onAdmit: _ => Interlocked.Increment(ref admitted),
            windowCount: 7);
        await using var client = await fixture.ConnectAsync();

        try
        {
            await PointerUiProtocol.WriteAsync(
                client,
                Request(1, PointerUiMode.UiHints));
            await started.Task.WaitAsync(
                TimeSpan.FromSeconds(5));
            await PointerUiProtocol.WriteAsync(
                client,
                Request(2, PointerUiMode.UiHints));
            await PointerUiProtocol.WriteAsync(
                client,
                Request(3, PointerUiMode.UiHints));

            var rejected =
                await PointerUiProtocol.ReadResponseAsync(
                    client)
                .WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(3, rejected.Sequence);
            Assert.False(rejected.Applied);
            Assert.Equal(7, rejected.OverlayWindowCount);
            Assert.Equal(1, Volatile.Read(ref admitted));
        }
        finally
        {
            release.TrySetResult();
            await fixture.DisposeAsync();
        }
    }

    [Fact]
    public async Task Hidden_RejectsOlderQueuedUiRequest()
    {
        var admitted = new List<long>();
        var firstStarted = NewSignal();
        var releaseFirst = NewSignal();
        var fixture = ServerFixture.Create(
            async (work, cancellationToken) =>
            {
                if (work.Request.Sequence == 1)
                {
                    firstStarted.TrySetResult();
                    await releaseFirst.Task.WaitAsync(
                        cancellationToken);
                }
                return Applied(work.Request);
            },
            onAdmit: request =>
            {
                lock (admitted)
                {
                    admitted.Add(request.Sequence);
                }
            });
        await using var client = await fixture.ConnectAsync();

        try
        {
            await PointerUiProtocol.WriteAsync(
                client,
                Request(1, PointerUiMode.UiHints));
            await firstStarted.Task.WaitAsync(
                TimeSpan.FromSeconds(5));
            await PointerUiProtocol.WriteAsync(
                client,
                Request(2, PointerUiMode.UiHints));
            await PointerUiProtocol.WriteAsync(
                client,
                Request(3, PointerUiMode.Hidden));

            var hidden =
                await PointerUiProtocol.ReadResponseAsync(
                    client)
                .WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(3, hidden.Sequence);
            Assert.True(hidden.Applied);

            releaseFirst.TrySetResult();
            var responses = new[]
            {
                await PointerUiProtocol.ReadResponseAsync(
                    client),
                await PointerUiProtocol.ReadResponseAsync(
                    client),
            };
            var stale = Assert.Single(
                responses,
                response => response.Sequence == 2);
            Assert.False(stale.Applied);
            lock (admitted)
            {
                Assert.DoesNotContain(2, admitted);
            }
        }
        finally
        {
            releaseFirst.TrySetResult();
            await fixture.DisposeAsync();
        }
    }

    [Fact]
    public async Task FreshnessIsCheckedInsideAdmissionGate()
    {
        var atGate = NewSignal();
        var releaseGate = NewSignal();
        var admitted = new List<long>();
        var fixture = ServerFixture.Create(
            (work, _) => Task.FromResult(
                Applied(work.Request)),
            onAdmit: request =>
            {
                lock (admitted)
                {
                    admitted.Add(request.Sequence);
                }
            });
        fixture.Server.BeforeAdmissionGate = request =>
        {
            if (request.Sequence == 1)
            {
                atGate.TrySetResult();
                releaseGate.Task
                    .Wait(TimeSpan.FromSeconds(5));
            }
        };
        await using var client = await fixture.ConnectAsync();

        try
        {
            await PointerUiProtocol.WriteAsync(
                client,
                Request(1, PointerUiMode.UiHints));
            await atGate.Task.WaitAsync(
                TimeSpan.FromSeconds(5));
            await PointerUiProtocol.WriteAsync(
                client,
                Request(2, PointerUiMode.Hidden));
            var hidden =
                await PointerUiProtocol.ReadResponseAsync(
                    client)
                .WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(2, hidden.Sequence);
            Assert.True(hidden.Applied);

            releaseGate.TrySetResult();
            var stale =
                await PointerUiProtocol.ReadResponseAsync(
                    client)
                .WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(1, stale.Sequence);
            Assert.False(stale.Applied);
            lock (admitted)
            {
                Assert.Equal([2L], admitted);
            }
        }
        finally
        {
            releaseGate.TrySetResult();
            await fixture.DisposeAsync();
        }
    }

    private static PointerUiResponse Applied(
        PointerUiRequest request) =>
        new(
            PointerUiProtocol.CurrentVersion,
            request.Sequence,
            request.Mode,
            true,
            request.Mode is PointerUiMode.Hidden ? 0 : 1,
            null,
            false);

    private static TaskCompletionSource NewSignal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static PointerUiRequest Request(
        long sequence,
        PointerUiMode mode) =>
        new(
            PointerUiProtocol.CurrentVersion,
            sequence,
            mode);

    private sealed class ServerFixture : IAsyncDisposable
    {
        private readonly CancellationTokenSource _stopping =
            new();
        private readonly Task _running;
        private readonly string _pipeName;

        private ServerFixture(
            string pipeName,
            PointerUiCommandServer server)
        {
            _pipeName = pipeName;
            Server = server;
            _running = server.RunAsync(_stopping.Token);
        }

        public PointerUiCommandServer Server { get; }

        public static ServerFixture Create(
            Func<PointerUiWork, CancellationToken, Task<PointerUiResponse>>
                handler,
            Action<PointerUiRequest>? onAdmit = null,
            int windowCount = 0)
        {
            var pipeName =
                $"pointer-ui-server-test-{Guid.NewGuid():N}";
            var server = new PointerUiCommandServer(
                pipeName,
                Process.GetCurrentProcess().SessionId,
                request =>
                {
                    onAdmit?.Invoke(request);
                    return new PointerUiWork(
                        request,
                        request.Sequence);
                },
                handler,
                () => Task.FromResult(windowCount),
                () => Task.CompletedTask);
            return new ServerFixture(pipeName, server);
        }

        public async Task<NamedPipeClientStream> ConnectAsync()
        {
            var client = new NamedPipeClientStream(
                ".",
                _pipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous
                    | PipeOptions.CurrentUserOnly);
            try
            {
                await client.ConnectAsync(
                    5000,
                    CancellationToken.None);
                return client;
            }
            catch
            {
                await client.DisposeAsync();
                throw;
            }
        }

        public async ValueTask DisposeAsync()
        {
            _stopping.Cancel();
            try
            {
                await _running;
            }
            catch (OperationCanceledException)
                when (_stopping.IsCancellationRequested)
            {
                Assert.True(_stopping.IsCancellationRequested);
            }
            _stopping.Dispose();
        }
    }
}
