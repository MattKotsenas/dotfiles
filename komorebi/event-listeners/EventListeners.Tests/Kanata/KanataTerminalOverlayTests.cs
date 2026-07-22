using EventListeners.Tests.KanataHarness;

namespace EventListeners.Tests.Kanata;

/// <summary>
/// When the terminal overlay is active (kanata layer = base-terminal), CAP is
/// asymmetric:
/// <list type="bullet">
///   <item><b>Single tap</b> emits the psmux prefix (Ctrl+b). Subsequent
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
        // Tap caps then any key. CAP enters one-shot wm-terminal; the next key
        // fires its psmux prefix macro and then the one-shot returns to typing.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps")
                .Tap("h")
                .Settle());

        // The macro override emits the Ctrl+b prefix chord.
        Assert.Contains(new KeyEvent("↓", "LCtrl"), output.KeyEvents);
        Assert.Contains(new KeyEvent("↓", "B"), output.KeyEvents);
        Assert.Contains(new KeyEvent("↑", "B"), output.KeyEvents);
        Assert.Contains(new KeyEvent("↑", "LCtrl"), output.KeyEvents);
        // 'h' is the literal key, not a macro -- psmux interprets it.
        Assert.Contains(output.KeyEvents, e => e.Direction == "↓" && e.Key.Equals("H", StringComparison.OrdinalIgnoreCase));
        // The prefix is a key macro, not a WM push-msg intent.
        Assert.Empty(output.Intents);
    }

    [Fact]
    public async Task TerminalOverlay_SingleCap_IsOneShot_NotSticky()
    {
        // Single CAP enters one-shot wm-terminal (not sticky). The focus
        // sub-mode fires once and auto-exits, so a second focus action does
        // not fire (it would if we were sticky).
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps")
                .Tap("f").Tap("h")   // focus.left, then exit to typing
                .Tap("f").Tap("l")   // would be focus.right if sticky
                .Settle());

        Assert.Contains("wm.focus.left", output.Intents);
        Assert.DoesNotContain("wm.focus.right", output.Intents);
    }

    [Fact]
    public async Task TerminalOverlay_SingleCap_B_EmitsPrefixThenStandaloneB()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps")
                .Tap("b")
                .Settle());

        AssertPrefixThenStandaloneB(output);
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

        // The macro emits the Ctrl+b prefix followed by the direction tap.
        var keys = output.KeyEvents;
        Assert.Contains(new KeyEvent("↓", "LCtrl"), keys);
        Assert.Contains(new KeyEvent("↓", "B"), keys);
        Assert.Contains(new KeyEvent("↑", "B"), keys);
        Assert.Contains(new KeyEvent("↑", "LCtrl"), keys);
        Assert.Contains(keys, e => e.Direction == "↓" && e.Key.Equals(direction, StringComparison.OrdinalIgnoreCase));
        Assert.Contains(keys, e => e.Direction == "↑" && e.Key.Equals(direction, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task TerminalOverlay_DoubleCap_B_EmitsPrefixThenStandaloneB()
    {
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps").Tap("caps")
                .Tap("b")
                .Settle());

        AssertPrefixThenStandaloneB(output);
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
    public async Task TerminalOverlay_DoubleCap_AdminReacquire_StillFires()
    {
        // reacquire lives in the wm-admin (CAP a) sub-mode. From sticky terminal
        // WM mode, CAP CAP a r should still fire it — proving wm-admin is reachable
        // from the overlay's sticky toggle.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps").Tap("caps")
                .Tap("a").Tap("r")
                .Settle());

        Assert.Contains("wm.window.reacquire", output.Intents);
    }

    [Fact]
    public async Task TerminalOverlay_CapFromSticky_ReturnsToOneShot()
    {
        // From sticky terminal WM, a further CAP returns to ONE-SHOT (not
        // typing). Seeded sticky; CAP then the focus sub-mode fires once and
        // auto-exits, so a second focus action does not fire.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("wm-terminal-toggle")
                .Tap("caps")
                .Tap("f").Tap("h").Tap("f").Tap("l")
                .Settle());

        Assert.Contains("wm.focus.left", output.Intents);
        Assert.DoesNotContain("wm.focus.right", output.Intents);
    }

    [Fact]
    public async Task TerminalOverlay_DoubleCap_ThenEsc_ExitsToBaseTerminal()
    {
        // ESC from any wm-* layer should exit to the appropriate base. For
        // overlay-context sticky (wm-terminal-toggle), that's base-terminal.
        // Verified by checking 'h' subsequently passes through as the psmux
        // C-b h macro (base-terminal's behavior), not as a deadkey.
        var output = await KanataSimulator.RunAsync(
            TestPaths.ProductionConfig,
            new SimInput()
                .Layer("base-terminal")
                .Tap("caps").Tap("caps")  // sticky wm-terminal-toggle
                .Tap("esc")                // exit
                .Tap("caps").Tap("h")      // back in base-terminal, CAP h fires C-b h
                .Settle());

        // Single-tap CAP h in base-terminal fires the psmux prefix macro:
        // Ctrl+b followed by H. If ESC had failed and
        // we were still in wm-terminal-toggle, the second `caps` would have
        // exited (since CAPS is the toggle's exit) and CAP h wouldn't fire
        // the macro the same way.
        var keys = output.KeyEvents;
        Assert.Contains(new KeyEvent("↓", "LCtrl"), keys);
        Assert.Contains(new KeyEvent("↓", "B"), keys);
        Assert.Contains(keys, e => e.Direction == "↓" && e.Key.Equals("H", StringComparison.OrdinalIgnoreCase));
    }

    // ---------------- Single-tap CAP + Shift + symbol = shifted symbol ----------------

    [Fact]
    public async Task TerminalOverlay_SingleCap_ShiftSemicolon_EmitsPsmuxPrefixThenShiftHeldOverSemicolon()
    {
        // The user's psmux command prompt is bound to ':' (Shift+';'). For this
        // to work:
        //   (a) the wm-terminal one-shot must not be consumed by the Shift press,
        //   (b) the Ctrl+b prefix must be emitted WITHOUT Shift held (otherwise
        //       it becomes Ctrl+Shift+b, which psmux does not recognize as the
        //       prefix),
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

        // Psmux prefix fires: Ctrl+b.
        var prefixDownIdx = events.FindIndex(e => e.Direction == "↓" && e.Key == "B");
        var scolonDownIdx = events.FindIndex(e => e.Direction == "↓" && e.Key == "SColon");
        Assert.True(prefixDownIdx >= 0, "Ctrl+b prefix must fire");
        Assert.True(scolonDownIdx > prefixDownIdx, "SColon must follow the prefix");

        // (b) At the moment the prefix key is pressed, LShift must NOT be in 'down'
        // state. Otherwise the chord becomes Ctrl+Shift+b, not the psmux prefix.
        Assert.False(IsKeyDownAt(events, "LShift", prefixDownIdx),
            "LShift must be released when the prefix key is pressed so the chord " +
            "stays Ctrl+b and psmux recognizes it as the prefix.");

        // (c) At the moment SColon is pressed, LShift MUST be down so the OS
        // interprets the keystroke as ':'.
        Assert.True(IsKeyDownAt(events, "LShift", scolonDownIdx),
            "LShift must be held when SColon is pressed so the OS produces ':'.");
    }

    private static void AssertPrefixThenStandaloneB(SimOutput output)
    {
        var prefixAndCommand = output.KeyEvents
            .Where(keyEvent => keyEvent.Key is "LCtrl" or "B")
            .ToList();

        KeyEvent[] expected =
        [
            new KeyEvent("↓", "LCtrl"),
            new KeyEvent("↓", "B"),
            new KeyEvent("↑", "LCtrl"),
            new KeyEvent("↑", "B"),
            new KeyEvent("↓", "B"),
            new KeyEvent("↑", "B"),
        ];

        Assert.Equal(expected, prefixAndCommand);
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
        Assert.DoesNotContain(output.KeyEvents, e => e.Key == "B");
    }
}
