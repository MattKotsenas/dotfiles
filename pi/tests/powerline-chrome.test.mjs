import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { test } from "node:test";

const executable = execFileSync("volta", ["which", "pi"], { encoding: "utf8" }).trim();
const hostRoot = join(dirname(executable), "node_modules/@earendil-works/pi-coding-agent");
const host = createRequire(pathToFileURL(join(hostRoot, "package.json")));
const tuiPath = join(hostRoot, "node_modules/@earendil-works/pi-tui/dist/index.js");
const { createJiti } = host("jiti");
const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@earendil-works/pi-tui": tuiPath,
    "@earendil-works/pi-coding-agent": join(hostRoot, "dist/index.js"),
    "@earendil-works/pi-ai": join(hostRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  },
});
const { default: chrome } = await jiti.import("../agent/extensions/powerline-chrome.ts");
const { Editor, CURSOR_MARKER, visibleWidth, stripTerminalSequences } = await import(pathToFileURL(tuiPath));

// Exercise the installed Powerline render seam with the real Pi editor, without starting its services.
const powerlinePath = join(process.env.USERPROFILE, ".pi/agent/npm/node_modules/pi-powerline-footer/index.ts");
const { renderFastPowerlineEditor } = await jiti.import(powerlinePath);
const source = readFileSync(powerlinePath, "utf8");
const start = source.indexOf("editor.render = (width: number): string[] =>");
const end = source.indexOf("\n      };", start);
assert.ok(start >= 0 && end > start, "installed Powerline must expose the expected render seam");
const renderSource = source.slice(start, end) + "\n};";
class BashModeEditor extends Editor {}

function harness(mode = "tui") {
  const handlers = new Map();
  const widgets = new Map();
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const theme = { fg: (_color, value) => value };
  let editor;
  let factory;
  const ui = {
    theme,
    setWidget(key, content, options) {
      if (content === undefined) widgets.delete(key);
      else widgets.set(key, { component: typeof content === "function" ? content(tui, theme) : { render: () => content }, options });
    },
    setEditorComponent(value) {
      factory = value;
      editor = value?.(tui, { borderColor: (value) => value, selectList: {} }, {});
    },
    getEditorComponent: () => factory,
  };
  const originalSetters = { widget: ui.setWidget, editor: ui.setEditorComponent };
  const ctx = { mode, ui };
  chrome({ on: (name, callback) => handlers.set(name, callback) });
  const startSession = () => handlers.get("session_start")({}, ctx);
  startSession();
  const installEditor = (fastRender = false) => {
    ui.setEditorComponent((tui, theme) => {
      const base = new BashModeEditor(tui, theme);
      base.focused = true;
      const originalRender = base.render.bind(base);
      vm.runInNewContext(stripTypeScriptTypes(renderSource), {
        editor: base, originalRender,
        editorPerf: { options: { editorChrome: true, fastRender, enabled: false } },
        renderFastPowerlineEditor,
        bashModeActive: false, bashModeSettings: { completions: false },
        ansi: { getFgAnsi: () => "\x1b[38;2;200;200;200m", reset: "\x1b[0m" },
        colorEditorBorder: (_editor, value) => value,
      });
      base.unframedRender = base.render.bind(base);
      return base;
    });
  };
  const installPrimary = (render = () => [" model › path › git "], placement = "aboveEditor") => {
    ui.setWidget("powerline-top", () => ({ render, invalidate() {}, dispose() {} }), { placement });
  };
  const render = (width) => {
    const primary = widgets.get("powerline-top")?.component.render(width) ?? [];
    return [...primary, ...editor.render(width)];
  };
  return { ui, widgets, originalSetters, installEditor, installPrimary, render, startSession,
    shutdown: () => handlers.get("session_shutdown")({}, ctx),
    get editor() { return editor; },
  };
}

const plain = (lines) => lines.map(stripTerminalSequences);

test("configured package order loads chrome before Powerline exactly once", async () => {
  const { SettingsManager, DefaultPackageManager } = await import(pathToFileURL(join(hostRoot, "dist/index.js")));
  const settings = JSON.parse(readFileSync(new URL("../agent/settings.json", import.meta.url), "utf8"));
  assert.equal(settings.packages[0], "./extensions/powerline-chrome.ts");
  assert.equal(settings.packages[1], "npm:pi-powerline-footer");
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    const manager = new DefaultPackageManager({
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      agentDir: join(process.env.USERPROFILE, ".pi/agent"),
      settingsManager: SettingsManager.inMemory(settings),
    });
    const resources = await manager.resolve();
    const paths = resources.extensions.filter((entry) => entry.enabled).map((entry) => entry.path.replaceAll(String.fromCharCode(92), "/"));
    const chromeIndex = paths.findIndex((path) => path.endsWith("/extensions/powerline-chrome.ts"));
    const powerlineIndex = paths.findIndex((path) => path.endsWith("/pi-powerline-footer/index.ts"));
    assert.ok(chromeIndex >= 0 && powerlineIndex > chromeIndex, JSON.stringify(paths));
    assert.equal(paths.filter((path) => path.endsWith("/powerline-chrome.ts")).length, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }
});

