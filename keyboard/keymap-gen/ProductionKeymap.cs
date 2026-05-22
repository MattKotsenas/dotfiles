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
            global: ["1", "2", "3", "4", "5", "6", "7", "8", "r", "p", "tab", "/", "q", "g",
                    "t", "m", "x", "y", "[", "]", "\\", "h", "j", "k", "l"],
            subModeEntries: ["a", "s", "d", "f", "e"])
        .WmBase(b => b
            .Workspaces("wm.workspace.focus.{0}", 0, 7)
            .Intent("r", "wm.layout.retile")
            .Intent("p", "wm.layout.toggle-pause")
            .Intent("tab", "wm.focus.last-workspace")
            .Intent("/", "system.cheatsheet")
            .Intent("q", "wm.move.promote")
            .Intent("g", "wm.focus.cycle-next")
            // Phase 2 will MOVE these out of wm-base
            .Intent("t", "wm.layout.toggle-float")
            .Intent("m", "wm.layout.toggle-monocle")
            .Intent("x", "wm.layout.flip-horizontal")
            .Intent("y", "wm.layout.flip-vertical")
            .Intent("[", "wm.stack.cycle-prev")
            .Intent("]", "wm.stack.cycle-next")
            .Intent("\\", "wm.stack.unstack")
            // Phase 4 will REMOVE these (nav.* goes away with terminal overlay)
            .Intent("h", "nav.left")
            .Intent("j", "nav.down")
            .Intent("k", "nav.up")
            .Intent("l", "nav.right"))
        .SubMode("focus", "f", b => b
            .Intent("h", "wm.focus.left")
            .Intent("j", "wm.focus.down")
            .Intent("k", "wm.focus.up")
            .Intent("l", "wm.focus.right"))
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
        .Build();
}
