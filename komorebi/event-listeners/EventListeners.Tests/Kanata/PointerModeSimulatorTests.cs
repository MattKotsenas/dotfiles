using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests.Kanata;

[Trait("Category", "KanataHarness")]
public sealed class PointerModeSimulatorTests
{
    [Theory]
    [InlineData("lalt", "tab", "LAlt", "Tab")]
    [InlineData("lctl", "a", "LCtrl", "A")]
    [InlineData("lctl", "w", "LCtrl", "W")]
    [InlineData("lmet", "e", "LGui", "E")]
    [InlineData("lctl", "bspc", "LCtrl", "BSpace")]
    public async Task ModifierShortcut_PassesThrough(
        string modifier,
        string key,
        string expectedModifier,
        string expectedKey)
    {
        var output = await RunAsync(
            new SimInput()
                .Layer("pointer")
                .Down(modifier)
                .Tap(key)
                .Up(modifier)
                .Settle());

        Assert.Equal(
        [
            $"down:{expectedModifier}",
            $"down:{expectedKey}",
            $"up:{expectedKey}",
            $"up:{expectedModifier}",
        ],
            output.KeyOutputs);
    }

    [Theory]
    [InlineData("a")]
    [InlineData("w")]
    [InlineData("c")]
    [InlineData("q")]
    public async Task BareCommandKey_IsSwallowed(string key)
    {
        var output = await RunAsync(
            new SimInput()
                .Layer("pointer")
                .Tap(key)
                .Settle());

        Assert.Empty(output.KeyOutputs);
    }

    [Theory]
    [InlineData("tab", "Tab")]
    [InlineData("ret", "Enter")]
    [InlineData("bspc", "BSpace")]
    [InlineData("left", "Left")]
    [InlineData("f1", "F1")]
    [InlineData("f12", "F12")]
    public async Task NavigationKey_PassesThrough(string key, string expected)
    {
        var output = await RunAsync(
            new SimInput()
                .Layer("pointer")
                .Tap(key)
                .Settle());

        Assert.Equal(
        [
            $"down:{expected}",
            $"up:{expected}",
        ],
            output.KeyOutputs);
    }

    [Fact]
    public async Task PlainHintHandoff_LeavesPointerControls()
    {
        var output = await RunAsync(
            new SimInput()
                .Layer("pointer-terminal")
                .Tap("f")
                .Tap("h")
                .Settle());

        Assert.Empty(output.Intents);
        Assert.Equal(["down:H", "up:H"], output.KeyOutputs);
        Assert.Empty(output.MouseMoves);
    }

    [Fact]
    public async Task ShiftedHintHandoff_LeavesPointerControls()
    {
        var output = await RunAsync(
            new SimInput()
                .Layer("pointer")
                .Down("lsft")
                .Tap("f")
                .Up("lsft")
                .Tap("h")
                .Settle());

        Assert.Empty(output.Intents);
        Assert.Contains("down:H", output.KeyOutputs);
        Assert.Contains("up:H", output.KeyOutputs);
        Assert.Empty(output.MouseMoves);
    }

    [Theory]
    [InlineData("caps")]
    [InlineData("esc")]
    public async Task CapsOrEsc_ExitsPointerMode(string key)
    {
        var output = await RunAsync(
            new SimInput()
                .Layer("pointer-edge")
                .Tap(key)
                .Tap("h")
                .Settle());

        Assert.Empty(output.Intents);
        Assert.Equal(["down:H", "up:H"], output.KeyOutputs);
        Assert.Empty(output.MouseMoves);
    }

    [Theory]
    [InlineData("wm-focus")]
    [InlineData("wm-focus-toggle")]
    [InlineData("wm-admin")]
    [InlineData("wm-admin-toggle")]
    public async Task SubModeSpace_EntersPointer(string layer)
    {
        var output = await RunAsync(
            new SimInput()
                .Layer(layer)
                .Tap("spc")
                .Down("h")
                .Wait(100)
                .Up("h")
                .Settle());

        Assert.Empty(output.Intents);
        Assert.NotEmpty(output.MouseMoves);
        Assert.Empty(output.KeyOutputs);
    }

    private static Task<SimOutput> RunAsync(SimInput input) =>
        KanataSimulator.RunAsync(TestPaths.ProductionConfig, input);
}
