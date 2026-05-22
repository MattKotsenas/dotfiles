using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests.Kanata;

/// <summary>
/// Behavior tests for inner navigation (nav.* intents).
/// These verify the kanata side: bare HJKL in WM mode emits nav.* intents.
/// The context-sensitive dispatch (terminal vs other apps) is tested in
/// IntentDispatchRuleTests against the C# rule directly.
/// </summary>
[Trait("Category", "KanataHarness")]
public class KanataInnerNavTests
{
    [Theory]
    [InlineData("h", "nav.left")]
    [InlineData("j", "nav.down")]
    [InlineData("k", "nav.up")]
    [InlineData("l", "nav.right")]
    public async Task OneShot_BareDirection_FiresNavIntent(string key, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap(key).Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    [Theory]
    [InlineData("h", "nav.left")]
    [InlineData("l", "nav.right")]
    public async Task ToggleMode_BareDirection_FiresNavIntent(string key, string expectedIntent)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Tap("caps").Tap("caps")  // enter toggle mode
                .Tap(key)                  // bare direction → nav.*
                .Tap("caps")               // exit
                .Settle());

        Assert.Contains(expectedIntent, output.Intents);
    }

    [Fact]
    public async Task OneShot_FocusSubMod_StillFiresWmIntent_NotNav()
    {
        // F+L should still emit wm.focus.right, not nav.right
        // (sub-modifier paths are unchanged by the inner-nav addition)
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("f").Tap("l").Settle());

        Assert.Contains("wm.focus.right", output.Intents);
        Assert.DoesNotContain("nav.right", output.Intents);
    }

    [Fact]
    public async Task ToggleMode_FocusSubLayer_StillFiresWmFocusIntent()
    {
        // In toggle mode: caps,caps,f → wm-focus-toggle layer
        //                 then h → wm.focus.left (the sub-layer overrides bare h)
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Tap("caps").Tap("caps")
                .Tap("f")  // enter focus sub-layer
                .Tap("h")  // should be wm.focus.left, not nav.left
                .Tap("caps").Settle());

        Assert.Contains("wm.focus.left", output.Intents);
        Assert.DoesNotContain("nav.left", output.Intents);
    }
}
