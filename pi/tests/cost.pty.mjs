import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { launchCommand } from "../agent/extensions/tangent.ts";
import { project } from "../agent/extensions/cost/ledger.ts";
import { costRecord } from "../agent/extensions/cost/model.ts";

// Real CLI, terminal, session files and production extensions. All dollars below
// are synthetic TEST charges, not estimates of real provider spending.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdkRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const manifest = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
assert.equal(manifest.version, "1.2.0", "native lifecycle contracts are pinned to SDK 1.2.0");
const root = mkdtempSync(join(tmpdir(), "pi-cost-pty-"));
const agent = join(root, "agent");
const workspace = join(root, "workspace");
const sessions = join(root, "sessions");
for (const directory of [agent, workspace, sessions]) mkdirSync(directory);
symlinkSync(
  join(repo, "pi/node_modules"),
  join(root, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
// Match Dotbot's per-file links, including shared dependencies and discovery.
for (const file of [
  "cost/index.ts",
  "cost/ledger.ts",
  "cost/model.ts",
  "cost/view.ts",
  "shared/usage.ts",
  "compact-footer.ts",
  "tangent.ts",
]) {
  const target = join(agent, "extensions", file);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(join(repo, "pi/agent/extensions", file), target, "file");
}
const eventsFile = join(root, "events.jsonl");
const isolation = [
  "--offline",
  "--no-mcp",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-tools",
  "--no-approve",
];
const guard = join(root, "network.mjs");
writeFileSync(
  guard,
  `import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Socket } from "node:net";
import { syncBuiltinESMExports } from "node:module";
const deny = () => {
  appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({type:"network-denied"})+"\\n");
  throw new Error("Cost PTY tests deny network access");
};
globalThis.fetch = deny;
Socket.prototype.connect = deny;
syncBuiltinESMExports();
// /tangent owns its launch arguments. Enforce test-only isolation at CLI entry
// for every generation without changing the production launcher or user files.
assert(process.argv[1]?.endsWith("cli.js"), "Expected the native Pi CLI");
assert.equal(JSON.parse(readFileSync(resolve(dirname(process.argv[1]),"../../package.json"),"utf8")).version, "1.2.0");
for (const key of Object.keys(process.env)) {
  if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PROXY/i.test(key)) delete process.env[key];
}
delete process.env.PI_TUI_WRITE_LOG;
process.argv.splice(2,0,...${JSON.stringify(isolation)});
process.chdir(${JSON.stringify(workspace)});
`,
);
const observer = join(root, "observer.ts");
writeFileSync(
  observer,
  `import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { project } from ${JSON.stringify(join(repo, "pi/agent/extensions/cost/ledger.ts"))};
export default function(pi) {
  const emit = event => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({pid:process.pid,pane:process.env.TMUX_PANE,...event})+"\\n");
  const fake = fauxProvider({provider:"cost-pty-test",models:[{id:"synthetic",reasoning:true}],tokensPerSecond:0});
  pi.registerProvider({...fake.provider, streamSimple(model, context, options) {
    const user = context.messages.findLast(message => message.role === "user");
    const prompt = typeof user.content === "string" ? user.content : user.content.filter(block => block.type === "text").map(block => block.text).join("");
    const charges = {"PARENT_FAUX_WORK":0.25,"CHILD_FAUX_WORK":0.50};
    assert(Object.hasOwn(charges,prompt), "unexpected model request: "+prompt);
    emit({type:"request",prompt,cost:charges[prompt]});
    fake.setResponses([fauxAssistantMessage(prompt+"_DONE")]);
    const source = fake.provider.streamSimple(model,context,options);
    const output = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        // Native faux recalculates zero-priced usage. Charge the final event,
        // exactly where the production runtime receives a provider's usage.
        if (event.type === "done") event.message.usage = {
          input:100,output:1,cacheRead:0,cacheWrite:0,totalTokens:101,
          cost:{input:charges[prompt],output:0,cacheRead:0,cacheWrite:0,total:charges[prompt]}
        };
        output.push(event);
      }
      output.end();
    })();
    return output;
  }});
  const state = ctx => {
    const manager = ctx.sessionManager;
    return {file:manager.getSessionFile(),owner:manager.getSessionId(),leaf:manager.getLeafId(),
      cost:project(manager.getEntries(),new Set(manager.getBranch().map(entry=>entry.id)),manager.getSessionId())};
  };
  pi.on("session_start",(_,ctx)=>emit({type:"ready",...state(ctx),cwd:ctx.cwd,mode:ctx.mode,model:ctx.model?.id,tools:pi.getActiveTools(),argv:process.argv,guard:process.env.NODE_OPTIONS}));
  pi.on("agent_settled",(event,ctx)=>emit({type:"settled",...state(ctx),aborted:event.aborted}));
  pi.registerCommand("cost-test-state",{description:"Observe live state without writes",handler:async(_,ctx)=>emit({type:"snapshot",...state(ctx)})});
  pi.registerCommand("cost-test-quit",{description:"Exit isolated cost check",handler:async(_,ctx)=>ctx.shutdown()});
}
`,
);
writeFileSync(
  join(agent, "settings.json"),
  JSON.stringify({
    extensions: ["-builtin:mcp", "-builtin:llama.cpp", "-builtin:codemode", "-builtin:tool-search", observer],
    defaultProvider: "cost-pty-test",
    defaultModel: "synthetic",
    defaultThinkingLevel: "off",
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
    quietStartup: true,
    theme: "dark",
    tuiMode: "fullscreen",
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    enableAnalytics: false,
  }),
);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(PI_|TMUX|PSMUX_|NODE_OPTIONS$)/i.test(key) || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PROXY/i.test(key))
    delete env[key];
}
env.PI_OFFLINE = "1";
env.NODE_OPTIONS = `--import=${pathToFileURL(guard).href}`;
// No inherited TUI log can escape into a live session.
env.PI_CODING_AGENT_DIR = agent;
const source = SessionManager.create(workspace, sessions);
source.appendMessage({ role: "user", content: "SYNTHETIC_HISTORY", timestamp: Date.now() });
source.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "SYNTHETIC_HISTORY_DONE" }],
  api: "openai-responses",
  provider: "cost-pty-test",
  model: "synthetic",
  usage: {
    input: 100,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 101,
    cost: { input: 0.75, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.75 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});
