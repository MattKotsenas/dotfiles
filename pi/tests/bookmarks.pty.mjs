import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { saveBookmark } from "../agent/extensions/bookmarks/store.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "pi-bookmarks-pty-"));
const agent = join(root, "agent");
mkdirSync(join(agent, "extensions"), { recursive: true });
symlinkSync(join(repo, "pi/node_modules"), join(root, "node_modules"), "junction");
const eventsFile = join(root, "events.jsonl");
const source = SessionManager.create(root, join(root, "sessions"));
const message = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "bookmarks-test",
  model: "fixture",
  api: "openai-responses",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
source.appendMessage({ role: "user", content: "Earlier question", timestamp: Date.now() });
const olderText = `SAVED_OLDER_ANSWER\n${Array.from({ length: 40 }, (_, i) => `Older detail ${i}`).join("\n")}`;
const older = source.appendMessage(message(olderText));
source.appendMessage({ role: "user", content: "Latest question", timestamp: Date.now() });
source.appendMessage(message("CURRENT_LATEST_ANSWER"));
await saveBookmark(join(agent, "bookmarks"), {
  kind: "less",
  note: `Earlier example ${"long note ".repeat(20)}`,
  response: olderText,
  source: { sessionFile: source.getSessionFile(), sessionId: source.getSessionId(), entryId: older, cwd: root },
});
const extension = join(repo, "pi/agent/extensions/bookmarks/index.ts");
writeFileSync(
  join(agent, "extensions", "observer.ts"),
  `
import { appendFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
export default function(pi) {
 const emit = event => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event)+String.fromCharCode(10));
 const fake = fauxProvider({provider:"bookmarks-test",models:[{id:"fixture"}],tokensPerSecond:0});
 pi.registerProvider({...fake.provider, streamSimple() { emit({type:"request"}); throw new Error("Unexpected model request"); }});
 pi.on("session_start",()=>emit({type:"ready"}));
 pi.on("session_tree",(event,ctx)=>emit({type:"tree",leaf:ctx.sessionManager.getLeafId()}));
}
`,
);
writeFileSync(
  join(agent, "settings.json"),
  JSON.stringify({
    extensions: [extension],
    defaultProvider: "bookmarks-test",
    defaultModel: "fixture",
    quietStartup: true,
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
    tuiMode: "fullscreen",
  }),
);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
writeFileSync(
  join(root, "launch.ps1"),
  `
$env:PI_CODING_AGENT_DIR = ${quote(agent)}
$env:PI_OFFLINE = '1'
Remove-Item Env:PI_SESSION_FILE, Env:PI_SESSION_ID -ErrorAction SilentlyContinue
Set-Location ${quote(root)}
& pi --offline --no-mcp --no-context-files --no-skills --no-prompt-templates --no-tools --session ${quote(source.getSessionFile())} 2> ${quote(join(root, "stderr.txt"))}
`,
);
writeFileSync(join(root, "psmux.conf"), "set -g status off\nset -g escape-time 10\n");
const namespace = `pi-bookmarks-${randomUUID().slice(0, 8)}`;
const target = "acceptance:0.0";
function mux(...args) {
  const result = spawnSync("psmux", ["-L", namespace, ...args], { encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const screen = () => mux("capture-pane", "-p", "-t", target);
const events = () => {
  try {
    return readFileSync(eventsFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};
async function until(label, predicate) {
  const deadline = Date.now() + 20000;
  do {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label}\n${screen()}\nArtifacts: ${root}`);
}
function submit(text) {
  mux("send-keys", "-t", target, "-l", text);
  mux("send-keys", "-t", target, "Enter");
}
async function actions() {
  submit("/bookmarks");
  await until("bookmark collection", () => screen().includes("Earlier example"));
  mux("send-keys", "-t", target, "Enter");
  await until("bookmark actions", () => screen().includes("View saved response"));
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
    "-x",
    "100",
    "-y",
    "32",
    "--",
    "pwsh",
    "-NoLogo",
    "-NoProfile",
    "-File",
    join(root, "launch.ps1"),
  );
  started = true;
  await until(
    "Pi starts",
    () => events().some((e) => e.type === "ready") && screen().includes("CURRENT_LATEST_ANSWER"),
  );
  writeFileSync(join(root, "startup.txt"), screen());
  await actions();
  mux("send-keys", "-t", target, "Enter");
  await until("saved older response is visible", () => screen().includes("SAVED_OLDER_ANSWER"));
  assert(screen().includes("Saved response"));
  assert(
    !screen().includes("CURRENT_LATEST_ANSWER"),
    "the saved response view must be distinct from the current answer",
  );
  writeFileSync(join(root, "snapshot.txt"), screen());
  mux("resize-window", "-t", "acceptance", "-x", "30", "-y", "10");
  await until(
    "small overlay keeps response and close hint visible",
    () => screen().includes("SAVED_OLDER_ANSWER") && screen().includes("Esc close"),
  );
  writeFileSync(join(root, "small-snapshot.txt"), screen());
  mux("resize-window", "-t", "acceptance", "-x", "100", "-y", "32");
  await until("overlay expands again", () => screen().includes("Older detail 0"));
  mux("send-keys", "-t", target, "Escape");
  await until("snapshot closed", () => !screen().includes("Saved response"));
  await actions();
  mux("send-keys", "-t", target, "Down", "Enter");
  await until("source navigation", () => events().some((e) => e.type === "tree" && e.leaf === older));
  await until(
    "older branch shown",
    () => screen().includes("Older detail 39") && !screen().includes("CURRENT_LATEST_ANSWER"),
  );
  writeFileSync(join(root, "source.txt"), screen());
  await until("navigation identifies the saved response", () => screen().includes("Resumed from: SAVED_OLDER_ANSWER"));
  assert.equal(events().filter((e) => e.type === "request").length, 0);
  console.log(
    `PASS: real terminal displays an older snapshot and navigates to its original branch.\nArtifacts: ${root}`,
  );
} finally {
  if (started) mux("kill-session", "-t", "acceptance");
}
