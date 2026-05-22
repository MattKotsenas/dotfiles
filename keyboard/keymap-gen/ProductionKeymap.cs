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
            global: ["r", "p", "tab", "/", "q", "g"],
            subModeEntries: ["a", "s", "d", "f", "e", "w"])
        .WmBase(b => b
            .Intent("r", "wm.layout.retile")
            .Intent("p", "wm.layout.toggle-pause")
            .Intent("tab", "wm.focus.last-workspace")
            .Intent("/", "system.cheatsheet")
            .Intent("q", "wm.move.promote")
            .Intent("g", "wm.focus.cycle-next"))
        .SubMode("workspace", "w", b => b
            .Workspaces("wm.workspace.focus.{0}", 0, 7))
        .SubMode("focus", "f", b => b
            .Intent("h", "wm.focus.left")
            .Intent("j", "wm.focus.down")
            .Intent("k", "wm.focus.up")
            .Intent("l", "wm.focus.right")
            // moved from wm-base in Phase 2: float/monocle/flip live under focus
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
            // h/l: unstack-then-cycle (move out of stack, focus next).
            // j/k: cycle within stack (formerly bare [/]).
            // The old standalone \ "unstack" is gone; use h or l which do
            // unstack + cycle, the more useful composite.
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
        // Phase 4: terminal overlay (psmux pane navigation).
        // When WindowsTerminal.exe is focused (routed by AppLayerRouter), CAP
        // enters wm-terminal. The bindings below override wm-base's deadkey
        // for h/j/k/l with kanata macros that emit the psmux prefix (C-spc)
        // followed by the direction key. psmux-pain-control binds h/j/k/l
        // to select-pane-direction.
        .Overlay("terminal", b => b
            .Macro("h", "C-spc", "h")
            .Macro("j", "C-spc", "j")
            .Macro("k", "C-spc", "k")
            .Macro("l", "C-spc", "l"))
        .Build();
}
