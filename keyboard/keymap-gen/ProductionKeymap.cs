namespace KeymapGen;

/// <summary>
/// The current production keymap, expressed in the DSL.
///
/// Phase 1 goal: this builds the same behavior as the hand-written kanata.kbd
/// that lived in this repo before the compiler. The harness tests are the
/// equivalence proof.
/// </summary>
internal static class ProductionKeymap
{
    public static Keymap Build() => new KeymapBuilder()
        .Caps(tapDanceMs: 250, oneShotMs: 2000)
        .Reserve(
            global: ["r", "p", "tab", "/", "q"],
            subModeEntries: ["a", "s", "d", "f", "e", "w"])
        .WmBase(b => b
            .Intent("r", "wm.layout.retile")
            .Intent("p", "wm.layout.toggle-pause")
            .Intent("tab", "wm.focus.last-workspace")
            .Intent("/", "system.cheatsheet")
            .Intent("q", "wm.move.promote")
            // Arrow passthrough: arrows always do "their thing" even in WM mode
            // (Teams meeting nav, list nav, etc.). KanataLiteral emits the key
            // as itself; the compiler propagates wm-base into every wm-* layer,
            // so this works inside overlays + toggle modes too. One-shot sub-modes
            // intentionally don't merge wm-base, so arrows deadkey there.
            .KanataLiteral("up", "up")
            .KanataLiteral("down", "down")
            .KanataLiteral("left", "left")
            .KanataLiteral("right", "right"))
        .SubMode("workspace", "w", b => b
            .Workspaces("wm.workspace.focus.{0}", 0, 7))
        .SubMode("focus", "f", b => b
            .Intent("h", "wm.focus.left")
            .Intent("j", "wm.focus.down")
            .Intent("k", "wm.focus.up")
            .Intent("l", "wm.focus.right")
            // moved here from wm-base: cycle-focus is a focus op
            .Intent("g", "wm.focus.cycle-next")
            // moved here in Phase 2: float/monocle/flip live under focus
            .Intent("t", "wm.layout.toggle-float")
            .Intent("m", "wm.layout.toggle-monocle")
            .Intent("x", "wm.layout.flip-horizontal")
            .Intent("y", "wm.layout.flip-vertical"))
        .SubMode("move", "d", b => b
            .Intent("h", "wm.move.left")
            .Intent("j", "wm.move.down")
            .Intent("k", "wm.move.up")
            .Intent("l", "wm.move.right")
            .Workspaces("wm.workspace.move-to.{0}", 0, 7))
        .SubMode("stack", "s", b => b
            .Intent("h", "wm.stack.left")
            .Intent("j", "wm.stack.down")
            .Intent("k", "wm.stack.up")
            .Intent("l", "wm.stack.right"))
        .SubMode("resize", "e", b => b
            .Intent("h", "wm.resize.horizontal-decrease")
            .Intent("j", "wm.resize.vertical-decrease")
            .Intent("k", "wm.resize.vertical-increase")
            .Intent("l", "wm.resize.horizontal-increase"))
        .SubMode("assemble", "a", b => b
            .Macro("h", m => m
                .Intent("wm.stack.unstack")
                .Delay(100)
                .Intent("wm.focus.cycle-next"))
            .Intent("j", "wm.stack.cycle-prev")
            .Intent("k", "wm.stack.cycle-next")
            .Macro("l", m => m
                .Intent("wm.stack.unstack")
                .Delay(100)
                .Intent("wm.focus.cycle-next")))
        // -------------------------------------------------------------------
        // App overlays. Routing rules live in event-listeners/AppLayerRouter.cs
        // -------------------------------------------------------------------
        .Overlay("terminal", b => b
            // psmux command access: every non-WM key here sends Ctrl+Space (the
            // psmux prefix) then the key, so psmux config is the single source
            // of truth for what each key does (pane nav h/j/k/l, new window c,
            // command prompt ;, search /, kill x, etc.). wm-base reserved keys
            // (a/s/d/f/e/w sub-modes; r/p/tab/q/// globals; arrows) still do
            // their WM thing. Active via single-tap (one-shot wm-terminal) or
            // double-tap (sticky wm-terminal-toggle) CAP in Windows Terminal.
            .Describe("Every key here forwards `Ctrl+Space` (psmux prefix) then the key to the focused terminal. " +
                      "See `psmux/.psmux.conf` for what each key does in psmux (or hit `CAP ?` inside psmux to list binds).")
            .PrefixAll("C-spc"))
        .Overlay("edge", b => b
            .Describe("Browser shortcuts forwarded through the WM layer. wm-base reserved keys still do their WM thing.")
            .Macro("t", "C-t").Describe("new tab")
            .Macro("v", "C-l", "esc", "esc").Describe("vimium reset (focus URL bar, then drop focus)"))
        .Overlay("teams", b => b
            .Describe("Microsoft Teams shortcuts. In-meeting actions are no-ops outside a meeting.")
            // In-meeting actions
            .Macro("m", "C-S-m").Describe("toggle mute")
            .Macro("c", "C-S-o").Describe("toggle camera")
            .Macro("u", "C-S-k").Describe("raise/lower hand")
            // Navigation
            .Macro("g", "C-e").Describe("search")
            .Macro("h", "A-left").Describe("back")
            .Macro("l", "A-right").Describe("forward")
            .Macro("j", "A-pgdn").Describe("section down")
            .Macro("k", "A-pgup").Describe("section up")
            // Tab jump (Ctrl+1..Ctrl+8 to switch sidebar items)
            .Macro("1", "C-1").Describe("sidebar tab 1")
            .Macro("2", "C-2").Describe("sidebar tab 2")
            .Macro("3", "C-3").Describe("sidebar tab 3")
            .Macro("4", "C-4").Describe("sidebar tab 4")
            .Macro("5", "C-5").Describe("sidebar tab 5")
            .Macro("6", "C-6").Describe("sidebar tab 6")
            .Macro("7", "C-7").Describe("sidebar tab 7")
            .Macro("8", "C-8").Describe("sidebar tab 8")
            // Notification actions
            .Macro("y", "C-S-a").Describe("accept incoming call")
            .Macro("n", "C-S-j").Describe("join meeting from notification"))
        .Build();
}