test("rounded edges embed the status row and remove the prompt without moving the text cursor", () => {
  const h = harness();
  h.installEditor();
  h.installPrimary();
  h.editor.setText("hello");
  const before = h.editor.getText();
  const unframed = plain(h.editor.unframedRender(40));
  assert.ok(unframed[1].startsWith(" > "));
  assert.ok(unframed[0].startsWith(" ─"));
  const lines = h.render(40);
  assert.deepEqual(plain(lines), [
    "╭ model › path › git " + "─".repeat(40 - "╭ model › path › git ╮".length) + "╮",
    "   hello" + " ".repeat(32),
    "╰──────────────────────────────────────╯",
  ]);
  assert.equal(h.editor.getText(), before);
  assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
  assert.equal(visibleWidth(lines[1].split(CURSOR_MARKER)[0]), 8);
});

test("empty, multiline, wrapped and Unicode drafts stay bounded through resize", () => {
  const h = harness();
  h.installEditor();
  h.installPrimary((width) => width >= 25 ? [" model › path › git "] : width >= 7 ? [" model "] : []);
  for (const draft of ["", "one\ntwo\nthree", "word ".repeat(60), "界界 👩‍💻 café é"]) {
    h.editor.setText(draft);
    for (const width of [80, 25, 16, 12, 11, 5, 80]) {
      const lines = h.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}: ${JSON.stringify(plain(lines))}`);
      assert.equal(h.editor.getText(), draft);
      assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
      if (width >= 12) {
        assert.ok(plain(lines)[0].startsWith("╭"));
        assert.ok(plain(lines).at(-1).endsWith("╯"));
        assert.ok(plain(lines).slice(1, -1).every((line) => line.startsWith("   ") && !line.includes("│")));
      }
    }
  }
});

test("Unicode content rows keep native wrapping and padding byte-for-byte after the prompt", () => {
  const h = harness();
  h.installEditor();
  h.installPrimary(() => [" model "]);
  for (const draft of ["界界 café 👩‍💻", "👨‍👩‍👧‍👦 🇺🇸 ❤️", "emoji 👩‍💻 ".repeat(20)]) {
    h.editor.setText(draft);
    for (const width of [20, 59, 120]) {
      const original = [...h.editor.unframedRender(width)];
      assert.ok(plain(original)[1].startsWith(" > "));
      const expected = original.slice(1, -1);
      expected[0] = expected[0].replace(/^ (?:\x1b\[[0-9;]*m)*>(?:\x1b\[[0-9;]*m)* /, "   ");
      assert.deepEqual(h.render(width).slice(1, -1), expected);
    }
  }
});

test("primary rendering receives the full width and unrelated widgets remain untouched", () => {
  const h = harness();
  h.installEditor();
  const widths = [];
  h.installPrimary((width) => {
    widths.push(width);
    return width >= 40 ? [" model › path › git › context "] : [" model "];
  });
  h.ui.setWidget("unrelated", ["untouched"]);
  for (const width of [80, 20, 80]) {
    const lines = h.render(width);
    assert.equal(widths.at(-1), width);
    assert.equal(plain(lines)[0].includes("context"), width >= 40);
    assert.deepEqual(h.widgets.get("unrelated").component.render(width), ["untouched"]);
  }
});

test("an empty primary row and below placement retain both editor edges", () => {
  const h = harness();
  h.installEditor();
  h.installPrimary(() => []);
  assert.deepEqual(plain(h.render(12)), ["╭──────────╮", " ".repeat(12), "╰──────────╯"]);
  h.installPrimary(() => [" model "], "belowEditor");
  assert.deepEqual(plain(h.widgets.get("powerline-top").component.render(20)), [" model "]);
  assert.ok(plain(h.editor.render(20))[0].startsWith("╭"));
});

test("autocomplete rows and their ANSI styling remain outside the frame", () => {
  const h = harness();
  h.installEditor();
  h.installPrimary();
  h.editor.setText("/he");
  h.editor.autocompleteState = {};
  h.editor.autocompleteList = { render: () => ["\x1b[32m/hello\x1b[0m", "/help"] };
  const completions = [...h.editor.unframedRender(40).slice(-2)];
  assert.ok(completions[0].includes("\x1b[32m/hello\x1b[0m"));
  const lines = h.render(40);
  assert.equal(plain(lines).at(-3), "╰──────────────────────────────────────╯");
  assert.deepEqual(lines.slice(-2), completions);
});

test("autocomplete hit testing retains the native row offsets", () => {
  const h = harness();
  h.installEditor();
  h.installPrimary();
  h.editor.setText("/he");
  let clicked;
  h.editor.autocompleteState = {};
  h.editor.autocompleteList = {
    render: () => ["/hello", "/help"],
    handleMouse: (event) => { clicked = event; return { handled: true }; },
  };
  const lines = h.render(40);
  const row = plain(lines).findIndex((line) => line.trim() === "/hello");
  assert.equal(row, 3);
  assert.equal(h.editor.handleMouse({ type: "click", button: "left", x: 1, y: row, width: 40 }).handled, true);
  assert.equal(clicked.y, 0);
});

test("the installed fast renderer keeps bounded edges and its scroll indicators", () => {
  const h = harness();
  h.installEditor(true);
  h.installPrimary((width) => width >= 20 ? [" model "] : []);
  for (const draft of ["x".repeat(10_000), Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")]) {
    h.editor.setText(draft);
    const base = h.editor.unframedRender(40);
    assert.ok(plain(base)[0].includes("↑"), "precondition: installed fast path reports hidden preceding content");
    const lines = h.render(40);
    assert.ok(lines.every((line) => visibleWidth(line) <= 40));
    assert.equal(lines.join("").split(CURSOR_MARKER).length - 1, 1);
    assert.ok(plain(lines)[1].startsWith("↑"));
    assert.ok(plain(lines).at(-1).endsWith("╯"));
  }
});

test("unrecognized editors fall back at full width; resets and repeated sessions do not accumulate wrappers", () => {
  const h = harness();
  const widths = [];
  h.ui.setEditorComponent(() => ({ render: (width) => { widths.push(width); return ["different editor"]; } }));
  assert.deepEqual(h.editor.render(40), ["different editor"]);
  assert.equal(widths.at(-1), 40);
  h.startSession();
  h.installEditor();
  h.installPrimary();
  assert.equal(plain(h.render(40)).filter((line) => line.startsWith("╭")).length, 1);
  h.installEditor();
  assert.equal(plain(h.render(40)).filter((line) => line.startsWith("╭")).length, 1);
  h.ui.setEditorComponent(undefined);
  assert.equal(h.ui.getEditorComponent(), undefined);
  h.shutdown();
  assert.equal(h.ui.setWidget, h.originalSetters.widget);
  assert.equal(h.ui.setEditorComponent, h.originalSetters.editor);
});

test("unexpected Powerline output restores its independent status row and full-width renderer", () => {
  const h = harness();
  const widths = [];
  h.ui.setEditorComponent((tui, theme) => {
    const editor = new BashModeEditor(tui, theme);
    editor.render = (width) => { widths.push(width); return ["changed renderer"]; };
    return editor;
  });
  h.installPrimary();
  assert.deepEqual(h.widgets.get("powerline-top").component.render(40), []);
  assert.deepEqual(h.editor.render(40), ["changed renderer"]);
  assert.equal(widths.at(-1), 40);
  assert.deepEqual(h.widgets.get("powerline-top").component.render(40), [" model › path › git "]);
});

test("multiline or oversized status output falls back instead of changing input row coordinates", () => {
  for (const status of [[" first ", " second "], [" " + "x".repeat(40) + " "]]) {
    const h = harness();
    h.installEditor();
    h.installPrimary(() => status);
    assert.deepEqual(h.widgets.get("powerline-top").component.render(40), []);
    assert.deepEqual(plain(h.editor.render(40)), plain(h.editor.unframedRender(40)));
    assert.deepEqual(h.widgets.get("powerline-top").component.render(40), status);
  }
});

for (const mode of ["print", "json", "rpc"]) {
  test(`${mode} leaves UI setters untouched`, () => {
    const h = harness(mode);
    assert.equal(h.ui.setWidget, h.originalSetters.widget);
    assert.equal(h.ui.setEditorComponent, h.originalSetters.editor);
    h.shutdown();
  });
}
