import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import tangent, { launchCommand } from "../agent/extensions/tangent.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-tangent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  process.env.TMUX = "/tmp/test-server,123,0";
  process.env.TMUX_PANE = "%42";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const manager = SessionManager.create(root, root);
  manager.appendMessage({ role: "user", content: "Original question", timestamp: 1 });
  const selected = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Original answer" }],
    api: "openai-responses",
    provider: "test",
    model: "old",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  manager.appendMessage({ role: "user", content: "Abandoned question", timestamp: 3 });
  manager.branch(selected);
  const calls = [];
  const notifications = [];
  let handler;
  const pi = {
    registerCommand(name, spec) {
      assert.equal(name, "tangent");
      handler = spec.handler;
    },
    getThinkingLevel: () => "high",
    getActiveTools: () => ["read", "codemode"],
    async exec(command, args) {
      assert.equal(command, "tmux");
      assert.deepEqual(args.slice(0, 2), ["-S", "/tmp/test-server"]);
      args = args.slice(2);
      calls.push(args);
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  const ctx = {
    cwd: root,
    mode: "tui",
    sessionManager: manager,
    model: { provider: "test", id: "current" },
    waitForIdle: async () => {},
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  };
  tangent(pi);
  return { root, pi, ctx, calls, notifications, manager, selected, run: (name = "") => handler(name, ctx) };
}

function commandText(command) {
  const encoded = /^pwsh -NoLogo -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
  return encoded ? Buffer.from(encoded[1], "base64").toString("utf16le") : command;
}

test("forks the selected branch beside the originating pane without changing the parent", async (t) => {
  const f = await fixture(t);
  const source = f.manager.getSessionFile();
  const before = await readFile(source, "utf8");
  assert.equal((await readdir(f.root)).length, 1);
  assert.equal(f.manager.getLeafId(), f.selected);
  await f.run("An O'Brien  tangent 日本語");
  assert.equal(f.calls.length, 1);
  const [operation, ...args] = f.calls[0];
  assert.equal(operation, "split-window");
  assert.deepEqual(args.slice(0, 5), ["-h", "-t", "%42", "-c", f.root]);
  assert(commandText(args.at(-1)).includes("--name"));
  const files = (await readdir(f.root)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 2);
  const child = SessionManager.open(
    join(
      f.root,
      files.find((name) => join(f.root, name) !== source),
    ),
    f.root,
  );
  assert.notEqual(child.getSessionId(), f.manager.getSessionId());
  assert.equal(child.getHeader().parentSession, source);
  assert.equal(child.getLeafId(), f.selected);
  assert.deepEqual(
    child.getBranch().map((entry) => entry.id),
    f.manager.getBranch().map((entry) => entry.id),
  );
  assert(
    !child.getBranch().some((entry) => entry.type === "message" && entry.message.content === "Abandoned question"),
  );
  assert.equal(await readFile(source, "utf8"), before);
  assert.equal(f.manager.getLeafId(), f.selected);
  const command = commandText(args.at(-1));
  assert(command.includes(child.getSessionFile()));
  for (const value of [
    "--session-dir",
    f.root,
    "--provider",
    "test",
    "--model",
    "current",
    "--thinking",
    "high",
    "read,codemode",
    "PI_CODING_AGENT_DIR",
  ]) {
    assert(command.includes(value), value);
  }
  assert.equal(f.notifications.at(-1).type, "info");
});

test("a resumed conversation retains its replacement working directory", async (t) => {
  const f = await fixture(t);
  const runtimeCwd = join(f.root, "relocated-project");
  await mkdir(runtimeCwd);
  const source = f.manager.getSessionFile();
  const before = await readFile(source, "utf8");
  assert.notEqual(f.manager.getHeader().cwd, runtimeCwd);
  f.ctx.sessionManager = SessionManager.open(source, f.root, runtimeCwd);
  f.ctx.sessionManager.branch(f.selected);
  f.ctx.cwd = runtimeCwd;
  await f.run();
  const files = (await readdir(f.root)).filter((name) => name.endsWith(".jsonl") && join(f.root, name) !== source);
  assert.equal(files.length, 1);
  const child = SessionManager.open(join(f.root, files[0]), f.root);
  assert.equal(child.getCwd(), runtimeCwd);
  assert.equal(child.getHeader().cwd, runtimeCwd);
  assert.equal(await readFile(source, "utf8"), before);
});

test("waits for idle before reading the branch or launching anything", async (t) => {
  const f = await fixture(t);
  let release;
  f.ctx.waitForIdle = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = f.run();
  await Promise.resolve();
  assert.equal(f.calls.length, 0);
  assert.equal((await readdir(f.root)).length, 1);
  release();
  await pending;
  assert.equal(f.calls.length, 1);
  assert(commandText(f.calls[0].at(-1)).includes("tangent"));
});

for (const invalid of ["not-tui", "no-tmux", "no-pane", "ephemeral", "empty"]) {
  test(`${invalid} reports a problem without creating a pane or session`, async (t) => {
    const f = await fixture(t);
    if (invalid === "not-tui") f.ctx.mode = "print";
    if (invalid === "no-tmux") delete process.env.TMUX;
    if (invalid === "no-pane") delete process.env.TMUX_PANE;
    if (invalid === "ephemeral") f.ctx.sessionManager = SessionManager.inMemory(f.root);
    if (invalid === "empty") f.ctx.sessionManager = SessionManager.create(f.root, f.root);
    const files = await readdir(f.root);
    await f.run();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await readdir(f.root), files);
    assert.equal(f.notifications.at(-1).type, "error");
  });
}

for (const failure of ["launch", "missing-executable"]) {
  test(`${failure} leaves no orphan fork and reports diagnostics`, async (t) => {
    const f = await fixture(t);
    const source = await readFile(f.manager.getSessionFile(), "utf8");
    f.pi.exec = async () => {
      if (failure === "missing-executable") throw new Error("spawn tmux ENOENT");
      return { code: 1, stdout: "", stderr: "isolated failure", killed: false };
    };
    await f.run();
    assert.equal((await readdir(f.root)).length, 1);
    assert.equal(await readFile(f.manager.getSessionFile(), "utf8"), source);
    assert.equal(f.notifications.at(-1).type, "error");
    assert.match(f.notifications.at(-1).message, /isolated failure|ENOENT/);
  });
}

test("an empty active tool selection remains empty in the child", async (t) => {
  const f = await fixture(t);
  f.pi.getActiveTools = () => [];
  await f.run();
  assert(commandText(f.calls[0].at(-1)).includes("--no-tools"));
});

const tricky = [
  "--session",
  "C:\\Example  User\\O'Brien\\日本語.jsonl",
  "--name",
  'a; $(echo injected) `whoami` "quoted"\nnext',
  "O‘Brien O’Brien O‚Brien O‛Brien",
  "x’; Write-Output INJECTED; #",
];

test("POSIX command preserves whitespace, quotes, and shell metacharacters", () => {
  const script = launchCommand(tricky, "/an agent directory", "linux");
  const probe = `pi() { printf '%s\\0' "$@"; }; ${script}`;
  const actual = execFileSync("bash", ["-c", probe], { encoding: "utf8" });
  assert.deepEqual(actual.split("\0").slice(0, -1), tricky);
});

if (process.platform === "win32") {
  test("encoded PowerShell command preserves arguments without executing their contents", () => {
    const script = commandText(launchCommand(tricky, "C:\\An  Agent's Directory", "win32"));
    const probe = `function pi { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject @($args)))) }; ${script}`;
    const actual = execFileSync(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(Buffer.from(actual.trim(), "base64").toString("utf8")), tricky);
  });
}
