import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "pi-quota-pty-"));
symlinkSync(join(repo, "pi/node_modules"), join(root, "node_modules"), "junction");
const agent = join(root, "agent");
const vim = join(process.env.USERPROFILE, ".pi/agent/npm/node_modules/pi-vim-editor/src/index.ts");
mkdirSync(agent);
const namespace = `pi-quota-${randomUUID().slice(0, 8)}`;
const target = "acceptance:0.0";
const eventsPath = join(root, "events.jsonl");
const oscPath = join(root, "osc.txt");
const providerPath = join(agent, "extensions/provider.ts");
mkdirSync(dirname(providerPath));
writeFileSync(
  providerPath,
  `
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { stream as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
export default function(pi) {
  const emit = event => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(chunk, ...args) {
    const value = String(chunk);
    if (value.includes("\\x1b]7501;")) appendFileSync(${JSON.stringify(oscPath)}, value);
    return write(chunk, ...args);
  };
  const fake = fauxProvider({ provider: "openai", models: [{ id: "first" }, { id: "second" }], tokensPerSecond: 0 });
  let attempt = 0;
  pi.registerProvider({ ...fake.provider,
    getModels: () => fake.models.map(model => ({ ...model, api: "openai-responses" })),
    streamSimple(model, context, options) {
    const users = context.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.filter(b => b.type === "text").map(b => b.text).join(""));
    const prompt = users.at(-1);
    emit({ type: "request", model: model.id, users });
    if (prompt === "cancel task" || (prompt === "recover task" && attempt++ === 0)) {
      return openaiResponses(model, context, { ...options, apiKey: "sk-hermetic", maxRetries: 0,
        fetch: async () => new Response(JSON.stringify({ error: {
          code: "subscription_sharing_usage_limit_exceeded", message: "Usage limit reached.", resets_in_seconds: 0,
        }}), { status: 429, headers: { "content-type": "application/json" } }),
      });
    }
    const response = prompt === "terminal failure"
      ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "insufficient_quota: Billing exhausted." })
      : fauxAssistantMessage("PTY_RECOVERED");
    fake.setResponses([response]);
    return fake.provider.streamSimple(model, context, options);
  }});
  let unsubscribe;
  pi.on("session_start", (_event, ctx) => {
    let editor;
    const factory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((...args) => editor = factory(...args));
    const observe = () => emit({ type: "editor", mode: editor?.[Symbol.for("pi-vim-editor")]?.status().mode });
    observe();
    unsubscribe = ctx.ui.onTerminalInput(() => { queueMicrotask(observe); });
    emit({ type: "ready" });
  });
  pi.on("session_shutdown", () => unsubscribe?.());
  pi.on("agent_settled", event => emit(event));
}
`,
);
writeFileSync(
  join(agent, "settings.json"),
  JSON.stringify({
    extensions: [join(repo, "pi/agent/extensions/openai-quota-resume/index.ts"), vim, providerPath],
    defaultProvider: "openai",
    defaultModel: "first",
    enabledModels: ["openai/first", "openai/second"],
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
    quietStartup: true,
  }),
);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
writeFileSync(
  join(root, "launch.ps1"),
  `
$env:PI_CODING_AGENT_DIR = ${quote(agent)}
$env:PI_OFFLINE = '1'
$env:PI_PROGRAM_STATUS = '1'
Remove-Item Env:PI_SESSION_FILE, Env:PI_SESSION_ID -ErrorAction SilentlyContinue
Set-Location ${quote(root)}
& pi --offline --no-mcp --no-context-files --no-skills --no-prompt-templates --no-tools 2> ${quote(join(root, "stderr.txt"))}
`,
);
writeFileSync(join(root, "psmux.conf"), "set -g status off\nset -g escape-time 10\nset -g extended-keys on\n");
function mux(...args) {
  const result = spawnSync("psmux", ["-L", namespace, ...args], { encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function events() {
  let contents;
  try {
    contents = readFileSync(eventsPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return contents
    .slice(0, contents.lastIndexOf("\n") + 1)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}
const requests = () => events().filter((event) => event.type === "request");
const settled = () => events().filter((event) => event.type === "agent_settled");
const editorMode = () => events().findLast((event) => event.type === "editor")?.mode;
function screen() {
  return mux("capture-pane", "-p", "-t", target);
}
async function until(label, predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  do {
    if (predicate()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}\n${screen()}`);
}
function oscState() {
  return readFileSync(oscPath, "utf8").split("\x1b]7501;state=").at(-1)?.split(":")[0].split("\x1b")[0];
}
async function submit(value) {
  if (editorMode() === "normal") {
    mux("send-keys", "-t", target, "i");
    await until("enter INSERT mode", () => editorMode() === "insert");
  }
  mux("send-keys", "-t", target, "-l", value);
  mux("send-keys", "-t", target, "Enter");
}
let started = false;
try {
  mux(
    "-f",
    join(root, "psmux.conf"),
    "new-session",
    "-d",
    "-s",
    "acceptance",
    "--",
    "pwsh",
    "-NoLogo",
    "-NoProfile",
    "-File",
    join(root, "launch.ps1"),
  );
  started = true;
  await until("Pi and Vim start", () => events().some((e) => e.type === "ready") && editorMode() === "insert");
  await submit("cancel task");
  await until("quota countdown appears", () => screen().includes("Press escape to cancel."));
  assert.equal(requests().length, 1);
  assert.equal(oscState(), "working");
  writeFileSync(join(root, "waiting.txt"), screen());
  await submit("/reload");
  await until("busy reload retains Pi's refusal", () =>
    screen().includes("Wait for the current response to finish before reloading."),
  );
  assert.equal(events().filter((event) => event.type === "ready").length, 1);
  assert.equal(requests().length, 1);
  assert.equal(oscState(), "working");
  mux("send-keys", "-t", target, "Escape");
  await until("first Escape leaves INSERT mode", () => editorMode() === "normal");
  assert.equal(settled().length, 0, "Vim's mode Escape must not cancel recovery");
  assert.equal(oscState(), "working");
  mux("send-keys", "-t", target, "Escape");
  await until("Pi's interrupt Escape cancels recovery", () => settled().length === 1);
  assert.equal(settled()[0].aborted, true);
  assert.equal(oscState(), "idle");
  await submit("/reload");
  await until("reload completes", () => events().filter((e) => e.type === "ready").length === 2);
  assert.equal(requests().length, 1);
  await submit("recover task");
  await until(
    "recovery countdown appears",
    () => requests().length === 2 && screen().includes("Press escape to cancel."),
  );
  mux("send-keys", "-t", target, "C-p");
  await until("task recovers", () => settled().length === 2, 40000);
  assert.equal(requests().length, 3);
  assert.equal(requests()[2].model, "second");
  assert.equal(requests()[2].users.at(-1), "recover task");
  assert.equal(oscState(), "done");
  assert.match(screen(), /PTY_RECOVERED/);
  await submit("terminal failure");
  await until("unrelated failure settles", () => settled().length === 3);
  assert.equal(oscState(), "error");
  assert(!screen().includes("Press escape to cancel."));
  writeFileSync(join(root, "failed.txt"), screen());
  console.log(
    `PASS: real ConPTY countdown, Vim Escape, interruption, reload, manual model change, automatic recovery and OSC7501 working/idle/done/error.\nArtifacts: ${root}`,
  );
} finally {
  if (started) mux("kill-session", "-t", "acceptance");
}
