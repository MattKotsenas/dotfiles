import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { launchCommand } from "../agent/extensions/tangent.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "pi-tangent-pty-"));
const agent = join(root, "agent");
mkdirSync(join(agent, "extensions"), { recursive: true });
symlinkSync(
  join(repo, "pi/node_modules"),
  join(root, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
const eventsFile = join(root, "events.jsonl");
writeFileSync(
  join(agent, "extensions", "observer.ts"),
  `import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
export default function(pi) {
  for (const [name, exposure] of [["delegate", "codemode"], ["lookup", "deferred"]]) {
    pi.registerTool({name, label:name, description:name, exposure,
      parameters:{type:"object", properties:{}},
      execute:async()=>({content:[{type:"text",text:name+"-ok"}]})});
  }
  const emit = event => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event)+"\\n");
  const fake = fauxProvider({provider:"tangent-test",models:[{id:"fixture",reasoning:true}],tokensPerSecond:0});
  pi.registerProvider({...fake.provider, streamSimple(model, context, options) {
    emit({type:"request", session:process.env.PI_SESSION_FILE});
    fake.setResponses([fauxAssistantMessage("TANGENT_ONLY_RESPONSE")]);
    return fake.provider.streamSimple(model,context,options);
  }});
  pi.on("session_start",(_,ctx)=>emit({type:"ready",pane:process.env.TMUX_PANE,tmux:process.env.TMUX,
    file:ctx.sessionManager.getSessionFile(),model:ctx.model?.id,thinking:pi.getThinkingLevel(),tools:pi.getActiveTools(),
    callable:pi.getAllTools().filter(t=>t.exposure==="codemode"||t.exposure==="deferred").map(t=>t.name),
    profile:process.env.PI_CLIPBOARD_OSC52}));
}
`,
);
writeFileSync(
  join(agent, "settings.json"),
  JSON.stringify({
    extensions: [join(repo, "pi/agent/extensions/tangent.ts")],
    defaultProvider: "tangent-test",
    defaultModel: "fixture",
    defaultThinkingLevel: "high",
    defaultTools: ["read", "codemode"],
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
    quietStartup: true,
  }),
);
const source = SessionManager.create(root, join(root, "sessions"));
source.appendMessage({ role: "user", content: "PARENT_QUESTION", timestamp: Date.now() });
source.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "PARENT_ANSWER" }],
  api: "openai-responses",
  provider: "tangent-test",
  model: "fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});
