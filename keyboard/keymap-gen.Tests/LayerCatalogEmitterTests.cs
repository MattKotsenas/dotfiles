using KeymapGen;

namespace KeymapGen.Tests;

public class LayerCatalogEmitterTests
{
    [Fact]
    public void Emits_AllExpectedConstants_ForProductionKeymap()
    {
        var keymap = ProductionKeymap.Build();
        var output = LayerCatalogEmitter.Emit(keymap);

        Assert.Contains("namespace EventListeners.Generated;", output);
        Assert.Contains("public static class LayerCatalog", output);

        // Default context base layer always present
        Assert.Contains("public const string BaseDefault = \"base-default\";", output);

        // WM-mode shells
        Assert.Contains("public const string Wm = \"wm\";", output);
        Assert.Contains("public const string WmToggle = \"wm-toggle\";", output);
        Assert.Contains("public const string Pointer = \"pointer\";", output);
        Assert.Contains("public const string PointerExit = \"pointer-exit\";", output);
        Assert.Contains("public const string PointerHintUi = \"pointer-hint-ui\";", output);
        Assert.Contains("public const string PointerHintGrid = \"pointer-hint-grid\";", output);

        // Sub-modes -- one constant per sub-mode, both one-shot and toggle variants
        Assert.Contains("public const string WmFocus = \"wm-focus\";", output);
        Assert.Contains("public const string WmFocusToggle = \"wm-focus-toggle\";", output);
        Assert.Contains("public const string WmWorkspace = \"wm-workspace\";", output);

        // Virtual keys the bridge taps by name
        Assert.Contains(
            "public const string VirtualKeyTeamsJoinFocused = \"teams-join-focused\";", output);
        Assert.Contains(
            "public const string VirtualKeyTeamsJoinToast = \"teams-join-toast\";", output);
        Assert.Contains(
            "public const string VirtualKeyPointerHintUi = \"pointer-hint-ui\";",
            output);
    }

    [Fact]
    public void Emits_OverlayConstants_WhenPresent()
    {
        var keymap = new KeymapBuilder()
            .VirtualKey("pointer-indicator-on", "f14")
            .VirtualKey("pointer-indicator-off", "f15")
            .VirtualKey("pointer-hint-ui", "f16")
            .VirtualKey("pointer-hint-grid", "f17")
            .Reserve(global: ["r", "spc"], subModeEntries: ["f"])
            .WmBase(b => b.Intent("r", "wm.layout.retile"))
            .PointerMode(
                "spc",
                "g",
                pointer => pointer.KanataLiteral("h", "(movemouse-left 8 1)"))
            .SubMode("focus", "f", b => b.Intent("h", "wm.focus.left"))
            .Overlay("terminal", b => b.Macro("h", "C-spc", "h"))
            .Build();

        var output = LayerCatalogEmitter.Emit(keymap);

        Assert.Contains("public const string BaseTerminal = \"base-terminal\";", output);
        Assert.Contains("public const string WmTerminal = \"wm-terminal\";", output);
        Assert.Contains("public const string WmTerminalToggle = \"wm-terminal-toggle\";", output);
        Assert.Contains("public const string PointerTerminal = \"pointer-terminal\";", output);
        Assert.Contains(
            "public const string PointerTerminalExit = \"pointer-exit-terminal\";",
            output);
        Assert.Contains(
            "public const string PointerTerminalHintUi = \"pointer-hint-ui-terminal\";",
            output);
        Assert.Contains(
            "public const string PointerTerminalHintGrid = \"pointer-hint-grid-terminal\";",
            output);
        Assert.Contains("BaseTerminal => PointerTerminal", output);
        Assert.Contains("PointerTerminal => true", output);
        Assert.Contains("PointerTerminalExit => true", output);
        Assert.Contains("PointerTerminalHintUi => true", output);
        Assert.Contains("PointerTerminalHintGrid => true", output);
    }
}
