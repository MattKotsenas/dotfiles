using System.Diagnostics;
using System.Windows;

namespace PointerUi.Host;

public partial class App : Application
{
    private readonly CancellationTokenSource _stopping = new();
    private OverlayWindowManager? _windows;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var sessionId =
            Process.GetCurrentProcess().SessionId;
        var pipeName =
            PointerUi.Protocol.PointerUiPipe.ForSession(
                sessionId);
        _windows = new OverlayWindowManager();
        var runtime = new PointerUiRuntime(
            Dispatcher,
            _windows,
            new LiveSceneFactory());
        var server = new PointerUiCommandServer(
            pipeName,
            sessionId,
            runtime.Admit,
            runtime.ApplyAsync,
            runtime.WindowCountAsync,
            runtime.DisconnectAsync);
        _ = ObserveServerAsync(server.RunAsync(_stopping.Token));
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _stopping.Cancel();
        _windows?.Hide();
        _stopping.Dispose();
        base.OnExit(e);
    }

    private async Task ObserveServerAsync(Task server)
    {
        try
        {
            await server;
        }
        catch (OperationCanceledException)
            when (_stopping.IsCancellationRequested)
        {
            return;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"Pointer UI host failed: {exception}");
            await Dispatcher.InvokeAsync(() => Shutdown(1));
        }
    }
}
