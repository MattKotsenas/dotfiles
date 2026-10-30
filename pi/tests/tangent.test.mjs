import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import tangent, { launchCommand } from "../agent/extensions/tangent.ts";
import { project } from "../agent/extensions/cost/ledger.ts";
import { COST_ENTRY, checkpointRecord, costRecord, footerRecord } from "../agent/extensions/cost/model.ts";

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
  assert.equal(
    child
      .getBranch()
      .filter((entry) => !costRecord(entry))
      .at(-1).id,
    f.selected,
  );
  assert.deepEqual(
    child
      .getBranch()
      .filter((entry) => !costRecord(entry))
      .map((entry) => entry.id),
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
    "PI_CODING_AGENT_DIR",
  ]) {
    assert(command.includes(value), value);
  }
  assert.equal(f.notifications.at(-1).type, "info");
});

test("tangent baselines exclude inherited spending, survive tree navigation, and reset independently when nested", async (t) => {
  const f = await fixture(t);
  const usage = (total) => ({
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
  });
  const state = (manager) =>
    project(manager.getEntries(), new Set(manager.getBranch().map((entry) => entry.id)), manager.getSessionId());
  f.manager.appendUsage("parent", "test", "old", usage(2));
  const inherited = checkpointRecord(f.manager.getSessionId(), "Parent point", f.manager.getEntries().at(-1).id);
  f.manager.appendCustomEntry(COST_ENTRY, inherited);
  f.manager.appendCustomEntry(COST_ENTRY, footerRecord(f.manager.getSessionId(), inherited.id));
  assert.equal(state(f.manager).total, 2);
  assert.equal(state(f.manager).footerCost, 0);
  const source = f.manager.getSessionFile();
  const before = await readFile(source, "utf8");
  const parentLeaf = f.manager.getLeafId();
  await f.run("Child baseline");
  const childPath = (await readdir(f.root)).map((name) => join(f.root, name)).find((path) => path !== source);
  const child = SessionManager.open(childPath, f.root);
  assert.equal(state(child).total, 2);
  assert.equal(state(child).footerCost, 0);
  assert.equal(state(child).checkpoints.length, 1, "parent checkpoint is copied but not owned by child");
  assert.equal(state(child).baseline.name, "Child baseline");
  assert.equal(state(child).baseline.owner, child.getSessionId());
  assert(
    child
      .getEntries()
      .map(costRecord)
      .some((entry) => entry?.id === inherited.id),
  );
  child.branch(f.selected);
  child.appendUsage("cache_warm", "test", "current", usage(4));
  assert.equal(state(child).footerCost, 4);
  assert.equal(state(child).total, 6);
  const childBefore = await readFile(childPath, "utf8");
  const filesBefore = new Set(await readdir(f.root));
  f.ctx.sessionManager = child;
  await f.run("Nested baseline");
  const nestedPath = join(
    f.root,
    (await readdir(f.root)).find((name) => !filesBefore.has(name)),
  );
  const nested = SessionManager.open(nestedPath, f.root);
  assert.equal(nested.getHeader().parentSession, childPath);
  assert.equal(state(nested).total, 4, "only the selected child path is inherited");
  assert.equal(state(nested).footerCost, 0);
  assert.equal(state(nested).baseline.owner, nested.getSessionId());
  assert.equal(state(nested).baseline.name, "Nested baseline");
  assert.equal(await readFile(source, "utf8"), before);
  assert.equal(await readFile(childPath, "utf8"), childBefore);
  assert.equal(f.manager.getLeafId(), parentLeaf);
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

for (const options of [{ tools: ["read"] }, { noTools: "all" }]) {
  test(`tangent starts with the default toolset independent of parent overrides ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t);
    const agentDir = join(f.root, "agent");
    await mkdir(agentDir);
    const configured = ["read", "codemode"];
    const settingsManager = SettingsManager.inMemory({ defaultTools: configured, cacheWarming: "off" });
    const fake = fauxProvider({ provider: "tangent-test", models: [{ id: "fixture" }], tokensPerSecond: 0 });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: f.root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [
        createCodemodeExtension({ models: false }),
        tangent,
        (pi) => {
          pi.registerProvider(fake.provider);
          for (const [name, exposure] of [
            ["delegate", "codemode"],
            ["lookup", "deferred"],
            ["inactive", "direct"],
          ]) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              exposure,
              defaultActive: false,
              parameters: { type: "object", properties: {} },
              execute: async () => ({ content: [{ type: "text", text: `${name}-ok` }] }),
            });
          }
        },
      ],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const open = async (overrides = {}) => {
      const { session } = await createAgentSession({
        cwd: f.root,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoader,
        sessionManager: SessionManager.inMemory(f.root),
        ...overrides,
      });
      t.after(() => session.dispose());
      await session.bindExtensions({
        mode: "print",
        onError: (error) => {
          throw new Error(error.error);
        },
      });
      return session;
    };
    const parent = await open(options);
    assert.deepEqual(parent.getActiveToolNames(), options.tools ?? []);
    assert.deepEqual(parent.getCallableToolNames(), options.tools ?? []);
    assert.notDeepEqual(parent.getActiveToolNames(), configured, "the parent differs from configuration");
    f.pi.getActiveTools = () => parent.getActiveToolNames();
    await f.run();
    assert.equal(f.calls.length, 1, JSON.stringify(f.notifications));
    const command = commandText(f.calls[0].at(-1));
    const list = /'--tools' '([^']+)'/.exec(command)?.[1];
    const child = await open(
      list ? { tools: list.split(",") } : command.includes("'--no-tools'") ? { noTools: "all" } : {},
    );
    assert.deepEqual(child.getActiveToolNames(), configured);
    assert.deepEqual(child.getCallableToolNames(), ["read", "delegate", "lookup"]);
    fake.setResponses([
      fauxAssistantMessage(
        fauxToolCall("codemode", { code: "text(await tools.delegate({})); text(await tools.lookup({}));" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Done"),
    ]);
    await child.setModel(modelRuntime.getModel("tangent-test", "fixture"));
    await child.prompt("Exercise both callable tools.");
    const result = child.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert(result, "the scripted provider must call real codemode");
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const output = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.match(output, /delegate-ok/);
    assert.match(output, /lookup-ok/);
  });
}

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
