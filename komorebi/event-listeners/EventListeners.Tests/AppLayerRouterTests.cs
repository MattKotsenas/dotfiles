using EventListeners.Generated;
using EventListeners.Models;
using Microsoft.Extensions.Logging.Abstractions;

namespace EventListeners.Tests;

public class AppLayerRouterTests
{
    private static AppLayerRouter CreateRouter(out RecordingKanataClient kanata, IReadOnlyList<Func<FocusContext, string?>>? rules = null)
    {
        var k = new RecordingKanataClient();
        kanata = k;
        var lazy = new Lazy<IKanataClient>(() => k);
        return new AppLayerRouter(NullLogger<AppLayerRouter>.Instance, lazy, rules ?? []);
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
        Assert.Equal(LayerCatalog.BaseTerminal, FirstRuleMatch(ctx));
    }

    [Fact]
    public void DefaultRules_RouteEdgeToEdgeOverlay()
    {
        var ctx = new FocusContext("msedge.exe", "GitHub", 1);
        Assert.Equal(LayerCatalog.BaseEdge, FirstRuleMatch(ctx));
    }

    [Fact]
    public void DefaultRules_RouteTeamsToTeamsOverlay()
    {
        Assert.Equal(LayerCatalog.BaseTeams,
            FirstRuleMatch(new FocusContext("ms-teams.exe", "Chat | Microsoft Teams", 1)));
        Assert.Equal(LayerCatalog.BaseTeams,
            FirstRuleMatch(new FocusContext("ms-teams.exe", "asdf | Microsoft Teams", 1)));
    }

    [Fact]
    public void DefaultRules_RouteCodeFlowToCodeflowOverlay()
    {
        var ctx = new FocusContext("CodeFlow.exe", "Some review - CodeFlow / Azure DevOps", 1);
        Assert.Equal(LayerCatalog.BaseCodeflow, FirstRuleMatch(ctx));
    }

    [Fact]
    public void DefaultRules_DoNotMatchOtherApps()
    {
        var ctx = new FocusContext("Code.exe", "VSCode", 1);
        Assert.Null(FirstRuleMatch(ctx));
    }

    private static string? FirstRuleMatch(FocusContext ctx) =>
        AppLayerRouter.DefaultRules.Select(r => r(ctx)).FirstOrDefault(r => r is not null);

    // --- ProcessEvent tests (cache discipline + self-heal) -----------------

    [Fact]
    public void ProcessEvent_FirstFocus_SendsTargetLayer()
    {
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);

        router.ProcessEvent(FocusEvent("msedge.exe", "x", 1));

