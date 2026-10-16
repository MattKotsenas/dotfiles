import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const executable = execFileSync("volta", ["which", "pi"], { encoding: "utf8" }).trim();
const root = join(dirname(executable), "node_modules/@earendil-works/pi-coding-agent");
const host = createRequire(pathToFileURL(join(root, "package.json")));
const tuiPath = join(root, "node_modules/@earendil-works/pi-tui/dist/index.js");
const { createJiti } = host("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  "@earendil-works/pi-tui": tuiPath,
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
} });
const vimPath = process.env.PI_VIM_EDITOR ?? join(process.env.USERPROFILE, ".pi/agent/npm/node_modules/pi-vim-editor/src/index.ts");
const { default: vim } = await jiti.import(vimPath);
const { default: chrome } = await jiti.import("../agent/extensions/powerline-chrome.ts");
const { default: navigation } = await jiti.import("../agent/extensions/vim-navigation.ts");
const { CustomEditor } = await import(pathToFileURL(join(root, "dist/index.js")));
const { getEditorTheme, theme, initTheme } = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")));
initTheme("dark");
const { TuiAltScreen, KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, stripTerminalSequences, visibleWidth } = await import(pathToFileURL(tuiPath));
const { KEYBINDINGS } = await import(pathToFileURL(join(root, "dist/core/keybindings.js")));

function harness() {
  let input;
  const terminal = new Proxy({ columns: 90, rows: 24, kittyProtocolActive: false,
    start(fn) { input = fn; }, drainInput: async () => {},
  }, { get: (object, key) => object[key] ?? (() => {}) });
  const config = JSON.parse(readFileSync(new URL("../agent/keybindings.json", import.meta.url), "utf8"));
  const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...KEYBINDINGS }, config);
  setKeybindings(keys);
  const originalMatches = keys.matches;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const handlers = new Map();
  const statuses = new Map();
  const notifications = [];
  const widgets = new Map();
  const editorHost = { editor: undefined, render(width) { return this.editor?.render(width) ?? []; }, invalidate() {} };
  const transcript = { render: () => Array.from({ length: 140 }, (_, i) =>
    ([0, 25, 50, 75, 100].includes(i) ? "\x1b]133;A\x07" : "") + `message row ${i} needle`), invalidate() {} };
  tui.addChild(transcript);
  tui.addChild(editorHost);
  let factory;
  let interrupts = 0;
  let submissions = 0;
  const ui = {
    theme,
    getEditorComponent: () => factory,
    setEditorComponent(value) {
      factory = value;
      const text = editorHost.editor?.getText() ?? "";
      const editor = value(tui, getEditorTheme(), keys);
      editor.setText(text);
      const settings = JSON.parse(readFileSync(new URL("../agent/settings.json", import.meta.url), "utf8"));
      editor.setPaddingX(settings.editorPaddingX ?? 0);
      editor.onEscape = () => interrupts++;
      editor.onSubmit = () => submissions++;
      editorHost.editor = editor;
      tui.setFocus(editor);
    },
    setWidget(key, content, options) {
      widgets.set(key, { component: typeof content === "function" ? content(tui, theme) : undefined, options });
    },
    setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); tui.requestRender(); },
    onTerminalInput: (fn) => tui.addInputListener(fn),
    notify(message, level) { notifications.push({ message, level }); },
  };
  const pi = { on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); }, getSettings: () => ({}) };
  const ctx = { mode: "tui", ui, shutdown() {} };
  const start = () => { for (const fn of handlers.get("session_start") ?? []) fn({}, ctx); };
  chrome(pi);
  navigation(pi);
  // The real Powerline editor subclasses CustomEditor and installs an instance render wrapper.
  class BashModeEditor extends CustomEditor {}
  pi.on("session_start", () => {
    ui.setEditorComponent((tui, theme, keys) => {
      const editor = new BashModeEditor(tui, theme, keys);
      editor.render = () => { throw new Error("Powerline's rearranged renderer must be replaced before Vim decorates it"); };
      return editor;
    });
    ui.setWidget("powerline-top", () => ({ render: () => [` ${statuses.get("vim-mode") ?? "mode"} › path `], invalidate() {} }), { placement: "aboveEditor" });
  });
  vim(pi);
  start();
  tui.start();
  const render = () => { tui.renderNow(); return editorHost.editor.render(terminal.columns); };
  const send = (data) => { input(data); render(); };
  render();
  return { ui, tui, keys, originalMatches, statuses, notifications, widgets, terminal, start, render, send,
    get editor() { return editorHost.editor; }, get interrupts() { return interrupts; }, get submissions() { return submissions; },
    close() { for (const fn of handlers.get("session_shutdown") ?? []) fn({}, ctx); tui.stop(); },
  };
}
const plain = (lines) => lines.map(stripTerminalSequences);
const capability = (h) => h.editor[Symbol.for("pi-vim-editor")].status();

