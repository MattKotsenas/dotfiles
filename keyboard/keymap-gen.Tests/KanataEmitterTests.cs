using KeymapGen;

namespace KeymapGen.Tests;

public class KanataEmitterTests
{
    [Fact]
    public void ProductionKeymap_EmitsValidKanata()
    {
        var keymap = ProductionKeymap.Build();
        var output = KanataEmitter.Emit(keymap);

        // Basic structural checks. The full equivalence proof lives in the
        // EventListeners.Tests harness (Category=KanataHarness).
        Assert.Contains("(defcfg", output);
        Assert.Contains("process-unmapped-keys yes", output);
        Assert.Contains("(deflayermap (base-default)", output);
        Assert.Contains("(deflayermap (wm)", output);
        Assert.Contains("(deflayermap (wm-toggle)", output);
        Assert.Contains("(deflayermap (wm-focus)", output);
        Assert.Contains("(deflayermap (wm-focus-toggle)", output);
        Assert.Contains("(deflayermap (wm-workspace)", output);
    }

    [Fact]
    public void IntentAction_FormatsAsPushMsg()
    {
        Assert.Equal("(push-msg \"wm.focus.left\")",
            ActionFormatter.Format(new IntentAction("wm.focus.left")));
    }

    [Fact]
    public void SimpleMacro_FormatsAsKeysAndChords()
    {
        var macro = new MacroAction([new MacroChord("C-spc"), new MacroKey("h")]);
        Assert.Equal("(macro C-spc h)", ActionFormatter.Format(macro));
    }

    [Fact]
    public void MacroWithIntentAndDelay_FormatsCorrectly()
    {
        var macro = new MacroAction([
            new MacroIntent("wm.stack.unstack"),
            new MacroDelay(100),
            new MacroIntent("wm.focus.cycle-next"),
        ]);
        Assert.Equal(
            "(macro (push-msg \"wm.stack.unstack\") 100 (push-msg \"wm.focus.cycle-next\"))",
            ActionFormatter.Format(macro));
    }

    [Fact]
    public void KanataLiteral_FormatsRaw()
    {
        Assert.Equal("(fork foo bar (lalt))",
            ActionFormatter.Format(new KanataLiteral("(fork foo bar (lalt))")));
    }

    [Fact]
    public void PrefixAll_ExpandsToMacroPerKey()
    {
        var keymap = new KeymapBuilder()
            .Caps()
            .Reserve()
            .WmBase(b => b.Intent("r", "wm.layout.retile"))
            .Overlay("term", b => b.PrefixAll("C-spc", "h", "j", "c"))
            .Build();

        var output = KanataEmitter.Emit(keymap);

        // Every key in the explicit list became a (macro C-spc <key>) binding
        // inside both wm-term and wm-term-toggle.
        Assert.Contains("(deflayermap (wm-term)", output);
        Assert.Contains("h (macro C-spc h)", output);
        Assert.Contains("j (macro C-spc j)", output);
        Assert.Contains("c (macro C-spc c)", output);
    }

    [Fact]
    public void PrefixAll_DefaultKeys_ExcludesReservedAndArrows()
    {
        var keymap = new KeymapBuilder()
            .Caps()
            .Reserve(global: ["r", "p", "q"], subModeEntries: ["a", "s", "d", "f", "e", "w"])
            .WmBase(b => b.Intent("r", "wm.layout.retile"))
            .SubMode("focus", "f", b => b.Intent("h", "wm.focus.left"))
            .SubMode("workspace", "w", b => b.Intent("h", "wm.focus.left"))
            .SubMode("move", "d", b => b.Intent("h", "wm.focus.left"))
            .SubMode("stack", "s", b => b.Intent("h", "wm.focus.left"))
            .SubMode("resize", "e", b => b.Intent("h", "wm.focus.left"))
            .SubMode("assemble", "a", b => b.Intent("h", "wm.focus.left"))
            .Overlay("term", b => b.PrefixAll("C-spc"))
            .Build();

        // No InvalidKeymapException = default set never collides with reserved keys.
        var output = KanataEmitter.Emit(keymap);

        // Letters that ARE in the default set
        Assert.Contains("c (macro C-spc c)", output);
        Assert.Contains("h (macro C-spc h)", output);
        // Reserved letters are NOT in the prefixed set
        Assert.DoesNotContain("a (macro C-spc a)", output);
        Assert.DoesNotContain("w (macro C-spc w)", output);
        Assert.DoesNotContain("r (macro C-spc r)", output);
    }

    [Fact]
    public void PrefixAll_Digits_EmittedAsUnicodeMacroStep()
    {
        var keymap = new KeymapBuilder()
            .Caps()
            .Reserve()
            .WmBase(b => b.Intent("r", "wm.layout.retile"))
            .Overlay("term", b => b.PrefixAll("C-spc", "1", "2", "0"))
            .Build();

        var output = KanataEmitter.Emit(keymap);

        // Bare integer would be parsed by kanata as a ms delay (0 is invalid).
        // PrefixAll must route digits through (unicode "N") instead.
        Assert.Contains("1 (macro C-spc (unicode \"1\"))", output);
        Assert.Contains("2 (macro C-spc (unicode \"2\"))", output);
        Assert.Contains("0 (macro C-spc (unicode \"0\"))", output);
        Assert.DoesNotContain("1 (macro C-spc 1)", output);
    }

    [Fact]
    public void PrefixAll_DefaultKeys_IncludeSymbolsAndDigits()
    {
        var keymap = new KeymapBuilder()
            .Caps()
            .Reserve()
            .WmBase(b => b.Intent("r", "wm.layout.retile"))
            .Overlay("term", b => b.PrefixAll("C-spc"))
            .Build();

        var output = KanataEmitter.Emit(keymap);

        // Symbol bindings emit as bare keys.
        Assert.Contains(", (macro C-spc ,)", output);
        Assert.Contains(". (macro C-spc .)", output);
        Assert.Contains("\\ (macro C-spc \\)", output);
        Assert.Contains("- (macro C-spc -)", output);
        Assert.Contains("[ (macro C-spc [)", output);
        Assert.Contains("] (macro C-spc ])", output);
        Assert.Contains("; (macro C-spc ;)", output);
        // Digits emit via unicode.
        Assert.Contains("1 (macro C-spc (unicode \"1\"))", output);
        Assert.Contains("9 (macro C-spc (unicode \"9\"))", output);
        // wm-base global "/" is reserved -- never bound by overlay.
        Assert.DoesNotContain("/ (macro C-spc /)", output);
    }

    [Fact]
    public void MacroUnicode_RejectsUnsafeContent()
    {
        Assert.Throws<ArgumentException>(() =>
            ActionFormatter.Format(new MacroAction([new MacroUnicode("\"")])));
        Assert.Throws<ArgumentException>(() =>
            ActionFormatter.Format(new MacroAction([new MacroUnicode("\\")])));
        Assert.Throws<ArgumentException>(() =>
            ActionFormatter.Format(new MacroAction([new MacroUnicode("ab")])));
    }
}
