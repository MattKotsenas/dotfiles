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
        .Reserve(
            // wm-base globals: tab + / remain, plus grv (backtick) which macros
            // F13 to activate mousemaster (see WmBase).
            global: ["tab", "/", "grv"],
            // Sub-mode entries: s = stack (now also covers assemble), d = move,
            // f = focus, e = resize, w = workspace, a = admin.
            subModeEntries: ["a", "s", "d", "f", "e", "w"])
        .WmBase(b => b
            .Intent("tab", "wm.focus.last-workspace")
            .Intent("/", "system.cheatsheet")
            // One-shot returns to typing after F13 so mousemaster's own keys work.
            .Macro("grv", "f13").Describe("activate mousemaster")
            // Arrow passthrough: arrows always do "their thing" even in WM mode
            // (Teams meeting nav, list nav, etc.). KanataLiteral emits the key
            // as itself; the compiler merges wm-base into every WM layer except
            // the one-shot sub-modes.
            .KanataLiteral("up", "up").Describe("arrow passthrough")
            .KanataLiteral("down", "down").Describe("arrow passthrough")
            .KanataLiteral("left", "left").Describe("arrow passthrough")
            .KanataLiteral("right", "right").Describe("arrow passthrough"))
        .SubMode("workspace", "w", b => b
            .Workspaces("wm.workspace.focus.{0}", 0, 7))
        .SubMode("focus", "f", b => b
            // Pure focus navigation. Window-state ops (toggle-float,
            // toggle-monocle) moved to wm-move; workspace layout ops
            // (flip-horizontal/vertical) moved to wm-admin.
            .Intent("h", "wm.focus.left")
            .Intent("j", "wm.focus.down")
            .Intent("k", "wm.focus.up")
            .Intent("l", "wm.focus.right")
            .Intent("g", "wm.focus.cycle-next"))
        .SubMode("move", "d", b => b
            // Ops acting ON the focused window: relocate, promote, send to
            // workspace, toggle float/monocle.
            .Intent("h", "wm.move.left")
            .Intent("j", "wm.move.down")
            .Intent("k", "wm.move.up")
            .Intent("l", "wm.move.right")
            .Intent("q", "wm.move.promote")
            .Intent("t", "wm.layout.toggle-float")
            .Intent("m", "wm.layout.toggle-monocle")
            .Workspaces("wm.workspace.move-to.{0}", 0, 7))
        .SubMode("stack", "s", b => b
            // Consolidated stack sub-mode: all 4 directional stack ops + cycle
            // within the focused stack + unstack. (Replaces the old separate
            // wm-assemble sub-mode whose `a` entry is now wm-admin.)
            .Intent("h", "wm.stack.left")
            .Intent("j", "wm.stack.down")
            .Intent("k", "wm.stack.up")
            .Intent("l", "wm.stack.right")
            .Intent("n", "wm.stack.cycle-next")
            .Intent("p", "wm.stack.cycle-prev")
            .Intent("u", "wm.stack.unstack"))
        .SubMode("resize", "e", b => b
            .Intent("h", "wm.resize.horizontal-decrease")
            .Intent("j", "wm.resize.vertical-decrease")
            .Intent("k", "wm.resize.vertical-increase")
            .Intent("l", "wm.resize.horizontal-increase"))
        .SubMode("admin", "a", b => b
            // Rare workspace/system ops. Bumped from wm-base globals so the
            // global keyspace stays minimal (only tab + / now).
            .Intent("r", "wm.window.reacquire")
            .Intent("m", "wm.window.manage")
            .Intent("p", "wm.layout.toggle-pause")
            .Intent("x", "wm.layout.flip-horizontal")
            .Intent("y", "wm.layout.flip-vertical"))
        // -------------------------------------------------------------------
        // App overlays. Routing rules live in event-listeners/AppLayerRouter.cs
        // -------------------------------------------------------------------
        .Overlay("terminal", b => b
            // psmux command access: every non-WM key here sends Ctrl+b (the
            // psmux prefix) then the key, so psmux config is the single source
            // of truth for what each key does (pane nav h/j/k/l, new window c,
            // command prompt ;, search /, kill x, etc.). wm-base reserved keys
            // (a/s/d/f/e/w sub-modes; tab/ globals; arrows) still do
            // their WM thing. Active via a single CAP (one-shot wm-terminal) or
            // a second CAP (sticky wm-terminal-toggle) in Windows Terminal.
            .Describe("Every key here forwards `Ctrl+b` (psmux prefix) then the key to the focused terminal. " +
                      "See `psmux/.psmux.conf` for what each key does in psmux (or hit `CAP ?` inside psmux to list binds).")
            .PrefixAll("C-b"))
        .Overlay("edge", b => b
            .Describe("Browser shortcuts forwarded through the WM layer. wm-base reserved keys still do their WM thing.")
            .Macro("t", "C-t").Describe("new tab")
            .Macro("[", "C-[").Describe("safely exit Vimium insert mode: sends Ctrl+[ which Vimium treats as Esc, so the site never sees a real Esc"))
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
        .Overlay("codeflow", b => b
            .Describe("Microsoft CodeFlow code review shortcuts. wm-base reserved keys still do their WM thing.")
            // Diff navigation (vim-style: brings the F-row to home row)
            .Macro("j", "f8").Describe("next difference")
            .Macro("k", "f7").Describe("previous difference")
            .Macro("l", "C-f8").Describe("next file")
            .Macro("h", "C-f7").Describe("previous file")
            // Comments
            .Macro("c", "A-c").Describe("add comment at current line")
            .Macro("n", "C-f12").Describe("next comment thread")
            .Macro("b", "C-f11").Describe("previous comment thread")
            // Focus panels
            .Macro("t", "A-S-t").Describe("focus file tree")
            .Macro("v", "A-S-d").Describe("focus diff view")
            .Macro("o", "A-S-o").Describe("focus comments panel")
            // Mark reviewed: focus tree, tap Space (marks the file), focus diff
            .Macro("r", "A-S-t", "spc", "A-S-d").Describe("mark file reviewed, focus diff")
            // Util
            .Macro("g", "C-g").Describe("go to line")
            .Macro("u", "f5").Describe("refresh"))
        .Build();
}