const parentFile = source.getSessionFile();
const namespace = `pi-cost-${randomUUID().slice(0, 8)}`;
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
const capture = (pane) => mux("capture-pane", "-p", "-t", pane);
function save(name, pane) {
  writeFileSync(join(root, `${name}.txt`), capture(pane));
  writeFileSync(join(root, `${name}.ansi`), mux("capture-pane", "-p", "-e", "-t", pane));
}
function events() {
  let content;
  try {
    content = readFileSync(eventsFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return content
    .slice(0, content.lastIndexOf("\n") + 1)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
}
function state(file) {
  const manager = SessionManager.open(file, sessions, workspace);
  const entries = manager.getEntries();
  return {
    manager,
    entries,
    records: entries.map(costRecord).filter(Boolean),
    cost: project(entries, new Set(manager.getBranch().map((entry) => entry.id)), manager.getSessionId()),
  };
}
async function until(label, predicate) {
  const deadline = Date.now() + 30000;
  do {
    assert(!events().some((event) => event.type === "network-denied"), "unexpected network attempt");
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  throw new Error(label);
}
let input = 0;
async function submit(pane, text) {
  mux("send-keys", "-t", pane, "-l", text);
  await until("command visible in CLI editor", () => capture(pane).includes(text));
  save(`input-${++input}`, pane);
  mux("send-keys", "-t", pane, "Enter");
}
async function footer(pane, amount) {
  await until("compact cost footer visible", () => {
    const line = capture(pane).split("\n").at(-1);
    return line.includes(`$${amount.toFixed(2)}`) && line.includes("cost-pty-test synthetic");
  });
}
async function liveState(pane) {
  const count = events().filter((event) => event.type === "snapshot").length;
  await submit(pane, "/cost-test-state");
  await until(
    "live parent state observed",
    () => events().filter((event) => event.type === "snapshot").length === count + 1,
  );
  return events()
    .filter((event) => event.type === "snapshot")
    .at(-1);
}
async function popup(pane) {
  await submit(pane, "/cost");
  await until("cost graph visible", () => capture(pane).includes("Cumulative"));
  assert(capture(pane).includes("Estimated USD"));
}
async function picker(pane) {
  mux("send-keys", "-t", pane, "-l", "c");
  await until("checkpoint picker visible", () => capture(pane).includes("Enter inspect"));
}
async function close(pane) {
  mux("send-keys", "-t", pane, "Escape");
  await until(
    "cost popup closed",
    () => !capture(pane).includes("Esc close") && !capture(pane).includes("Enter inspect"),
  );
}
async function work(pane, file, prompt, total, footerCost) {
  const settled = events().filter((event) => event.type === "settled" && event.pane === pane).length;
  const starts = state(file).records.filter((record) => record.kind === "turn_start").length;
  await submit(pane, prompt);
  await until(
    "model completed and native metadata settled",
    () =>
      events().filter((event) => event.type === "settled" && event.pane === pane).length === settled + 1 &&
      state(file).records.filter((record) => record.kind === "turn_start").length === starts + 1 &&
      state(file).records.at(-1)?.status === "settled" &&
      capture(pane).includes(`${prompt}_DONE`),
  );
  const current = state(file);
  assert.equal(current.cost.total, total);
  assert.equal(current.cost.footerCost, footerCost);
  const activity = current.cost.activities.find((item) => item.excerpt === prompt);
  assert.equal(activity.provenance, "observed");
  assert.equal(activity.cost, prompt === "PARENT_FAUX_WORK" ? 0.25 : 0.5);
  const message = current.entries.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  ).message;
  assert.equal(message.stopReason, "stop");
  assert.equal(message.usage.cost.total, activity.cost);
  assert.equal(message.usage.totalTokens, 101);
  await footer(pane, current.cost.footerCost);
}
function launch(name) {
  mux(
    "-f",
    join(root, "mux.conf"),
    "new-session",
    "-d",
    "-s",
    name,
    "-n",
    "parent",
    "-x",
    "160",
    "-y",
    "42",
    "-c",
    workspace,
    launchCommand(
      ["--provider", "cost-pty-test", "--model", "synthetic", "--session", parentFile, "--session-dir", sessions],
      agent,
    ),
  );
}
let started = false;
try {
  assert.equal(state(parentFile).cost.total, 0.75);
  assert.equal(state(parentFile).cost.baseline, undefined);
  assert.deepEqual(state(parentFile).records, []);
  launch("initial");
  started = true;
  await until("initial CLI ready", () => events().filter((event) => event.type === "ready").length === 1);
  const first = events().find((event) => event.type === "ready");
  assert.equal(first.file, parentFile);
  assert.equal(first.cwd, workspace);
  assert.equal(first.mode, "tui");
  assert.equal(first.model, "synthetic");
  assert.deepEqual(first.tools, []);
  await until(
    "history and compact footer visible",
    () => capture(first.pane).includes("SYNTHETIC_HISTORY_DONE") && capture(first.pane).includes("$0.75"),
  );
  const anchor = state(parentFile).entries.at(-1).id;
  await submit(first.pane, "/cost mark TEST baseline");
  await until("named checkpoint persisted", () => state(parentFile).cost.checkpoints.length === 1);
  const checkpoint = state(parentFile).cost.checkpoints[0];
  assert.equal(checkpoint.name, "TEST baseline");
  assert.equal(checkpoint.afterEntryId, anchor);
  assert.equal(checkpoint.total, 0.75);
  assert.equal(checkpoint.owner, first.owner);
  assert.equal(state(parentFile).cost.baseline, undefined);
  const markedBytes = readFileSync(parentFile, "utf8");
  const markedLeaf = state(parentFile).manager.getLeafId();
  await popup(first.pane);
  assert.match(capture(first.pane), /Session \$0\.75/);
  assert.match(capture(first.pane), /#1\s+\$0\.75/);
  save("marked-graph", first.pane);
  await picker(first.pane);
  mux("send-keys", "-t", first.pane, "Down", "Enter");
  await until("checkpoint inspected", () => capture(first.pane).includes("Since TEST baseline: $0.00"));
  save("inspection", first.pane);
  assert.equal(readFileSync(parentFile, "utf8"), markedBytes, "inspection cannot append metadata");
  assert.equal(state(parentFile).manager.getLeafId(), markedLeaf);
  assert.equal(state(parentFile).cost.baseline, undefined);
  await picker(first.pane);
  mux("send-keys", "-t", first.pane, "Down", "f");
  await until(
    "explicit footer baseline persisted",
    () =>
      state(parentFile).cost.baseline?.id === checkpoint.id &&
      capture(first.pane).includes("Footer: $0.00 since TEST baseline"),
  );
  assert.equal(state(parentFile).records.filter((record) => record.kind === "footer").length, 1);
  save("selected-footer", first.pane);
  mux("send-keys", "-t", first.pane, "Escape");
  await until("back to inspected graph", () => capture(first.pane).includes("Since TEST baseline"));
  await close(first.pane);
  await footer(first.pane, 0);
  await work(first.pane, parentFile, "PARENT_FAUX_WORK", 1, 0.25);
  await popup(first.pane);
  assert.match(capture(first.pane), /Session \$1\.00/);
  assert.match(capture(first.pane), /#2\s+\$0\.25/);
  assert(capture(first.pane).includes("Footer: $0.25 since TEST baseline"));
  save("parent-work", first.pane);
  await close(first.pane);
  const persisted = readFileSync(parentFile, "utf8");
  await submit(first.pane, "/cost-test-quit");
  await until(
    "original CLI exits cleanly",
    () => mux("display-message", "-p", "-t", first.pane, "#{pane_dead}") === "1",
  );
  assert.equal(mux("display-message", "-p", "-t", first.pane, "#{pane_dead_status}"), "0");
  // Use an explicit new session after the closed parent buffer, never a live pane.
  launch("resumed");
  await until("resumed CLI ready", () => events().filter((event) => event.type === "ready").length === 2);
  const parent = events().filter((event) => event.type === "ready")[1];
  assert.equal(parent.file, parentFile);
  assert.equal(parent.owner, first.owner);
  assert.notEqual(parent.pid, first.pid);
  assert.equal(readFileSync(parentFile, "utf8"), persisted, "resume cannot rewrite settled cost state");
  assert.equal(state(parentFile).cost.baseline.id, checkpoint.id);
  assert.equal(state(parentFile).cost.footerCost, 0.25);
  await footer(parent.pane, 0.25);
  await popup(parent.pane);
  await until("resumed chosen footer visible", () =>
    capture(parent.pane).includes("Footer: $0.25 since TEST baseline"),
  );
  save("resumed", parent.pane);
  await close(parent.pane);
  const liveBefore = await liveState(parent.pane);
  const before = state(parentFile);
  assert.equal(liveBefore.leaf, before.manager.getLeafId());
  assert.deepEqual(liveBefore.cost, JSON.parse(JSON.stringify(before.cost)));
  const parentBytes = readFileSync(parentFile, "utf8");
  const parentLeaf = before.manager.getLeafId();
  await submit(parent.pane, "/tangent TEST child");
  await until("tangent CLI ready", () => events().filter((event) => event.type === "ready").length === 3);
  const child = events().filter((event) => event.type === "ready")[2];
  assert.notEqual(child.file, parentFile);
  assert.notEqual(child.pane, parent.pane);
  assert.notEqual(child.owner, parent.owner);
  assert.equal(child.cwd, workspace);
  assert.deepEqual(child.tools, []);
  assert.equal(
    mux("display-message", "-p", "-t", child.pane, "#{window_id}"),
    mux("display-message", "-p", "-t", parent.pane, "#{window_id}"),
  );
  const fresh = state(child.file);
  assert.equal(fresh.manager.getHeader().parentSession, parentFile);
  assert.equal(fresh.manager.getSessionName(), "TEST child");
  assert.equal(fresh.cost.total, 1);
  assert.equal(fresh.cost.footerCost, 0);
  assert.equal(fresh.cost.checkpoints.length, 1, "foreign copied checkpoints are ignored");
  assert.equal(fresh.cost.baseline.owner, child.owner);
  assert.equal(fresh.cost.baseline.name, "TEST child");
  assert.notEqual(fresh.cost.baseline.id, checkpoint.id);
  assert.equal(fresh.cost.baseline.total, 1);
  const marker = fresh.entries.findIndex((entry) => costRecord(entry)?.id === fresh.cost.baseline.id);
  assert(marker > 0);
  assert.equal(fresh.cost.baseline.afterEntryId, fresh.entries[marker - 1].id);
  assert.equal(readFileSync(parentFile, "utf8"), parentBytes);
  assert(fresh.records.some((record) => record.kind === "checkpoint" && record.owner === parent.owner));
  assert.equal(fresh.records.findLast((record) => record.kind === "footer").owner, child.owner);
  assert.equal(
    events().filter((event) => event.type === "request").length,
    1,
    "mark, inspect, resume and tangent never call the model",
  );
  await footer(child.pane, 0);
  await popup(child.pane);
  await until("child zero baseline visible", () => capture(child.pane).includes("Footer: $0.00 since TEST child"));
  save("child-zero", child.pane);
  await picker(child.pane);
  assert(!capture(child.pane).includes("TEST baseline"), "parent checkpoint must not enter child picker");
  save("child-checkpoints", child.pane);
  mux("send-keys", "-t", child.pane, "Escape");
  await until("child graph restored", () => capture(child.pane).includes("Cumulative"));
  await close(child.pane);
  await work(child.pane, child.file, "CHILD_FAUX_WORK", 1.5, 0.5);
  await popup(child.pane);
  assert.match(capture(child.pane), /Session \$1\.50/);
  assert.match(capture(child.pane), /#3\s+\$0\.50/);
  assert(capture(child.pane).includes("Footer: $0.50 since TEST child"));
  save("child-work", child.pane);
  const liveAfter = await liveState(parent.pane);
  assert.equal(liveAfter.leaf, liveBefore.leaf);
  assert.deepEqual(liveAfter.cost, liveBefore.cost);
  save("parent-unchanged", parent.pane);
  const after = state(parentFile);
  assert.equal(readFileSync(parentFile, "utf8"), parentBytes);
  assert.equal(after.manager.getLeafId(), parentLeaf);
  assert.deepEqual(after.cost, before.cost);
  assert.deepEqual(after.records, before.records);
  assert(!capture(parent.pane).includes("CHILD_FAUX_WORK_DONE"));
  assert.deepEqual(
    events()
      .filter((event) => event.type === "request")
      .map((event) => [event.prompt, event.cost]),
    [
      ["PARENT_FAUX_WORK", 0.25],
      ["CHILD_FAUX_WORK", 0.5],
    ],
  );
  assert(!events().some((event) => event.type === "settled" && event.aborted));
  assert(!events().some((event) => event.type === "network-denied"));
  for (const ready of events().filter((event) => event.type === "ready")) {
    assert.equal(ready.guard, env.NODE_OPTIONS);
    assert(isolation.every((flag) => ready.argv.includes(flag)));
  }
  console.log(
    `PASS: native CLI /cost mark, read-only inspection, explicit footer, synthetic charges, persisted resume and isolated /tangent accounting.\nArtifacts: ${root}`,
  );
} catch (error) {
  console.error(`Cost PTY failure. Artifacts: ${root}`);
  if (started) {
    for (const pane of mux("list-panes", "-a", "-F", "#{pane_id}").split(/\r?\n/))
      save(`failure-${pane.replace(/\W/g, "")}`, pane);
  }
  throw error;
} finally {
  if (started) mux("kill-server");
}