        Assert.Equal([LayerCatalog.BaseEdge], kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_BaseLayerEcho_SuppressesRedundantSend()
    {
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);
        router.ProcessEvent(FocusEvent("msedge.exe", "x", 1));
        Assert.Single(kanata.ChangeLayerCalls);

        // Kanata acknowledges the change; cache should now match.
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseEdge));

        // Re-focusing the same app must not produce another send.
        router.ProcessEvent(FocusEvent("msedge.exe", "y", 2));
        Assert.Single(kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_FocusEventWhileInWmMode_DefersSend()
    {
        // User is focused on Edge, then taps CAP into wm-edge-toggle, then a
        // sub-mode like wm-focus-toggle. While there, focus moves to a
        // different-app window (e.g., focus right cross-app). The router must
        // NOT send a base ChangeLayer mid-WM-mode; that would kill WM mode and
        // hide the on-screen • dot.
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);
        router.ProcessEvent(FocusEvent("msedge.exe", "x", 1));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseEdge));
        Assert.Single(kanata.ChangeLayerCalls);

        // User enters sticky WM mode (overlay-aware then sub-mode).
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.WmEdgeToggle));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.WmFocusToggle));

        // Cross-app focus event arrives mid-WM-mode (terminal got focus).
        router.ProcessEvent(FocusEvent("WindowsTerminal.exe", "ps", 2));

        // No additional ChangeLayer was sent — the change is deferred.
        Assert.Single(kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_ReturnToBaseAfterDeferredFocus_RestoresDesired()
    {
        // Continuation of the previous scenario: after the user exits the
        // sub-mode toggle (CAPS exits to base-default per the shared sub-mode
        // exit binding), the router must push the deferred target so kanata
        // ends up on base-terminal, not base-default.
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);
        router.ProcessEvent(FocusEvent("msedge.exe", "x", 1));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseEdge));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.WmEdgeToggle));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.WmFocusToggle));
        router.ProcessEvent(FocusEvent("WindowsTerminal.exe", "ps", 2));
        Assert.Single(kanata.ChangeLayerCalls);

        // User taps CAPS to exit; the sub-mode toggle's CAPS binding hard-exits
        // to base-default regardless of overlay context.
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseDefault));

        // Router should have sent a corrective ChangeLayer to the deferred target.
        Assert.Equal(
            [LayerCatalog.BaseEdge, LayerCatalog.BaseTerminal],
            kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_MultipleFocusEventsDuringWmMode_LatestWinsOnRestore()
    {
        // While the user is mid-WM-mode, multiple focus events arrive (rapid
        // app switching by some other process, or chained focus.right intents).
        // Only the latest desired target should be applied when WM mode exits.
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);
        router.ProcessEvent(FocusEvent("msedge.exe", "x", 1));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseEdge));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.WmEdgeToggle));

        router.ProcessEvent(FocusEvent("WindowsTerminal.exe", "ps", 2));   // deferred
        router.ProcessEvent(FocusEvent("ms-teams.exe", "Chat", 3));        // deferred
        router.ProcessEvent(FocusEvent("CodeFlow.exe", "Review", 4));      // deferred
        Assert.Single(kanata.ChangeLayerCalls);

        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseDefault));

        // Only the latest (CodeFlow) is restored, not all three.
        Assert.Equal(
            [LayerCatalog.BaseEdge, LayerCatalog.BaseCodeflow],
            kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_SameAppFocusMoveWhileInWmMode_NoSend()
    {
        // Within-app focus move (Edge window 1 -> Edge window 2). Target matches
        // desired (base-edge), so even without WM-mode deferral there'd be no
        // send. Defending against accidental sends here.
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);
        router.ProcessEvent(FocusEvent("msedge.exe", "x", 1));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseEdge));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.WmEdgeToggle));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.WmFocusToggle));

        router.ProcessEvent(FocusEvent("msedge.exe", "y", 2));

        Assert.Single(kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_BaseEchoMatchingDesired_NoCorrectiveSend()
    {
        // After a normal user-driven base-* echo that already matches desired,
        // the router must NOT send a redundant ChangeLayer (which would loop).
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);
        router.ProcessEvent(FocusEvent("msedge.exe", "x", 1));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseEdge));
        Assert.Single(kanata.ChangeLayerCalls);

        // Another echo of the same base layer (e.g., spurious re-emit).
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseEdge));

        Assert.Single(kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_SubModeEcho_IgnoredAndDoesNotPoisonCache()
    {
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);
        router.ProcessEvent(FocusEvent("msedge.exe", "x", 1));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseEdge));

        // User taps CAP -> enters wm-edge sub-mode. The echo for the sub-mode
        // must not overwrite our remembered base layer.
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.WmEdge));
        // User returns to base-edge via normal exit; should not trigger a
        // corrective send since base-edge already matches desired.
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseEdge));

        // Still on edge: no new send.
        router.ProcessEvent(FocusEvent("msedge.exe", "y", 2));
        Assert.Single(kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_NoEcho_RepeatedFocusResendsUntilConfirmed()
    {
        // Simulates the stuck-cache bug: kanata never confirms the change
        // (TCP write failed). The router should keep sending on subsequent
        // focus events for the same app instead of getting stuck.
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);

        router.ProcessEvent(FocusEvent("msedge.exe", "a", 1));
        router.ProcessEvent(FocusEvent("msedge.exe", "b", 2));
        router.ProcessEvent(FocusEvent("msedge.exe", "c", 3));

        Assert.Equal(
            [LayerCatalog.BaseEdge, LayerCatalog.BaseEdge, LayerCatalog.BaseEdge],
            kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_AlternatingExe_RoutesEach()
    {
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);

        router.ProcessEvent(FocusEvent("msedge.exe", "e", 1));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseEdge));

        router.ProcessEvent(FocusEvent("WindowsTerminal.exe", "t", 2));
        router.ProcessEvent(new KanataLayerChangeEvent(LayerCatalog.BaseTerminal));

        router.ProcessEvent(FocusEvent("msedge.exe", "e2", 3));

        Assert.Equal(
            [LayerCatalog.BaseEdge, LayerCatalog.BaseTerminal, LayerCatalog.BaseEdge],
            kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_UnknownExe_RoutesToBaseDefault()
    {
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);

        router.ProcessEvent(FocusEvent("notepad.exe", "x", 1));

        Assert.Equal([LayerCatalog.BaseDefault], kanata.ChangeLayerCalls);
    }

    [Fact]
    public void ProcessEvent_NonRoutingEvent_DoesNothing()
    {
        var router = CreateRouter(out var kanata, AppLayerRouter.DefaultRules);

        router.ProcessEvent(new KanataMessageEvent("wm.layout.retile"));

        Assert.Empty(kanata.ChangeLayerCalls);
    }

    private static KomorebiWindowEvent FocusEvent(string exe, string title, long hwnd)
    {
        var state = TestJson.State(tiled: [new WindowSpec(hwnd, title, exe)]);
        return new KomorebiWindowEvent("FocusChange", null, state);
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