// Each harness owns the global Pi keybinding registry, so these tests run sequentially.
test("Vim edits, undo, pending status, Visual selection and rounded Powerline compose", () => {
  const h = harness();
  try {
    h.send("one two");
    h.send("\x1b");
    assert.equal(capability(h).mode, "normal");
    assert.equal(h.statuses.get("vim-mode"), "NORMAL");
    h.send("0");
    h.send("c");
    h.send("i");
    assert.equal(h.statuses.get("vim-mode"), "NORMAL · ci");
    h.send("w");
    h.send("first");
    h.send("\x1b");
    assert.equal(h.editor.getText(), "first two");
    h.send("u");
    assert.equal(h.editor.getText(), "one two");
    h.send("0");
    h.send("v");
    h.send("w");
    assert.equal(capability(h).mode, "visual");
    const drawn = h.render();
    assert.ok(plain(drawn)[0].startsWith("╭"));
    assert.ok(plain(drawn).at(-1).endsWith("╯"));
    assert.match(drawn[1], /\x1b\[7mone /, "Visual selection must highlight a word, not just the cursor");
    for (const width of [100, 24, 12, 8, 100]) {
      h.terminal.columns = width;
      assert.ok(h.render().every((line) => visibleWidth(line) <= width));
    }
  } finally { h.close(); }
});

test("mode stays visible while an operator or one-character replacement is pending", () => {
  const h = harness();
  try {
    h.send("one two");
    assert.ok(plain(h.render())[1].startsWith("  one"), "prompt text keeps its two-column native inset");
    h.send("\x1b");
    for (const key of ["d", "r"]) {
      h.send(key);
      assert.equal(capability(h).mode, "normal");
      assert.equal(h.statuses.get("vim-mode"), `NORMAL · ${key}`);
      h.send("\x1b");
    }
    h.send("R");
    assert.equal(h.statuses.get("vim-mode"), "REPLACE");
  } finally { h.close(); }
});

test("q toggles browsing only from idle NORMAL, leaving insert text and pending commands alone", () => {
  const h = harness();
  try {
    h.send("q");
    assert.equal(h.editor.getText(), "q");
    assert.equal(h.statuses.get("vim-mode"), "INSERT");
    h.send("\x1b");
    const cursor = h.editor.getCursor();
    h.send("q");
    assert.equal(h.statuses.get("vim-mode"), "BROWSE");
    h.send("q");
    assert.equal(h.statuses.get("vim-mode"), "NORMAL");
    assert.deepEqual(h.editor.getCursor(), cursor);
    h.send("r");
    h.send("q");
    assert.equal(h.statuses.get("vim-mode"), "NORMAL", "q completes r instead of entering browse");
    h.send("v");
    h.send("q");
    assert.equal(capability(h).mode, "visual");
    h.send("\x1b");
    h.send("q");
    h.send("i");
    assert.equal(capability(h).mode, "insert");
    h.send("\x1bb");
    h.send("q");
    assert.equal(capability(h).mode, "insert", "q restores the underlying INSERT mode too");
    assert.equal(h.editor.getText(), "q");
  } finally { h.close(); }
});

test("message jumps accept literal, shifted and encoded uppercase keys without changing the draft", () => {
  const h = harness();
  try {
    h.send("populated draft");
    h.send("\x1bb");
    for (const [next, previous] of [
      ["J", "K"], ["\x1b[106;2u", "\x1b[107;2u"],
      ["\x1b[74u", "\x1b[75u"], ["\x1b[74;65u", "\x1b[75;65u"],
      ["\x1b[27;2;106~", "\x1b[27;2;107~"],
    ]) {
      h.tui.scrollToTop();
      h.render();
      h.send(next);
      assert.equal(h.tui.viewportTop, 25, JSON.stringify(next));
      h.send(previous);
      assert.equal(h.tui.viewportTop, 0, JSON.stringify(previous));
    }
    h.send("\x1b[106;6u");
    h.send("\x1b[106;2:3u");
    assert.equal(h.tui.viewportTop, 0, "control chords and releases cannot jump");
    assert.equal(h.editor.getText(), "populated draft");
  } finally { h.close(); }
});

test("browse preserves a populated draft, cursor, undo and underlying mode", () => {
  const h = harness();
  try {
    h.send("unfinished draft");
    const cursor = h.editor.getCursor();
    h.send("\x1bb");
    assert.equal(h.statuses.get("vim-mode"), "BROWSE");
    h.tui.scrollToTop();
    h.render();
    h.send("j");
    assert.equal(h.tui.viewportTop, 1);
    h.send("J");
    assert.equal(h.tui.viewportTop, 25);
    h.send("K");
    assert.equal(h.tui.viewportTop, 0);
    h.send("d");
    assert.ok(h.tui.viewportTop > 0);
    h.send("g");
    h.send("g");
    assert.equal(h.tui.viewportTop, 0);
    h.send("G");
    assert.ok(h.tui.isFollowingOutput);
    h.send("x");
    h.send("\r");
    h.send("\x1b[200~accidental paste\x1b[201~");
    assert.equal(h.editor.getText(), "unfinished draft");
    assert.deepEqual(h.editor.getCursor(), cursor);
    assert.equal(h.submissions, 0);
    h.send("i");
    assert.equal(h.statuses.get("vim-mode"), "INSERT");
    assert.equal(h.editor.getText(), "unfinished draft", "i returning to INSERT must not insert an i");
    h.send("\x1b");
    h.send("u");
    assert.equal(h.editor.getText(), "");
  } finally { h.close(); }
});

test("native search owns query characters and Escape, then resumes browsing", () => {
  const h = harness();
  try {
    h.send("draft");
    h.send("\x1bb");
    h.send("/");
    assert.equal(h.editor.focused, false);
    h.send("jkn");
    assert.ok(plain(h.tui.getScreenLines()).some((line) => line.includes("jkn")));
    h.send("\x1b");
    assert.equal(h.editor.focused, true);
    assert.equal(h.interrupts, 0);
    h.tui.scrollToTop();
    h.render();
    h.send("/");
    h.send("needle");
    const before = h.tui.viewportTop;
    h.send("\x1b[13;2u");
    assert.notEqual(h.tui.viewportTop, before, "Shift-Enter selects an older offscreen match");
    const previous = h.tui.viewportTop;
    h.send("\r");
    assert.notEqual(h.tui.viewportTop, previous, "Enter selects the next match");
    h.send("\x1b\r");
    assert.equal(h.tui.viewportTop, previous, "the configured Windows Terminal Shift-Enter sequence also moves backwards");
    assert.equal(h.keys.matches("\x0b", "tui.altScreen.searchPrevious"), false);
    assert.equal(h.keys.matches("\x0a", "tui.altScreen.searchNext"), h.originalMatches.call(h.keys, "\x0a", "tui.altScreen.searchNext"));
    h.send("\x1b");
    assert.equal(h.editor.getText(), "draft");
    assert.equal(h.statuses.get("vim-mode"), "BROWSE");
  } finally { h.close(); }
});

test("dialogs suspend browse keys, and shutdown restores the shared matcher", () => {
  const h = harness();
  try {
    h.send("\x1bb");
    h.send("g");
    const received = [];
    const dialog = { focused: false, render: () => ["dialog"], invalidate() {}, handleInput: (data) => received.push(data) };
    const overlay = h.tui.showOverlay(dialog);
    h.render();
    h.send("j");
    h.send("/");
    h.send("\x1bb");
    assert.deepEqual(received, ["j", "/", "\x1bb"]);
    overlay.hide();
    h.render();
    h.tui.scrollBy(-10);
    h.render();
    const top = h.tui.viewportTop;
    h.send("g");
    assert.equal(h.tui.viewportTop, top, "dialog focus loss clears the gg prefix");
    h.send("q");
    h.send("\x1b");
    h.send("\x1b");
    assert.equal(h.interrupts, 1);
  } finally { h.close(); }
  assert.equal(h.keys.matches, h.originalMatches);
});

test("native editor scroll indicators survive the modal frame", () => {
  const h = harness();
  try {
    h.editor.setText(Array.from({ length: 60 }, (_, i) => `draft line ${i}`).join("\n"));
    h.send("\x1b");
    h.send("gg");
    assert.ok(plain(h.render()).at(-1).includes("↓"));
    h.send("G");
    assert.ok(plain(h.render())[0].includes("↑"));
  } finally { h.close(); }
});

test("modal status survives exact-fit widths and restores its widget when it cannot fit", () => {
  const h = harness();
  try {
    for (const spare of [2, 3]) {
      h.ui.setWidget("powerline-top", () => ({
        render: (width) => [` ${"m".repeat(width - spare)} `], invalidate() {},
      }), { placement: "aboveEditor" });
      assert.ok(plain(h.render())[0].includes("m".repeat(h.terminal.columns - spare)));
      assert.deepEqual(h.widgets.get("powerline-top").component.render(h.terminal.columns), []);
    }
    h.ui.setWidget("powerline-top", () => ({ render: () => ["unexpected", "two rows"], invalidate() {} }), { placement: "aboveEditor" });
    h.render();
    assert.deepEqual(h.widgets.get("powerline-top").component.render(h.terminal.columns), ["unexpected", "two rows"]);
    h.ui.setWidget("powerline-top", () => ({ render: () => [" NORMAL "], invalidate() {} }), { placement: "aboveEditor" });
    assert.ok(plain(h.render())[0].includes("NORMAL"));
    assert.deepEqual(h.widgets.get("powerline-top").component.render(h.terminal.columns), []);
  } finally { h.close(); }
});

test("unfinished commands and Visual selections cannot be suspended into browse", () => {
  const h = harness();
  try {
    h.send("words");
    h.send("\x1b");
    h.send("d");
    h.send("\x1bb");
    assert.equal(capability(h).pending, "d");
    assert.notEqual(h.statuses.get("vim-mode"), "BROWSE");
    h.send("\x1b");
    h.send("v");
    h.send("\x1bb");
    assert.equal(capability(h).mode, "visual");
    assert.equal(h.notifications.length, 2);
  } finally { h.close(); }
});

test("a later keybinding wrapper can retain an inert navigation matcher after shutdown", () => {
  const h = harness();
  h.send("\x1bb");
  const navigationMatches = h.keys.matches;
  assert.equal(navigationMatches("J", "tui.altScreen.nextPrompt"), true);
  const later = function (data, action) { return navigationMatches.call(this, data, action); };
  h.keys.matches = later;
  h.close();
  assert.equal(h.keys.matches, later);
  assert.equal(h.keys.matches("J", "tui.altScreen.nextPrompt"), false);
});

for (const mode of ["print", "json", "rpc"]) {
  test(`${mode} navigation leaves UI and bindings untouched`, () => {
    const handlers = new Map();
    navigation({ on: (name, fn) => handlers.set(name, fn) });
    handlers.get("session_start")({}, { mode, get ui() { throw new Error("non-TUI mode accessed UI"); } });
    handlers.get("session_shutdown")();
  });
}

test("package order prepares native rendering before Vim, with mode in the Powerline layout", () => {
  const settings = JSON.parse(readFileSync(new URL("../agent/settings.json", import.meta.url), "utf8"));
  assert.ok(settings.packages.indexOf("./extensions/vim-navigation.ts") < settings.packages.indexOf("npm:pi-powerline-footer"));
  assert.ok(settings.packages.indexOf("npm:pi-powerline-footer") < settings.packages.indexOf("npm:pi-vim-editor@0.4.0"));
  assert.ok(settings.powerline.layout.left.includes("custom:vim-mode"));
});
