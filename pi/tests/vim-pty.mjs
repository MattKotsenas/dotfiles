import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "pi-vim-pty-"));
const namespace = `pi-vim-${randomUUID().slice(0, 8)}`;
const target = "validation:0.0";
const agent = join(scratch, "agent");
mkdirSync(agent);
writeFileSync(join(scratch, "navigation-fixture.txt"), "Autocomplete fixture.\n");
const forward = (path) => path.replaceAll("\\", "/");
const powerline = join(process.env.USERPROFILE, ".pi/agent/npm/node_modules/pi-powerline-footer");
const vim = process.env.PI_VIM_EDITOR ?? join(process.env.USERPROFILE, ".pi/agent/npm/node_modules/pi-vim-editor/src/index.ts");
const settings = JSON.parse(readFileSync(join(repo, "pi/agent/settings.json"), "utf8"));
settings.packages = [
  join(repo, "pi/agent/extensions/powerline-chrome.ts"),
  join(repo, "pi/agent/extensions/vim-navigation.ts"), powerline,
  join(repo, "pi/agent/extensions/compact-footer.ts"), vim, join(scratch, "probe.ts"),
  join(process.env.USERPROFILE, ".pi/agent/git/github.com/otahontas/pi-coding-agent-catppuccin"),
].map(forward);
Object.assign(settings, { skills: [], cacheWarming: "off", workingVibeMode: "off", showHardwareCursor: true,
  defaultProvider: "vim-validation", defaultModel: "fixture", enabledModels: ["vim-validation/fixture", "vim-validation/second"],
});
writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
writeFileSync(join(agent, "keybindings.json"), readFileSync(join(repo, "pi/agent/keybindings.json")));
// This probe observes public editor state. It neither sends input nor calls private APIs.
writeFileSync(join(scratch, "probe.ts"), `
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
export default function(pi) {
  const faux = fauxProvider({ provider: "vim-validation", models: [{ id: "fixture" }, { id: "second" }], tokensPerSecond: 20 });
  faux.setResponses([fauxAssistantMessage("STREAMING_VALIDATION " + "waiting for interruption ".repeat(500))]);
  pi.registerProvider(faux.provider);
  let timer;
  const instance = Date.now();
  pi.on("session_start", (_, ctx) => {
    let editor;
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((...args) => editor = previous(...args));
    timer = setInterval(() => {
      appendFileSync(${JSON.stringify(join(scratch, "state.jsonl"))}, JSON.stringify({
        text: editor.getText(), cursor: editor.getCursor(), focused: editor.focused,
        autocomplete: editor.isShowingAutocomplete(),
        vim: editor[Symbol.for("pi-vim-editor")]?.status(), idle: ctx.isIdle(), instance,
      }) + "\\n");
    }, 50);
  });
  pi.on("session_shutdown", () => clearInterval(timer));
}
`);
const entries = [{ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: scratch }];
let parent = null;
function message(value) {
  const id = randomUUID().slice(0, 8);
  entries.push({ type: "message", id, parentId: parent, timestamp: new Date().toISOString(), message: { ...value, timestamp: Date.now() } });
  parent = id;
}
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
for (let i = 0; i < 15; i++) {
  message({ role: "user", content: `PROMPT_${i}: inspect the rendered transcript.` });
  message({ role: "assistant", content: [{ type: "text", text: `ANSWER_${i}: needle_${i}\n\n` + Array.from({ length: 7 }, (_, row) => `Detail ${row}: Unicode café 界 and keyboard navigation.`).join("\n") }], api: "openai-responses", provider: settings.defaultProvider, model: settings.defaultModel, usage, stopReason: "stop" });
}
message({ role: "assistant", content: [{ type: "toolCall", id: "fixture-tool", name: "bash", arguments: { command: "echo fixture" } }], api: "openai-responses", provider: settings.defaultProvider, model: settings.defaultModel, usage, stopReason: "toolUse" });
message({ role: "toolResult", toolCallId: "fixture-tool", toolName: "bash", content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `TOOL_LINE_${i}`).join("\n") }], isError: false });
writeFileSync(join(scratch, "session.jsonl"), entries.map(JSON.stringify).join("\n") + "\n");
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
writeFileSync(join(scratch, "launch.ps1"), `
$env:PI_CODING_AGENT_DIR = ${psQuote(agent)}
$env:PI_OFFLINE = '1'
$env:POWERLINE_NERD_FONTS = '1'
Remove-Item Env:PI_SESSION_FILE, Env:PI_SESSION_ID -ErrorAction SilentlyContinue
Set-Location ${psQuote(scratch)}
& pi --offline --no-mcp --no-context-files --no-skills --no-prompt-templates --no-tools --session ${psQuote(join(scratch, "session.jsonl"))} 2> ${psQuote(join(scratch, "stderr.txt"))}
`);
writeFileSync(join(scratch, "psmux.conf"), "set -g status off\nset -g escape-time 10\nset -g extended-keys on\n");
function mux(...args) {
  const result = spawnSync("psmux", ["-L", namespace, ...args], { encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let captureIndex = 0;
function capture(label) {
  const screen = mux("capture-pane", "-p", "-t", target);
  writeFileSync(join(scratch, `${String(captureIndex++).padStart(2, "0")}-${label}.txt`), screen);
  return screen;
}
function state() {
  // Read only complete records: no partial JSON reads or Windows replace/open races.
  const records = readFileSync(join(scratch, "state.jsonl"), "utf8");
  const end = records.lastIndexOf("\n");
  return JSON.parse(records.slice(records.lastIndexOf("\n", end - 1) + 1, end));
}
async function waitFor(label, predicate) {
  const deadline = Date.now() + 20000;
  let last;
  do {
    try { last = state(); } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (last && predicate(last)) return last;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}\n${capture("failure")}`);
}
async function keys(...values) { mux("send-keys", "-t", target, ...values); await delay(150); }
async function literal(value) { mux("send-keys", "-t", target, "-l", value); await delay(150); }
let started = false;
try {
  mux("-f", join(scratch, "psmux.conf"), "new-session", "-d", "-s", "validation", "--", "pwsh", "-NoLogo", "-NoProfile", "-File", join(scratch, "launch.ps1"));
  started = true;
  await waitFor("Vim editor startup", (s) => s.vim?.mode === "insert");
  assert.match(capture("startup"), /INSERT/);
  await literal("alpha beta draft");
  assert.match(capture("indent"), /^ {2}alpha beta draft/m);
  await keys("Escape");
  await waitFor("normal mode", (s) => s.vim.mode === "normal");
  await literal("0ciw"); await literal("first"); await keys("Escape");
  await waitFor("Vim change", (s) => s.text === "first beta draft" && s.vim.mode === "normal");
  await literal("u");
  await waitFor("Vim undo", (s) => s.text === "alpha beta draft");
  for (const pending of ["d", "r"]) {
    await literal(pending);
    assert.match(capture(`pending-${pending}`), new RegExp(`NORMAL · ${pending}`));
    await keys("Escape");
  }
  await literal("R");
  assert.match(capture("replace"), /REPLACE/);
  await keys("Escape");
  await literal("0vw");
  await waitFor("Visual mode", (s) => s.vim.mode === "visual");
  assert.match(capture("visual"), /VISUAL/);
  const ansiVisual = mux("capture-pane", "-e", "-p", "-t", target);
  writeFileSync(join(scratch, "visual.ansi"), ansiVisual);
  let reversed = false;
  let selectedText = "";
  for (const part of ansiVisual.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      for (const code of part.slice(2, -1).split(";").map(Number)) {
        if (code === 0 || code === 27) reversed = false;
        if (code === 7) reversed = true;
      }
    } else if (reversed) selectedText += part;
  }
  assert.ok(selectedText.includes("alpha"), "ConPTY must draw a highlighted word, not just a cursor");
  await keys("Escape");
  const saved = state();
  await keys("M-t");
  assert.match(capture("browse"), /BROWSE/);
  await keys("M-s");
  assert.equal(state().text, saved.text, "Powerline's earlier stash handler must not clear a BROWSE draft");
  assert.deepEqual(state().cursor, saved.cursor);
  for (const width of [33, 34, 80, 120]) {
    mux("resize-window", "-t", "validation", "-x", String(width), "-y", "30");
    await delay(250);
    assert.match(capture(`browse-width-${width}`), /BROWSE/, "the mode must stay visible at status-fit boundaries");
  }
  await literal("gg");
  assert.match(capture("top"), /PROMPT_0/);
  await literal("J");
  assert.match(capture("next-message"), /ANSWER_0/);
  await literal("K");
  assert.match(capture("previous-message"), /PROMPT_0/);
  await keys("S-j");
  assert.match(capture("shift-next-message"), /ANSWER_0/);
  await keys("S-k");
  assert.match(capture("shift-previous-message"), /PROMPT_0/);
  await literal("\x1b[74u");
  assert.match(capture("encoded-next-message"), /ANSWER_0/);
  await literal("\x1b[75u");
  assert.match(capture("encoded-previous-message"), /PROMPT_0/);
  await literal("d");
  assert.doesNotMatch(capture("half-page"), /PROMPT_0/);
  await literal("jku");
  await literal("/");
  await waitFor("search owns focus", (s) => !s.focused);
  await literal("needle_");
  const matchIndex = (label) => {
    const match = capture(label).match(/(\d+)\/15/);
    assert.ok(match, "the search overlay must show its selected match");
    return Number(match[1]);
  };
  const first = matchIndex("search");
  await keys("Enter");
  assert.equal(matchIndex("search-next"), first % 15 + 1);
  const windowsTerminal = JSON.parse(readFileSync(join(repo, "wt/settings.json"), "utf8"));
  const shiftEnter = windowsTerminal.keybindings.find((binding) => binding.keys === "shift+enter");
  assert.equal(windowsTerminal.actions.find((action) => action.id === shiftEnter.id).command.input, "\x1b\r");
  // psmux reads WT's ESC+Enter mapping as Alt-Enter; use its named-key path.
  await keys("M-Enter");
  assert.equal(matchIndex("search-previous"), first, "the Windows Terminal Shift-Enter mapping moves backwards");
  assert.equal(state().focused, false);
  await keys("Escape");
  await waitFor("search closes", (s) => s.focused);
  assert.match(capture("after-search"), /BROWSE/);
  assert.equal(state().text, saved.text);
  assert.deepEqual(state().cursor, saved.cursor);
  await keys("C-l");
  await waitFor("model picker owns focus", (s) => !s.focused);
  await literal("jkn");
  assert.match(capture("picker"), /jkn/);
  await keys("Escape");
  await waitFor("picker closes", (s) => s.focused);
  await literal("G");
  const collapsed = capture("tools-collapsed");
  await keys("C-o");
  const expanded = capture("tools-expanded");
  assert.notEqual(expanded, collapsed, "tool expansion changes the rendered transcript");
  await keys("C-o");
  await keys("Enter", "C-k", "C-j");
  assert.equal(state().text, saved.text, "browse controls must not edit or submit a draft");
  await keys("M-t");
  assert.match(capture("return-to-normal"), /NORMAL/);
  await literal("i");
  await waitFor("return to editing", (s) => s.vim.mode === "insert");
  await keys("M-s");
  await waitFor("Powerline stash still works outside BROWSE", (s) => s.text === "");
  await keys("M-s");
  await waitFor("Powerline restores the stash", (s) => s.text === saved.text);
  // Exercise resize through the real ConPTY, including narrow fallback and restoration.
  for (const width of [40, 12, 100]) {
    mux("resize-window", "-t", "validation", "-x", String(width), "-y", "30");
    await delay(250);
    assert.equal(mux("list-panes", "-t", target, "-F", "#{pane_width}").trim(), String(width));
    capture(`width-${width}`);
    assert.equal(state().text, saved.text);
  }
  const instance = state().instance;
  await keys("C-c");
  await literal("/reload"); await keys("Enter");
  await waitFor("reload reattaches Vim", (s) => s.instance !== instance && s.vim?.mode === "insert");
  assert.match(capture("reloaded"), /INSERT/);
  await literal("@nav");
  await waitFor("autocomplete opens", (s) => s.autocomplete);
  const completions = capture("autocomplete");
  assert.match(completions, /navigation-fixture.txt/);
  assert.ok(completions.indexOf("navigation-fixture.txt") > completions.indexOf("╰"), "completions stay below the frame");
  await keys("Escape");
  assert.equal(state().vim.mode, "insert", "Escape closes autocomplete before entering NORMAL");
  await keys("C-c");
  await literal("@nav");
  await waitFor("autocomplete reopens", (s) => s.autocomplete);
  assert.match(capture("completion-before-browse"), /navigation-fixture.txt/);
  await keys("M-t");
  await waitFor("Alt-T closes completion and enters NORMAL", (s) => s.vim.mode === "normal" && !s.autocomplete);
  assert.match(capture("browse-from-completion"), /BROWSE/);
  await keys("M-t");
  assert.match(capture("normal-after-completion"), /NORMAL/);
  await literal("i");
  await keys("C-c");
  await literal("start streaming validation"); await keys("Enter");
  await waitFor("fixture agent is running", (s) => !s.idle);
  await keys("Escape");
  await waitFor("first Escape enters normal", (s) => s.vim.mode === "normal");
  assert.equal(state().idle, false, "first Escape must not abort the agent");
  await keys("Escape");
  await waitFor("second Escape aborts", (s) => s.idle);
  capture("interrupted");
  console.log(`PASS: isolated ConPTY editing, undo, Visual, browse, message jumps, search, picker, expansion, draft preservation, resize, reload and running-agent interruption.\nArtifacts: ${scratch}`);
} finally {
  if (started) {
    const alive = spawnSync("psmux", ["-L", namespace, "has-session", "-t", "validation"], { encoding: "utf8", timeout: 15000 });
    assert.ifError(alive.error);
    if (alive.status === 0) mux("kill-session", "-t", "validation");
    else assert.match(alive.stderr, /no server|can't find session/);
  }
}
