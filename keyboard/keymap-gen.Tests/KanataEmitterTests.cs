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
        Assert.Contains("(deflayermap (pointer)", output);
        Assert.Contains("(deflayermap (pointer-terminal)", output);
    }

    [Theory]
    [InlineData("wm", "pointer")]
    [InlineData("wm-toggle", "pointer")]
    [InlineData("wm-terminal", "pointer-terminal")]
    [InlineData("wm-terminal-toggle", "pointer-terminal")]
    public void ProductionKeymap_CapSpaceEntersPersistentPointerLayer(
        string sourceLayer,
        string pointerLayer)
    {
        var output = KanataEmitter.Emit(ProductionKeymap.Build());
        var layer = ExtractLayer(output, sourceLayer);

        Assert.Contains(
            $"spc (layer-switch {pointerLayer})",
            layer);
    }

    [Fact]
    public void ProductionKeymap_EmitsPointerControls()
    {
        var layer = ExtractLayer(
            KanataEmitter.Emit(ProductionKeymap.Build()),
            "pointer");

        Assert.Contains(
            "h (fork (movemouse-accel-left 8 700 1 12) h (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "j (fork (movemouse-accel-down 8 700 1 12) j (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "k (fork (movemouse-accel-up 8 700 1 12) k (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "l (fork (movemouse-accel-right 8 700 1 12) l (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "d (fork (movemouse-speed 40) d (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "s (fork (movemouse-speed 10) s (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            ", (fork (mwheel-up 50 120) , (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "m (fork (mwheel-down 50 120) m (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "u (fork (mwheel-left 50 120) u (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "o (fork (mwheel-right 50 120) o (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "; (fork mltp ; (lsft rsft rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "' (fork mrtp ' (lsft rsft rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "f (fork (fork (layer-switch pointer-hint-ui) (layer-switch pointer-hint-grid) (lsft rsft)) f (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "esc (layer-switch pointer-exit)",
            layer);
        Assert.Contains(
            "caps (layer-switch pointer-exit)",
            layer);
    }

    [Fact]
    public void ProductionKeymap_PointerModePassesShortcutsAndNavigation()
    {
        var layer = ExtractLayer(
            KanataEmitter.Emit(ProductionKeymap.Build()),
            "pointer");

        Assert.Contains("tab tab", layer);
        Assert.Contains("lsft lsft", layer);
        Assert.Contains("rsft rsft", layer);
        Assert.Contains("lctl lctl", layer);
        Assert.Contains("rctl rctl", layer);
        Assert.Contains("lalt lalt", layer);
        Assert.Contains("ralt ralt", layer);
        Assert.Contains("lmet lmet", layer);
        Assert.Contains("rmet rmet", layer);
        Assert.Contains("f1 f1", layer);
        Assert.Contains("f12 f12", layer);
        Assert.Contains(
            "c (fork XX c (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "a (fork XX a (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "w (fork XX w (lctl rctl lalt ralt lmet rmet))",
            layer);
        Assert.Contains(
            "e (fork XX e (lctl rctl lalt ralt lmet rmet))",
            layer);
    }

    [Fact]
    public void ProductionKeymap_TracksModifiersInDefsrc()
    {
        var output = KanataEmitter.Emit(ProductionKeymap.Build());
        var start = output.IndexOf("(defsrc", StringComparison.Ordinal);
        var end = output.IndexOf("(defvirtualkeys", start, StringComparison.Ordinal);
        var defsrc = output[start..end];

        foreach (var modifier in new[]
        {
            "lsft", "rsft", "lctl", "rctl", "lalt", "ralt", "lmet", "rmet",
        })
        {
            Assert.Contains(modifier, defsrc, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void ProductionKeymap_PointerOverlayRestoresEntryContext()
    {
        var layer = ExtractLayer(
            KanataEmitter.Emit(ProductionKeymap.Build()),
            "pointer-terminal");

        Assert.Contains(
            "esc (layer-switch pointer-exit-terminal)",
            layer);
        Assert.Contains(
            "f (fork (fork (layer-switch pointer-hint-ui-terminal) (layer-switch pointer-hint-grid-terminal)",
            layer);
    }

    [Theory]
    [InlineData("wm-focus")]
    [InlineData("wm-focus-toggle")]
    [InlineData("wm-move")]
    [InlineData("wm-move-toggle")]
    [InlineData("wm-stack")]
    [InlineData("wm-stack-toggle")]
    [InlineData("wm-resize")]
    [InlineData("wm-resize-toggle")]
    [InlineData("wm-workspace")]
    [InlineData("wm-workspace-toggle")]
    [InlineData("wm-admin")]
    [InlineData("wm-admin-toggle")]
    public void ProductionKeymap_PointerEntryIsAvailableFromSubModes(
        string layerName)
    {
        var layer = ExtractLayer(
            KanataEmitter.Emit(ProductionKeymap.Build()),
            layerName);

        Assert.Contains(
            "spc (layer-switch pointer)",
            layer);
    }

    [Fact]
    public void ProductionKeymap_BacktickActivatesMousemasterPointerMode()
    {
        var output = KanataEmitter.Emit(ProductionKeymap.Build());

        Assert.Contains("grv (multi (macro f13) (layer-switch base-default))", output);
    }

    [Fact]
    public void ProductionKeymap_EmitsTeamsJoinChordsAsVirtualKeys()
    {
        var keymap = ProductionKeymap.Build();
        var output = KanataEmitter.Emit(keymap);

        // The bridge taps these by name over TCP; renaming one silently breaks
        // the join, so the shipped block and chords are asserted verbatim.
        Assert.Contains("(defvirtualkeys", output);
        Assert.Contains("teams-join-focused (macro (unmod lctl j))", output);
        Assert.Contains("teams-join-toast (macro (unmod lctl lsft j))", output);
        Assert.Contains("pointer-indicator-on (macro f14)", output);
        Assert.Contains("pointer-indicator-off (macro f15)", output);
        Assert.Contains("pointer-hint-ui (macro f16)", output);
        Assert.Contains("pointer-hint-grid (macro f17)", output);
    }

    [Theory]
    // CAP a j in one-shot admin mode, which returns to typing afterwards.
    [InlineData("j (multi (push-msg \"teams.meeting.join\") (layer-switch base-default))")]
    // The same key in the sticky variant, which stays in admin mode.
    [InlineData("j (push-msg \"teams.meeting.join\")")]
    public void ProductionKeymap_BindsTeamsJoinUnderAdmin(string binding)
    {
        var output = KanataEmitter.Emit(ProductionKeymap.Build());

        Assert.Contains(binding, output);
    }

    [Theory]
    [InlineData("h", "sound.play.hiyo")]
    [InlineData("o", "sound.play.horns")]
    public void ProductionKeymap_BindsLocalSoundsUnderAdmin(string key, string intent)
    {
        var output = KanataEmitter.Emit(ProductionKeymap.Build());

        Assert.Contains($"{key} (multi (push-msg \"{intent}\") (layer-switch base-default))", output);
        Assert.Contains($"{key} (push-msg \"{intent}\")", output);
    }

    [Fact]
    public void ProductionKeymap_DoesNotBindBeepToAdminB()
    {
        var output = KanataEmitter.Emit(ProductionKeymap.Build());

        Assert.DoesNotContain("sound.play.beep", output);
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

    private static string ExtractLayer(string config, string layerName)
    {
        var start = config.IndexOf(
            $"(deflayermap ({layerName})",
            StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing layer {layerName}");
        var end = config.IndexOf(
            "(deflayermap (",
            start + 1,
            StringComparison.Ordinal);
        return end < 0 ? config[start..] : config[start..end];
    }
}
