using System.Windows.Threading;
using PointerUi.Protocol;

namespace PointerUi.Host;

internal sealed record PointerUiWork(
    PointerUiRequest Request,
    long Generation,
    HintInputResult? InputResult = null,
    string? InputError = null);

internal sealed class PointerUiRuntime(
    Dispatcher dispatcher,
    OverlayWindowManager windows,
    LiveSceneFactory scenes)
{
    private static readonly TimeSpan UiHintTimeout =
        TimeSpan.FromSeconds(10);
    private static readonly TimeSpan IndicatorInterval =
        TimeSpan.FromMilliseconds(16);

    private readonly object _indicatorGate = new();
    private readonly object _sessionGate = new();
    private readonly SemaphoreSlim _uiHintGate = new(1, 1);
    private CancellationTokenSource? _indicatorCancellation;
    private HintInputSession? _hintSession;
    private long _hintGeneration = -1;
    private long _generation;

    public PointerUiWork Admit(PointerUiRequest request)
    {
        if (request.Input is not null)
        {
            var sessionToken = request.Input.SessionToken;
            lock (_sessionGate)
            {
                if (_hintSession is null
                    || request.Mode
                        is not PointerUiMode.UiHints
                    || _hintGeneration != sessionToken)
                {
                    return new PointerUiWork(
                        request,
                        sessionToken,
                        InputError:
                            "No matching hint session is active.");
                }
                var result = request.Input.Kind switch
                {
                    PointerUiInputKind.Key =>
                        _hintSession.Press(
                            request.Input.Key!,
                            pointOnly: false),
                    PointerUiInputKind.Backspace =>
                        _hintSession.Backspace(),
                    PointerUiInputKind.Cancel =>
                        _hintSession.Cancel(),
                    _ => throw new ArgumentOutOfRangeException(
                        nameof(request),
                        request.Input.Kind,
                        "Unknown pointer UI input."),
                };
                if (result.Status is not HintInputStatus.Active)
                {
                    _hintSession = null;
                    _hintGeneration = -1;
                }
                return new PointerUiWork(
                    request,
                    sessionToken,
                    result);
            }
        }
        long generation;
        lock (_sessionGate)
        {
            generation = Interlocked.Increment(
                ref _generation);
            _hintSession = null;
            _hintGeneration = -1;
        }
        CancelIndicator();
        return new PointerUiWork(request, generation);
    }

    public async Task<PointerUiResponse> ApplyAsync(
        PointerUiWork work,
        CancellationToken cancellationToken)
    {
        var request = work.Request;
        var generation = work.Generation;
        if (request.Input is not null)
        {
            return await ApplyInputAsync(
                work,
                cancellationToken);
        }
        try
        {
            if (request.Mode is PointerUiMode.Hidden)
            {
                var hiddenCount = await dispatcher.InvokeAsync(
                    () => IsCurrent(generation)
                        ? windows.Hide()
                        : windows.Count,
                    DispatcherPriority.Send,
                    cancellationToken);
                ClearHintSession(generation);
                return Response(
                    request,
                    IsCurrent(generation),
                    hiddenCount,
                    null,
                    restartRequired: false);
            }

            if (!IsCurrent(generation))
            {
                return Response(
                    request,
                    applied: false,
                    await WindowCountAsync(),
                    null,
                    restartRequired: false);
            }

            var frame = request.Mode is PointerUiMode.UiHints
                ? await CreateUiHintsAsync(
                    generation,
                    cancellationToken)
                : await Task.Run(
                    () => scenes.Create(request.Mode),
                    cancellationToken);
            if (frame is null)
            {
                return Response(
                    request,
                    applied: false,
                    await WindowCountAsync(),
                    null,
                    restartRequired: false);
            }
            if (!IsCurrent(generation))
            {
                return Response(
                    request,
                    applied: false,
                    await WindowCountAsync(),
                    null,
                    restartRequired: false);
            }

            var visibleCount =
                await dispatcher.InvokeAsync(
                    () => IsCurrent(generation)
                        ? windows.Show(frame)
                        : windows.Count,
                    DispatcherPriority.Send,
                    cancellationToken);
            var applied = IsCurrent(generation);
            if (applied)
            {
                SetHintSession(
                    request.Mode,
                    frame.Targets,
                    generation);
            }
            if (applied
                && request.Mode
                    is PointerUiMode.Indicator)
            {
                StartIndicator(
                    generation,
                    cancellationToken);
            }
            return Response(
                request,
                applied,
                visibleCount,
                null,
                restartRequired: false,
                sessionToken: applied
                    && request.Mode is PointerUiMode.UiHints
                        ? generation
                        : null);
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            return Response(
                request,
                applied: false,
                await WindowCountAsync(),
                null,
                restartRequired: false);
        }
        catch (TimeoutException exception)
        {
            Console.Error.WriteLine(
                $"Pointer UI {request.Mode} timed out: "
                + exception.Message);
            return Response(
                request,
                applied: false,
                await WindowCountAsync(),
                exception.Message,
                restartRequired: true);
        }
        catch (Exception exception)
            when (!IsFatal(exception))
        {
            if (!IsCurrent(generation))
            {
                return Response(
                    request,
                    applied: false,
                    await WindowCountAsync(),
                    null,
                    restartRequired: false);
            }
            Console.Error.WriteLine(
                $"Pointer UI {request.Mode} failed: {exception}");
            var outcome = await dispatcher.InvokeAsync(
                () => Interlocked.CompareExchange(
                        ref _generation,
                        generation + 1,
                        generation) == generation
                    ? (Current: true, Count: windows.Hide())
                    : (Current: false, Count: windows.Count),
                DispatcherPriority.Send);
            if (!outcome.Current)
            {
                return Response(
                    request,
                    applied: false,
                    outcome.Count,
                    null,
                    restartRequired: false);
            }
            ClearHintSession(generation);
            return Response(
                request,
                applied: false,
                outcome.Count,
                exception.Message,
                restartRequired: false);
        }
    }

    public async Task DisconnectAsync()
    {
        Interlocked.Increment(ref _generation);
        CancelIndicator();
        ClearHintSession();
        await dispatcher.InvokeAsync(
            windows.Hide,
            DispatcherPriority.Send);
    }

    private async Task FollowPointerAsync(
        long generation,
        CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(
            IndicatorInterval);
        try
        {
            while (IsCurrent(generation)
                && await timer.WaitForNextTickAsync(
                    cancellationToken))
            {
                var frame = await Task.Run(
                    () => scenes.Create(
                        PointerUiMode.Indicator),
                    cancellationToken);
                await dispatcher.InvokeAsync(
                    () =>
                    {
                        if (IsCurrent(generation))
                        {
                            windows.Update(frame);
                        }
                    },
                    DispatcherPriority.Render,
                    cancellationToken);
            }
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"Pointer indicator refresh failed: {exception}");
            if (Interlocked.CompareExchange(
                    ref _generation,
                    generation + 1,
                    generation) == generation)
            {
                await dispatcher.InvokeAsync(
                    () =>
                    {
                        if (Volatile.Read(ref _generation)
                            == generation + 1)
                        {
                            windows.Hide();
                            System.Windows.Application.Current
                                .Shutdown(1);
                        }
                    },
                    DispatcherPriority.Send);
            }
        }
    }

    private bool IsCurrent(long generation) =>
        Volatile.Read(ref _generation) == generation;

    private void StartIndicator(
        long generation,
        CancellationToken connectionToken)
    {
        var cancellation =
            CancellationTokenSource.CreateLinkedTokenSource(
                connectionToken);
        lock (_indicatorGate)
        {
            if (!IsCurrent(generation))
            {
                cancellation.Dispose();
                return;
            }
            _indicatorCancellation = cancellation;
        }

        var task = FollowPointerAsync(
            generation,
            cancellation.Token);
        _ = task.ContinueWith(
            completed =>
            {
                if (completed.IsFaulted)
                {
                    Console.Error.WriteLine(
                        $"Pointer indicator task failed: "
                        + completed.Exception);
                }
                lock (_indicatorGate)
                {
                    if (ReferenceEquals(
                            _indicatorCancellation,
                            cancellation))
                    {
                        _indicatorCancellation = null;
                    }
                }
                cancellation.Dispose();
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private void CancelIndicator()
    {
        lock (_indicatorGate)
        {
            _indicatorCancellation?.Cancel();
            _indicatorCancellation = null;
        }
    }

    internal async Task<int> WindowCountAsync() =>
        await dispatcher.InvokeAsync(
            () => windows.Count,
            DispatcherPriority.Send);

    private static bool IsFatal(Exception exception) =>
        exception is OutOfMemoryException
        or StackOverflowException
        or AccessViolationException;

    private async Task<LiveOverlayFrame?>
        CreateUiHintsAsync(
            long generation,
            CancellationToken cancellationToken)
    {
        await _uiHintGate.WaitAsync(cancellationToken);
        var releaseGate = true;
        try
        {
            if (!IsCurrent(generation))
            {
                return null;
            }

            var frameTask = Task.Run(
                () => scenes.Create(
                    PointerUiMode.UiHints));
            try
            {
                return await frameTask.WaitAsync(
                    UiHintTimeout,
                    cancellationToken);
            }
            catch (OperationCanceledException)
                when (cancellationToken.IsCancellationRequested
                    && !frameTask.IsCompleted)
            {
                releaseGate = false;
                ObserveFault(frameTask);
                await dispatcher.InvokeAsync(
                    () => System.Windows.Application.Current
                        .Shutdown(1),
                    DispatcherPriority.Send);
                throw;
            }
            catch
            {
                if (!frameTask.IsCompleted)
                {
                    releaseGate = false;
                }
                ObserveFault(frameTask);
                throw;
            }
        }
        finally
        {
            if (releaseGate)
            {
                _uiHintGate.Release();
            }
        }
    }

    private static void ObserveFault(Task task) =>
        _ = task.ContinueWith(
            completed => _ = completed.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted
                | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

    private async Task<PointerUiResponse> ApplyInputAsync(
        PointerUiWork work,
        CancellationToken cancellationToken)
    {
        var request = work.Request;
        var sessionToken = work.Generation;
        if (work.InputResult is null)
        {
            return Response(
                request,
                applied: false,
                await WindowCountAsync(),
                work.InputError
                    ?? "Pointer UI input was not applied.",
                restartRequired: false);
        }

        var result = work.InputResult;
        var completed = result.Status
            is not HintInputStatus.Active;
        var count = completed
            ? await dispatcher.InvokeAsync(
                () => IsCurrent(sessionToken)
                    ? windows.Hide()
                    : windows.Count,
                DispatcherPriority.Send,
                cancellationToken)
            : await WindowCountAsync();
        return new PointerUiResponse(
            PointerUiProtocol.CurrentVersion,
            request.Sequence,
            request.Mode,
            true,
            count,
            null,
            false,
            new PointerUiInputResult(
                result.Status switch
                {
                    HintInputStatus.Active =>
                        PointerUiSessionStatus.Active,
                    HintInputStatus.Completed =>
                        PointerUiSessionStatus.Completed,
                    HintInputStatus.Cancelled =>
                        PointerUiSessionStatus.Cancelled,
                    _ => throw new ArgumentOutOfRangeException(),
                },
                result.Prefix,
                result.Accepted,
                result.Target?.Label),
            sessionToken);
    }

    private void SetHintSession(
        PointerUiMode mode,
        IReadOnlyList<TargetSnapshot> targets,
        long generation)
    {
        lock (_sessionGate)
        {
            if (!IsCurrent(generation))
            {
                return;
            }
            if (mode is PointerUiMode.UiHints)
            {
                _hintSession = new HintInputSession(targets);
                _hintGeneration = generation;
            }
            else
            {
                _hintSession = null;
                _hintGeneration = -1;
            }
        }
    }

    private void ClearHintSession()
    {
        lock (_sessionGate)
        {
            _hintSession = null;
            _hintGeneration = -1;
        }
    }

    private void ClearHintSession(long generation)
    {
        lock (_sessionGate)
        {
            if (_hintGeneration > generation)
            {
                return;
            }
            _hintSession = null;
            _hintGeneration = -1;
        }
    }

    private static PointerUiResponse Response(
        PointerUiRequest request,
        bool applied,
        int windowCount,
        string? error,
        bool restartRequired,
        long? sessionToken = null) =>
        new(
            PointerUiProtocol.CurrentVersion,
            request.Sequence,
            request.Mode,
            applied,
            windowCount,
            error,
            restartRequired,
            null,
            sessionToken);
}
