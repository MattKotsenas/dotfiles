import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, modelRuntime, root, SM, sdk } from "./offline.mjs";

const base = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const rows = (file) => readFileSync(file, "utf8").trimEnd().split("\n").map(JSON.parse);
export const user = (sm, text) => sm.appendMessage({ role: "user", content: text, timestamp: Date.now() });
export const selection = (h) => ({
  model: h.runtime.session.model.id,
  thinking: h.runtime.session.thinkingLevel,
});
export async function choose(h, id = "right", thinking = "high") {
  await h.runtime.session.setModel(modelRuntime.getModel("study", id));
  h.runtime.session.setThinkingLevel(thinking);
  assert.deepEqual(selection(h), { model: id, thinking });
}
export function directories(name) {
  const dirs = Object.fromEntries(
    ["A", "B with spaces", "C", "D", "E"].map((label, i) => ["ABCDE"[i], join(root, name, label)]),
  );
  for (const [mark, dir] of Object.entries(dirs)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marker.txt"), `MARKER_${mark}`);
    writeFileSync(join(dir, "AGENTS.md"), `CONTEXT_${mark}`);
  }
  return dirs;
}
export function durable(cwd, customOnly = false) {
  const sm = SM.create(cwd),
    file = sm.getSessionFile();
  writeFileSync(file, "");
  sm.setSessionFile(file);
  if (customOnly) sm.appendCustomEntry("valuable", { value: "KEEP" });
  return sm;
}
export async function host(dirs, control = {}, manager = SM.create(dirs.A)) {
  const errors = [],
    notes = [],
    starts = [],
    temporaryPaths = [],
    shutdownIds = [];
  let ctx,
    captured,
    before = 0,
    ordinal = -1;
  const plugin = process.env.WORKSPACE_TEST_PLUGIN ?? join(base, "agent", "extensions", "workspace", "index.ts");
  const extensionPaths = control.extensionPaths ?? [plugin];
  process.chdir(dirs.A);
  const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const n = ++ordinal,
      temporary = sessionStartEvent?.reason === "new";
    if (control.failAt === n) throw new Error(`INJECTED_FACTORY_${n}`);
    const observer = (pi) => {
      pi.registerCommand("capture", {
        handler: async (_args, current) => {
          captured = current;
        },
      });
      pi.registerCommand("test-reload", {
        handler: async (_args, current) => {
          await current.reload();
        },
      });
      pi.registerCommand("test-tree", {
        handler: async (args, current) => {
          await current.navigateTree(args, { summarize: false });
        },
      });
      pi.on("session_start", (_event, current) => {
        const commands = pi.getCommands();
        assert.equal(commands.filter((command) => command.name === "cd").length, 1, "one plain /cd command");
        assert(
          !commands.some((command) => command.name === "workspace" || command.name.startsWith("cd:")),
          "no legacy or suffixed aliases",
        );
        ctx = current;
        starts.push({ cwd, id: sessionManager.getSessionId(), commands });
        if (temporary && control.persistTemporary) {
          temporaryPaths.push(sessionManager.getSessionFile());
          user(sessionManager, "TEMPORARY");
        }
      });
      pi.on("session_before_switch", () => {
        if (++before === control.cancelAt) return { cancel: true };
      });
      // This observer loads after the real extension. Its writes must be present
      // before the continuation checkpoint, including a message-free custom tail.
      pi.on("session_shutdown", (event) => {
        if (event.reason === "quit" || event.reason === "reload") return;
        if (control.shutdown && !temporary) shutdownIds.push(sessionManager.appendCustomEntry("late-shutdown", { n }));
        if (temporary && control.persistTemporary) sessionManager.appendCustomEntry("temporary-tail", { final: true });
        if (control.lateCollision && !temporary) {
          const target = join(SM.create(dirs.B).getSessionDir(), sessionManager.getSessionFile().split(/[\\/]/).at(-1));
          writeFileSync(target, "COLLISION");
          control.collisionPath = target;
        }
      });
    };
    const settingsManager = sdk.SettingsManager.inMemory({
      extensions: extensionPaths,
      defaultProvider: "study",
      defaultModel: "left",
      defaultThinkingLevel: "low",
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    settingsManager.setProjectTrusted(false);
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        extensionFactories: [observer],
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
      },
    });
    const loaded = services.resourceLoader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(
      loaded.extensions
        .filter((extension) => extensionPaths.some((path) => resolve(path) === resolve(extension.path)))
        .map((extension) => resolve(extension.path)),
      extensionPaths.map((path) => resolve(path)),
      "requested extensions must load in order through the real resource loader",
    );
    return {
      ...(await sdk.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: ["read"],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await sdk.createAgentSessionRuntime(factory, {
    cwd: manager.getCwd(),
    agentDir,
    sessionManager: manager,
  });
  const bind = () =>
    runtime.session.bindExtensions({
      mode: control.mode ?? "tui",
      uiContext: {
        ...control.uiContext,
        notify: (text, type) => notes.push({ text, type }),
        select: async (text, options) => {
          assert.deepEqual(options, ["Cancel", "Move anyway"]);
          notes.push({ text, options });
          return control.answer;
        },
      },
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        switchSession: (file, options) => runtime.switchSession(file, options),
        navigateTree: (id, options) => runtime.session.navigateTree(id, options),
        reload: () => runtime.session.reload(),
      },
      onError: (error) => {
        errors.push(String(error.error));
      },
    });
  runtime.setRebindSession(bind);
  try {
    await bind();
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  return {
    runtime,
    dirs,
    errors,
    notes,
    starts,
    temporaryPaths,
    shutdownIds,
    get ctx() {
      return ctx;
    },
    capture: async () => {
      await runtime.session.prompt("/capture");
      return captured;
    },
    move: async (dest) => runtime.session.prompt(`/cd "${dest}"`),
  };
}
export async function workspace(h, mark, id) {
  const cwd = h.dirs[mark],
    sm = h.runtime.session.sessionManager,
    file = sm.getSessionFile();
  assert.equal(h.runtime.cwd, cwd);
  assert.equal(h.ctx.cwd, cwd);
  assert.equal(sm.getCwd(), cwd);
  if (!h.noChdir) assert.equal(process.cwd(), cwd);
  const tool = h.runtime.session.agent.state.tools.find((tool) => tool.name === "read");
  const result = await tool.execute("relative-read", { path: "marker.txt" }, new AbortController().signal);
  assert.equal(result.content.map((x) => x.text ?? "").join(""), `MARKER_${mark}`);
  assert(h.runtime.session.systemPrompt.includes(`CONTEXT_${mark}`));
  for (const other of "ABCDE".replace(mark, "")) assert(!h.runtime.session.systemPrompt.includes(`CONTEXT_${other}`));
  if (id) {
    assert.equal(sm.getSessionId(), id);
    assert.equal(SM.findById(cwd, id), file);
    assert.equal(SM.continueRecent(cwd).getSessionId(), id);
    assert.equal((await SM.list(cwd)).filter((s) => s.id === id).length, 1);
    assert.equal((await SM.listAll()).filter((s) => s.id === id).length, 1);
    assert.equal(rows(file)[0].cwd, cwd);
    assert(existsSync(file));
  }
  assert.deepEqual(h.errors, []);
  return file;
}
