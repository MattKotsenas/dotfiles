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
}
