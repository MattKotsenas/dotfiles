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
        // Chord steps render as (unmod ...) so that any modifier the user is
        // physically holding (e.g. Shift while typing ':') is released for the
        // chord and restored afterward. See ActionFormatter.FormatChord.
        Assert.Equal("(macro (unmod lctl spc) h)", ActionFormatter.Format(macro));
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
            .Reserve()
            .WmBase(b => b.Intent("r", "wm.layout.retile"))
            .Overlay("term", b => b.PrefixAll("C-spc", "h", "j", "c"))
            .Build();

        var output = KanataEmitter.Emit(keymap);

        // Every key in the explicit list became a (macro (unmod lctl spc) <key>) binding
        // inside both wm-term and wm-term-toggle. The chord is rendered via unmod so
        // physical modifiers (e.g. Shift) don't leak into the prefix.
        Assert.Contains("(deflayermap (wm-term)", output);
        Assert.Contains("h (macro (unmod lctl spc) h)", output);
        Assert.Contains("j (macro (unmod lctl spc) j)", output);
        Assert.Contains("c (macro (unmod lctl spc) c)", output);
    }

    [Fact]
    public void PrefixAll_CommandMatchingPrefixKey_EmitsUnmodKeyStep()
    {
        var keymap = new KeymapBuilder()
            .Reserve()
            .WmBase(b => b.Intent("r", "wm.layout.retile"))
            .Overlay("term", b => b.PrefixAll("C-b", "b", "n"))
            .Build();

        var output = KanataEmitter.Emit(keymap);

        Assert.Contains("b (macro (unmod lctl b) (unmod b))", output);
        Assert.Contains("n (macro (unmod lctl b) n)", output);
    }

    [Fact]
    public void PrefixAll_DefaultKeys_ExcludesReservedAndArrows()
    {
        var keymap = new KeymapBuilder()
            // Production reservation post-reorg: only tab/ as globals; a/s/d/f/e/w
            // as sub-mode entries (a is wm-admin, which owns r/p/x/y/l).
            .Reserve(global: ["tab", "/"], subModeEntries: ["a", "s", "d", "f", "e", "w"])
            .WmBase(b => b.Intent("/", "system.cheatsheet"))
            .SubMode("focus", "f", b => b.Intent("h", "wm.focus.left"))
            .SubMode("workspace", "w", b => b.Intent("h", "wm.focus.left"))
            .SubMode("move", "d", b => b.Intent("h", "wm.focus.left"))
            .SubMode("stack", "s", b => b.Intent("h", "wm.focus.left"))
            .SubMode("resize", "e", b => b.Intent("h", "wm.focus.left"))
            .SubMode("admin", "a", b => b.Intent("r", "wm.layout.retile"))
            .Overlay("term", b => b.PrefixAll("C-spc"))
            .Build();

        // No InvalidKeymapException = default set never collides with reserved keys.
        var output = KanataEmitter.Emit(keymap);

        // Letters that ARE in the default set
        Assert.Contains("c (macro (unmod lctl spc) c)", output);
        Assert.Contains("h (macro (unmod lctl spc) h)", output);
        // r and p are in the default prefixed set, so they expand to
        // prefix + r / + p macros.
        Assert.Contains("r (macro (unmod lctl spc) r)", output);
        Assert.Contains("p (macro (unmod lctl spc) p)", output);
        // Reserved sub-mode entry letters are still NOT in the prefixed set
        Assert.DoesNotContain("a (macro (unmod lctl spc) a)", output);
        Assert.DoesNotContain("w (macro (unmod lctl spc) w)", output);
    }

    [Fact]
    public void PrefixAll_Digits_EmittedAsUnmodKeyMacroStep()
    {
        var keymap = new KeymapBuilder()
            .Reserve()
            .WmBase(b => b.Intent("r", "wm.layout.retile"))
            .Overlay("term", b => b.PrefixAll("C-spc", "1", "2", "0"))
            .Build();

        var output = KanataEmitter.Emit(keymap);

        // A bare integer step would be parsed by kanata as a ms delay, so digits are
        // wrapped in (unmod N), which forces a real key event.
        Assert.Contains("1 (macro (unmod lctl spc) (unmod 1))", output);
        Assert.Contains("2 (macro (unmod lctl spc) (unmod 2))", output);
        Assert.Contains("0 (macro (unmod lctl spc) (unmod 0))", output);
        // Never a bare digit, which kanata would read as a delay.
        Assert.DoesNotContain("1 (macro (unmod lctl spc) 1)", output);
    }

    [Fact]
    public void PrefixAll_DefaultKeys_IncludeSymbolsAndDigits()
    {
        var keymap = new KeymapBuilder()
            .Reserve()
            .WmBase(b => b.Intent("r", "wm.layout.retile"))
            .Overlay("term", b => b.PrefixAll("C-spc"))
            .Build();

        var output = KanataEmitter.Emit(keymap);

        // Symbol bindings emit as bare keys.
        Assert.Contains(", (macro (unmod lctl spc) ,)", output);
        Assert.Contains(". (macro (unmod lctl spc) .)", output);
        Assert.Contains("\\ (macro (unmod lctl spc) \\)", output);
        Assert.Contains("- (macro (unmod lctl spc) -)", output);
        Assert.Contains("[ (macro (unmod lctl spc) [)", output);
        Assert.Contains("] (macro (unmod lctl spc) ])", output);
        Assert.Contains("; (macro (unmod lctl spc) ;)", output);
        // Digits emit as (unmod N) real key events.
        Assert.Contains("1 (macro (unmod lctl spc) (unmod 1))", output);
        Assert.Contains("9 (macro (unmod lctl spc) (unmod 9))", output);
        // wm-base global "/" is reserved -- never bound by overlay.
        Assert.DoesNotContain("/ (macro (unmod lctl spc) /)", output);
    }

    [Fact]
    public void MacroUnmodKey_FormatsAsUnmod()
    {
        Assert.Equal("(macro (unmod 8))",
            ActionFormatter.Format(new MacroAction([new MacroUnmodKey("8")])));
    }
}
