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
            .Intent("q", "wm.move.promote"))
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
            // psmux pane navigation: Ctrl+Space prefix + direction
            .Macro("h", "C-spc", "h")
            .Macro("j", "C-spc", "j")
            .Macro("k", "C-spc", "k")
            .Macro("l", "C-spc", "l"))
        .Overlay("edge", b => b
            .Macro("t", "C-t")              // new tab
            .Macro("v", "C-l", "esc", "esc")) // vimium reset (focus URL bar, then drop focus)
        .Overlay("teams", b => b
            // In-meeting actions (no-ops outside a meeting; that's intentional)
            .Macro("m", "C-S-m")             // toggle mute
            .Macro("c", "C-S-o")             // toggle camera
            .Macro("u", "C-S-k")             // raise/lower hand
            // Navigation
            .Macro("g", "C-e")               // search
            .Macro("h", "A-left")            // back
            .Macro("l", "A-right")           // forward
            .Macro("j", "A-pgdn")            // section down
            .Macro("k", "A-pgup")            // section up
            // Tab jump (Ctrl+1..Ctrl+8 to switch sidebar items)
            .Macro("1", "C-1").Macro("2", "C-2").Macro("3", "C-3").Macro("4", "C-4")
            .Macro("5", "C-5").Macro("6", "C-6").Macro("7", "C-7").Macro("8", "C-8")
            // Notification actions
            .Macro("y", "C-S-a")             // accept incoming call
            .Macro("n", "C-S-j"))            // join meeting from notification
        .Build();
}
