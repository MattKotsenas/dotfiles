import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, isKeyRelease, matchesKey, type Editor, type Keybinding, type KeyId } from "@earendil-works/pi-tui";

const vimStatus = Symbol.for("pi-vim-editor");
const nativeFrame = Symbol.for("dotfiles.vim-native-frame");
type VimStatus = { version: number; status(): { mode: string; pending: string } };
type ModalEditor = Editor & { [vimStatus]?: VimStatus; [nativeFrame]?: boolean };

const browseKeys: Partial<Record<Keybinding, KeyId>> = {
  "tui.altScreen.lineUp": "k",
  "tui.altScreen.lineDown": "j",
  "tui.altScreen.halfPageUp": "u",
  "tui.altScreen.halfPageDown": "d",
  "tui.altScreen.previousPrompt": "shift+k",
  "tui.altScreen.nextPrompt": "shift+j",
  "tui.altScreen.bottom": "shift+g",
  "tui.altScreen.search": "/",
};

export default function (pi: ExtensionAPI) {
  let dispose = () => {};

  pi.on("session_start", (_event, ctx) => {
    dispose();
    if (ctx.mode !== "tui") return;
    const ui = ctx.ui;
    const setEditor = ui.setEditorComponent;
    let enabled = true;
    let active: ModalEditor | undefined;
    let browse = false;
    let pendingG = false;
    let lastStatus: string | undefined;
    let restoreKeys = () => {};
    let isApplicationControl = (_data: string) => false;

    function publish() {
      const vim = active?.[vimStatus];
      const status = vim?.version === 1 ? vim.status() : undefined;
      const label = browse && active?.focused ? "BROWSE" : status
        ? [status.mode.replaceAll("-", " ").toUpperCase(), status.pending].filter(Boolean).join(" · ")
        : undefined;
      if (label !== lastStatus) {
        lastStatus = label;
        ui.setStatus("vim-mode", label);
      }
      if (!active?.focused) pendingG = false;
    }

    const unsubscribe = ui.onTerminalInput((data) => {
      if (!active?.focused || isKeyRelease(data)) return;
      const status = active[vimStatus]?.version === 1 ? active[vimStatus]!.status() : undefined;
      if (matchesKey(data, "alt+b") || (matchesKey(data, "q") && (browse || (status?.mode === "normal" && !status.pending)))) {
        if (!status) {
          ui.notify("Vim navigation needs pi-vim-editor loaded after it.", "warning");
          return { consume: true };
        }
        // Do not suspend an unfinished Vim operator or a Visual selection.
        if (!browse && (status.pending || !["insert", "normal"].includes(status.mode))) {
          ui.notify("Finish or cancel the Vim command before browsing.", "info");
          return { consume: true };
        }
        browse = !browse;
        pendingG = false;
        publish();
        return { consume: true };
      }
      if (!browse) return;
      const wasG = pendingG;
      pendingG = matchesKey(data, "g") && !wasG;
      if (matchesKey(data, "i") || matchesKey(data, "escape")) {
        browse = false;
        pendingG = false;
        publish();
        if (matchesKey(data, "escape")) return;
        if (matchesKey(data, "i") && active[vimStatus]?.status().mode === "normal") return;
        return { consume: true };
      }
      // Native viewport actions have already run. Only non-editing app controls may
      // continue to the Vim editor; all other browse input leaves the draft untouched.
      if (!isApplicationControl(data)) return { consume: true };
    });

    // Load before Powerline so our browse filter precedes its global stash/cut handlers.
    // Normalize each new Powerline editor before the later Vim factory decorates it.
    const editorSetter: typeof ui.setEditorComponent = (factory) => {
      if (!enabled) return setEditor.call(ui, factory);
      if (!factory) {
        active = undefined;
        browse = false;
        restoreKeys();
        publish();
        return setEditor.call(ui, factory);
      }
      setEditor.call(ui, (tui, theme, keybindings) => {
        const editor = factory(tui, theme, keybindings) as ModalEditor;
        if (editor.constructor.name !== "BashModeEditor" || editor[nativeFrame]) return editor;
        // TODO(someday): replace this prototype bypass with a supported Powerline native-render option.
        // Its instance renderer rearranges rows, preventing Vim's Visual highlighting;
        // the prototype renderer retains shell ghosts and leaves input behavior intact.
        editor.render = Object.getPrototypeOf(editor).render.bind(editor);
        editor[nativeFrame] = true;
        active = editor;
        browse = false;
        pendingG = false;
        restoreKeys();
        isApplicationControl = (data) => ["app.tools.expand", "app.thinking.toggle", "app.model.select"]
          .some((action) => keybindings.matches(data, action as Keybinding));
        const originalMatches = keybindings.matches;
        const matcher: typeof originalMatches = (data, action) => {
          if (!enabled) return originalMatches.call(keybindings, data, action);
          if (browse && editor.focused && !isKeyRelease(data)) {
            if (action === "tui.altScreen.top" && pendingG && matchesKey(data, "g")) {
              pendingG = false;
              return true;
            }
            const key = browseKeys[action];
            // Caps Lock and encoded uppercase text need not carry a Shift modifier.
            if (key && (matchesKey(data, key)
              || (key.startsWith("shift+") && decodeKittyPrintable(data) === key.slice(6).toUpperCase()))) {
              pendingG = false;
              return true;
            }
          }
          return originalMatches.call(keybindings, data, action);
        };
        // TODO(someday): use mode-scoped fullscreen bindings when Pi exposes them.
        // Native viewport dispatch precedes the public terminal-input listeners.
        keybindings.matches = matcher;
        restoreKeys = () => {
          if (keybindings.matches === matcher) keybindings.matches = originalMatches;
        };
        const render = editor.render.bind(editor);
        editor.render = (width) => {
          publish();
          return render(width);
        };
        return editor;
      });
    };
    ui.setEditorComponent = editorSetter;

    dispose = () => {
      enabled = false;
      unsubscribe();
      restoreKeys();
      browse = false;
      active = undefined;
      if (ui.setEditorComponent === editorSetter) ui.setEditorComponent = setEditor;
      ui.setStatus("vim-mode", undefined);
    };
  });

  pi.on("session_shutdown", () => dispose());
}
