using EventListeners.Generated;
using EventListeners.Models;
using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class AppLayerRouterTests
{
    private static AppLayerRouter CreateRouter(out RecordingKanataClient kanata, IReadOnlyList<Func<FocusContext, string?>>? rules = null)
    {
        kanata = new RecordingKanataClient();
        return new AppLayerRouter(NullLogger<AppLayerRouter>.Instance, kanata, rules ?? []);
    }

    [Fact]
    public void EmptyRules_FocusEvent_ResolvesToBaseDefault()
    {
        var router = CreateRouter(out var kanata);

        var ctx = new FocusContext("anything.exe", "title", 42);
        Assert.Equal(LayerCatalog.BaseDefault, router.Route(ctx));
    }

    [Fact]
    public void Rules_RunInOrder_FirstMatchWins()
    {
        Func<FocusContext, string?> first  = c => c.Exe == "first.exe"  ? "wm-first"  : null;
        Func<FocusContext, string?> second = c => c.Exe == "first.exe"  ? "wm-second" : null;
        var router = CreateRouter(out _, [first, second]);

        Assert.Equal("wm-first", router.Route(new FocusContext("first.exe", null, 1)));
    }

    [Fact]
    public void Rules_NullSkipsToNext()
    {
        Func<FocusContext, string?> skip  = _ => null;
        Func<FocusContext, string?> match = c => c.Exe == "x.exe" ? "wm-x" : null;
        var router = CreateRouter(out _, [skip, match]);

        Assert.Equal("wm-x", router.Route(new FocusContext("x.exe", null, 1)));
    }

    [Fact]
    public void Rules_NoneMatch_FallsBackToBaseDefault()
    {
        Func<FocusContext, string?> nope = _ => null;
        var router = CreateRouter(out _, [nope, nope]);

        Assert.Equal(LayerCatalog.BaseDefault, router.Route(new FocusContext("x.exe", null, 1)));
    }

    [Fact]
    public void DefaultRules_RouteWindowsTerminalToTerminalOverlay()
    {
        var ctx = new FocusContext("WindowsTerminal.exe", "PowerShell", 1);

        var match = AppLayerRouter.DefaultRules
            .Select(r => r(ctx))
            .FirstOrDefault(r => r is not null);

        Assert.Equal(LayerCatalog.BaseTerminal, match);
    }

    [Fact]
    public void DefaultRules_DoNotMatchOtherApps()
    {
        var ctx = new FocusContext("Code.exe", "VSCode", 1);

        var match = AppLayerRouter.DefaultRules
            .Select(r => r(ctx))
            .FirstOrDefault(r => r is not null);

        Assert.Null(match);
    }
}

internal sealed class RecordingKanataClient : IKanataClient
{
    public List<string> ChangeLayerCalls { get; } = [];

    public Task SendChangeLayerAsync(string layerName, CancellationToken cancellationToken = default)
    {
        ChangeLayerCalls.Add(layerName);
        return Task.CompletedTask;
    }
}
