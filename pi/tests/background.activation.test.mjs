import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Match the installer: a real directory containing per-file links, not a copied entrypoint.
test("background autoload, codemode-only defaults, and native rollback", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-background-activation-"));
  let runtime;
  let unsubscribe;
  t.after(async () => {
    unsubscribe?.();
    await runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const linked = path.join(agentDir, "extensions", "background");
  await mkdir(linked, { recursive: true });
  await mkdir(cwd);
  const source = fileURLToPath(new URL("../agent/extensions/background", import.meta.url));
  for (const name of await readdir(source)) await symlink(path.join(source, name), path.join(linked, name), "file");
  const marker = path.join(cwd, "marker.txt");
  await writeFile(marker, "activation marker");
  const defaults = JSON.parse(await readFile(new URL("../agent/settings.json", import.meta.url), "utf8"));
  const settingsManager = SettingsManager.inMemory({
    defaultTools: defaults.defaultTools,
    codemode: defaults.codemode,
    shellPath:
      process.env.PI_BACKGROUND_TEST_SHELL ??
      (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : undefined),
    retry: { enabled: false },
    compaction: { enabled: false },
    cacheWarming: "off",
  });
  const faux = fauxProvider({ provider: "activation-test", models: [{ id: "offline" }], tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime = await createAgentSessionRuntime(
    async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          disabledBuiltinExtensions: ["mcp", "llama.cpp", "tool-search"],
          noSkills: true,
          noThemes: true,
          noPromptTemplates: true,
          noContextFiles: true,
          systemPrompt: "Execute only the scripted offline test calls.",
          extensionFactories: [(pi) => pi.registerProvider(faux.provider), createCodemodeExtension()],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      assert.deepEqual(services.diagnostics, []);
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: faux.getModel(),
          thinkingLevel: "off",
        })),
        services,
        diagnostics: services.diagnostics,
      };
    },
    { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
  );
  const session = runtime.session;
  const errors = [];
  await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
  const ends = [];
  unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end") ends.push(event);
  });
  let sequence = 0;
  async function run(code) {
    const visible = [];
    const id = `activation-${++sequence}`;
    faux.setResponses([
      (context) => {
        visible.push(...getCurrentTools(context.messages).map((tool) => tool.name));
        return fauxAssistantMessage(fauxToolCall("codemode", { code }, { id }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Checked."),
    ]);
    await session.prompt("Run the scripted activation check.");
    const end = ends.find((event) => event.toolCallId === id);
    assert(end, `codemode must actually execute: ${JSON.stringify(session.messages.at(-1))}`);
    assert.equal(end.isError, false, JSON.stringify(end.result));
    const value = end.result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return { visible: visible.sort(), value };
  }
  await t.test("autoload wraps bash and exposes only codemode while nested tools work", async () => {
    assert(
      session.getAllTools().some((tool) => tool.name === "bg_run"),
      "precondition: background was discovered",
    );
    assert(
      !session
        .getAllTools()
        .find((tool) => tool.name === "bash")
        .sourceInfo.path.startsWith("builtin:"),
      "precondition: bash is wrapped",
    );
    const { visible, value } = await run(
      `text(await tools.read({path:${JSON.stringify(marker)}})); text(await tools.bash({command:"printf activation-ok",timeout:1})); text(await tools.bg_status({}));`,
    );
    assert.match(value, /activation marker/);
    assert.match(value, /activation-ok/);
    assert.match(value, /"exit_code":0/);
    assert.match(value, /"jobs":\[\]/);
    assert.deepEqual(visible, ["codemode"]);
  });
  await t.test("native exclusion survives reload and restores built-in bash", async () => {
    assert(
      session.getAllTools().some((tool) => tool.name === "bg_run"),
      "precondition: extension is enabled",
    );
    settingsManager.setExtensionPaths(["-extensions/background/index.ts"]);
    await session.reload();
    assert(!session.getAllTools().some((tool) => tool.name.startsWith("bg_")));
    assert(
      session
        .getAllTools()
        .find((tool) => tool.name === "bash")
        .sourceInfo.path.startsWith("builtin:"),
    );
    const { value } = await run('text(await tools.bash({command:"printf native-ok",timeout:1}));');
    assert.match(value, /native-ok/);
    assert.match(value, /"exit_code":0/);
  });
  await t.test("removing the exclusion reloads background", async () => {
    assert(!session.getAllTools().some((tool) => tool.name === "bg_run"), "precondition: extension is disabled");
    settingsManager.setExtensionPaths([]);
    await session.reload();
    assert(session.getAllTools().some((tool) => tool.name === "bg_run"));
    const { value } = await run("text(await tools.bg_status({}));");
    assert.match(value, /"jobs":\[\]/);
  });
  assert.deepEqual(errors, [], "no extension runtime errors");
});