const namespace = `pi-tangent-${randomUUID().slice(0, 8)}`;
const env = { ...process.env, PI_OFFLINE: "1" };
for (const key of ["TMUX", "TMUX_PANE", "PSMUX_TARGET_SESSION", "PSMUX_SESSION", "PI_CLIPBOARD_OSC52"]) delete env[key];
writeFileSync(
  join(root, "mux.conf"),
  "set -g status off\nset -g base-index 0\nset -g pane-base-index 0\nset -g remain-on-exit on\n",
);
function mux(...args) {
  const result = spawnSync("tmux", ["-L", namespace, ...args], { env, encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function events() {
  let text;
  try {
    text = readFileSync(eventsFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
}
async function until(label, predicate) {
  const deadline = Date.now() + 30000;
  do {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label}. Artifacts: ${root}\n${mux("capture-pane", "-p", "-t", "acceptance:parent")}`);
}
function submit(pane, text) {
  mux("send-keys", "-t", pane, "-l", text);
  mux("send-keys", "-t", pane, "Enter");
}
let started = false;
try {
  mux(
    "-f",
    join(root, "mux.conf"),
    "new-session",
    "-d",
    "-s",
    "acceptance",
    "-n",
    "parent",
    "-x",
    "120",
    "-y",
    "30",
    "-c",
    root,
    launchCommand(
      [
        "--offline",
        "--provider",
        "tangent-test",
        "--model",
        "fixture",
        "--thinking",
        "high",
        "--no-mcp",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--tools",
        "read",
        "--session",
        source.getSessionFile(),
      ],
      agent,
    ),
  );
  started = true;
  await until("parent is ready", () => events().some((e) => e.type === "ready"));
  const parent = events().find((e) => e.type === "ready");
  await until("parent transcript is visible", () =>
    mux("capture-pane", "-p", "-t", parent.pane).includes("PARENT_ANSWER"),
  );
  assert.equal(parent.model, "fixture");
  assert.equal(parent.thinking, "high");
  assert.deepEqual(parent.tools, ["read"]);
  assert.deepEqual(parent.callable, []);
  const original = readFileSync(source.getSessionFile(), "utf8");
  assert.equal(events().filter((e) => e.type === "request").length, 0);
  submit(parent.pane, "/tangent O'Brien  日本語");
  await until("child is ready", () => events().filter((e) => e.type === "ready").length === 2);
  const child = events().filter((e) => e.type === "ready")[1];
  assert.notEqual(child.pane, parent.pane);
  assert.notEqual(child.file, parent.file);
  assert.equal(child.model, parent.model);
  assert.equal(child.thinking, parent.thinking);
  assert.deepEqual(child.tools, ["read", "codemode"]);
  assert.deepEqual(child.callable, ["delegate", "lookup"]);
  if (process.platform === "win32") assert.equal(child.profile, "1");
  const manager = SessionManager.open(child.file, join(root, "sessions"));
  assert.equal(manager.getHeader().parentSession, parent.file);
  assert.equal(manager.getSessionName(), "O'Brien  日本語");
  assert.equal(readFileSync(parent.file, "utf8"), original);
  assert.equal(events().filter((e) => e.type === "request").length, 0, "forking does not call the model");
  const parentWindow = mux("display-message", "-p", "-t", parent.pane, "#{window_id}");
  assert.equal(mux("display-message", "-p", "-t", child.pane, "#{window_id}"), parentWindow);
  assert.equal(
    mux("display-message", "-p", "-t", child.pane, "#{pane_top}"),
    mux("display-message", "-p", "-t", parent.pane, "#{pane_top}"),
  );
  assert(
    Number(mux("display-message", "-p", "-t", child.pane, "#{pane_left}")) >
      Number(mux("display-message", "-p", "-t", parent.pane, "#{pane_left}")),
  );
  submit(child.pane, "Continue only the tangent");
  await until("child responds independently", () =>
    mux("capture-pane", "-p", "-t", child.pane).includes("TANGENT_ONLY_RESPONSE"),
  );
  assert.equal(readFileSync(parent.file, "utf8"), original);
  assert(!mux("capture-pane", "-p", "-t", parent.pane).includes("TANGENT_ONLY_RESPONSE"));
  assert(!mux("capture-pane", "-p", "-t", child.pane).includes("Session Tree"));
  submit(child.pane, "/tree");
  await until("tree opens in child", () => mux("capture-pane", "-p", "-t", child.pane).includes("Session Tree"));
  writeFileSync(join(root, "child-tree.txt"), mux("capture-pane", "-p", "-t", child.pane));
  writeFileSync(join(root, "parent.txt"), mux("capture-pane", "-p", "-t", parent.pane));
  assert.equal(readFileSync(parent.file, "utf8"), original);
  mux("send-keys", "-t", child.pane, "Escape");
  mux("break-pane", "-s", child.pane);
  assert.notEqual(mux("display-message", "-p", "-t", child.pane, "#{window_id}"), parentWindow);
  assert.equal(readFileSync(parent.file, "utf8"), original);
  assert(mux("capture-pane", "-p", "-t", child.pane).includes("TANGENT_ONLY_RESPONSE"));
  console.log(
    `PASS: /tangent opens a side-by-side pane, supports promotion, and preserves the parent.\nArtifacts: ${root}`,
  );
} finally {
  if (started) mux("kill-session", "-t", "acceptance");
}
