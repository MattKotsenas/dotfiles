using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests.Kanata;

/// <summary>
/// When the terminal overlay is active (kanata layer = base-terminal), CAP is
/// asymmetric:
/// <list type="bullet">
///   <item><b>Single tap</b> emits the psmux prefix (Ctrl+Space). Subsequent
///     keys go to psmux. base-terminal does not enter WM mode.</item>
///   <item><b>Double tap</b> enters the sticky WM layer (wm-terminal-toggle)
///     where HJKL emit prefix+direction macros and WM ops fire normally.</item>
/// </list>
/// This file documents both branches.
/// </summary>
[Trait("Category", "KanataHarness")]
public class KanataTerminalOverlayTests
{
    // ---------------- Single-tap CAP = psmux prefix ----------------

    [Fact]
    public async Task TerminalOverlay_SingleCap_EmitsPsmuxPrefix()
    {
        // Tap caps then any key. Tap-dance fires the single-tap arm immediately
        // when another key is pressed, so the prefix lands before the next key.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps")
                .Tap("h")
                .Settle());

        // The (macro C-spc) override produces LCtrl down, Space down, Space up, LCtrl up.
        Assert.Contains(new KeyEvent("↓", "LCtrl"), output.KeyEvents);
        Assert.Contains(new KeyEvent("↓", "Space"), output.KeyEvents);
        Assert.Contains(new KeyEvent("↑", "Space"), output.KeyEvents);
        Assert.Contains(new KeyEvent("↑", "LCtrl"), output.KeyEvents);
        // 'h' is the literal key, not a macro -- psmux interprets it.
        Assert.Contains(output.KeyEvents, e => e.Direction == "↓" && e.Key.Equals("H", StringComparison.OrdinalIgnoreCase));
        // No WM intent fired (single tap does NOT enter WM mode in terminal).
        Assert.Empty(output.Intents);
    }

    [Fact]
    public async Task TerminalOverlay_SingleCap_StaysInBaseTerminal()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps")
                .Settle());

        // After the tap-dance times out, we should still be in base-terminal.
        Assert.Equal("base-terminal", output.FinalLayer);
    }

    // ---------------- Double-tap CAP = sticky WM (wm-terminal-toggle) ----------------

    [Theory]
    [InlineData("h")]
    [InlineData("j")]
    [InlineData("k")]
    [InlineData("l")]
    public async Task TerminalOverlay_DoubleCap_HJKL_EmitsPsmuxPrefixSequence(string direction)
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps").Tap("caps")        // enter wm-terminal-toggle (sticky)
                .Tap(direction)
                .Settle());

        // Macro emits LCtrl down, Space down, Space up, LCtrl up, <dir> down, <dir> up
        var keys = output.KeyEvents;
        Assert.Contains(new KeyEvent("↓", "LCtrl"), keys);
        Assert.Contains(new KeyEvent("↓", "Space"), keys);
        Assert.Contains(new KeyEvent("↑", "Space"), keys);
        Assert.Contains(new KeyEvent("↑", "LCtrl"), keys);
        Assert.Contains(keys, e => e.Direction == "↓" && e.Key.Equals(direction, StringComparison.OrdinalIgnoreCase));
        Assert.Contains(keys, e => e.Direction == "↑" && e.Key.Equals(direction, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task TerminalOverlay_DoubleCap_SubModeStillWorks_FH_FiresFocusLeft()
    {
        // From sticky terminal mode, the focus sub-mode is still reachable.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps").Tap("caps")
                .Tap("f").Tap("h")
                .Settle());

        Assert.Contains("wm.focus.left", output.Intents);
    }

    [Fact]
    public async Task TerminalOverlay_DoubleCap_AdminRetile_StillFires()
    {
        // After Phase 3 reorg, retile lives in the wm-admin (CAP a) sub-mode.
        // From sticky terminal WM mode, CAP CAP a r should still fire retile —
        // proving wm-admin is reachable from the overlay's sticky toggle.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps").Tap("caps")
                .Tap("a").Tap("r")
                .Settle());

        Assert.Contains("wm.layout.retile", output.Intents);
    }

    [Fact]
    public async Task TerminalOverlay_DoubleCap_ThenCaps_ExitsToBaseTerminal()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps").Tap("caps")        // enter sticky
                .Tap("caps")                     // exit sticky
                .Settle());

        Assert.Equal("base-terminal", output.FinalLayer);
    }

    [Fact]
    public async Task TerminalOverlay_DoubleCap_ThenEsc_ExitsToBaseTerminal()
    {
        // ESC from any wm-* layer should exit to the appropriate base. For
        // overlay-context sticky (wm-terminal-toggle), that's base-terminal.
        // Verified by checking 'h' subsequently passes through as the psmux
        // C-spc h macro (base-terminal's behavior), not as a deadkey.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps").Tap("caps")  // sticky wm-terminal-toggle
                .Tap("esc")                // exit
                .Tap("caps").Tap("h")      // back in base-terminal, CAP h fires C-spc h
                .Settle());

        // Single-tap CAP h in base-terminal fires the psmux prefix macro:
        // Ctrl down, Space down, Space up, Ctrl up, H. If ESC had failed and
        // we were still in wm-terminal-toggle, the second `caps` would have
        // exited (since CAPS is the toggle's exit) and CAP h wouldn't fire
        // the macro the same way.
        var keys = output.KeyEvents;
        Assert.Contains(new KeyEvent("↓", "LCtrl"), keys);
        Assert.Contains(new KeyEvent("↓", "Space"), keys);
        Assert.Contains(keys, e => e.Direction == "↓" && e.Key.Equals("H", StringComparison.OrdinalIgnoreCase));
    }

    // ---------------- Single-tap CAP + Shift + symbol = shifted symbol ----------------

    [Fact]
    public async Task TerminalOverlay_SingleCap_ShiftSemicolon_EmitsPsmuxPrefixThenShiftHeldOverSemicolon()
    {
        // The user's psmux command prompt is bound to ':' (Shift+';'). For this
        // to work:
        //   (a) the wm-terminal one-shot must not be consumed by the Shift press,
        //   (b) the Ctrl+Space prefix must be emitted WITHOUT Shift held (otherwise
        //       Windows Terminal interprets Ctrl+Shift+Space as the command palette
        //       shortcut and steals the keystroke before psmux sees it),
        //   (c) Shift must be held when SColon fires so the OS interprets it as ':'.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps")
                .Down("lsft")
                .Tap(";")
                .Up("lsft")
                .Settle());

        var events = output.KeyEvents.ToList();

        // Psmux prefix fires: Ctrl+Space.
        var spaceDownIdx = events.FindIndex(e => e.Direction == "↓" && e.Key == "Space");
        var scolonDownIdx = events.FindIndex(e => e.Direction == "↓" && e.Key == "SColon");
        Assert.True(spaceDownIdx >= 0, "Ctrl+Space prefix must fire");
        Assert.True(scolonDownIdx > spaceDownIdx, "SColon must follow the prefix");

        // (b) At the moment Space is pressed, LShift must NOT be in 'down' state.
        // Otherwise Windows sees Ctrl+Shift+Space and the command palette opens.
        Assert.False(IsKeyDownAt(events, "LShift", spaceDownIdx),
            "LShift must be released when Space is pressed so Windows Terminal " +
            "doesn't interpret it as Ctrl+Shift+Space (command palette).");

        // (c) At the moment SColon is pressed, LShift MUST be down so the OS
        // interprets the keystroke as ':'.
        Assert.True(IsKeyDownAt(events, "LShift", scolonDownIdx),
            "LShift must be held when SColon is pressed so the OS produces ':'.");
    }

    /// <summary>
    /// Returns true if <paramref name="key"/> is in the 'down' state at the
    /// event index <paramref name="atIdx"/> (i.e., the most recent prior event
    /// for that key was ↓, or there is a ↓ at that exact index).
    /// </summary>
    private static bool IsKeyDownAt(IReadOnlyList<KeyEvent> events, string key, int atIdx)
    {
        var down = false;
        for (var i = 0; i <= atIdx; i++)
        {
            if (events[i].Key != key) continue;
            down = events[i].Direction == "↓";
        }
        return down;
    }

    // ---------------- Default context behavior unchanged ----------------

    [Fact]
    public async Task DefaultContext_BareH_DoesNotEmitPsmuxSequence()
    {
        // In base-default (no terminal overlay), CAP+H is a deadkey -- no intent,
        // no key events. The override only affects base-terminal.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput().Tap("caps").Tap("h").Settle());

        Assert.Empty(output.Intents);
        Assert.DoesNotContain(output.KeyEvents, e => e.Key == "Space");
    }
}
