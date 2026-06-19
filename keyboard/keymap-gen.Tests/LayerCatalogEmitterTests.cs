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

        // Sub-modes -- one constant per sub-mode, both one-shot and toggle variants
        Assert.Contains("public const string WmFocus = \"wm-focus\";", output);
        Assert.Contains("public const string WmFocusToggle = \"wm-focus-toggle\";", output);
        Assert.Contains("public const string WmWorkspace = \"wm-workspace\";", output);
    }

    [Fact]
    public void Emits_OverlayConstants_WhenPresent()
    {
        var keymap = new KeymapBuilder()
            .Reserve(global: ["r"], subModeEntries: ["f"])
            .WmBase(b => b.Intent("r", "wm.layout.retile"))
            .SubMode("focus", "f", b => b.Intent("h", "wm.focus.left"))
            .Overlay("terminal", b => b.Macro("h", "C-spc", "h"))
            .Build();

        var output = LayerCatalogEmitter.Emit(keymap);

        Assert.Contains("public const string BaseTerminal = \"base-terminal\";", output);
        Assert.Contains("public const string WmTerminal = \"wm-terminal\";", output);
        Assert.Contains("public const string WmTerminalToggle = \"wm-terminal-toggle\";", output);
    }
}
