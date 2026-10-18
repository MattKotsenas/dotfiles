import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sdk } from "./sdk.mjs";
import { modelId, providerId } from "./provider.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../../agent/extensions/delegation/index.ts");
const text = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

export async function fixture(t, { systemPrompt = "Execute the supplied codemode script.", tools } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-delegation-acceptance-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  // node:test runs this file in its own process; the suite explicitly runs cases serially.
  const variables = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SESSION_FILE", "PI_SESSION_ID"];
  const previous = variables.map((key) => [key, process.env[key]]);
  let parent;
  t.after(async () => {
    try {
      if (parent) {
        await parent.abort();
        try { await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
        finally { parent.dispose(); }
      }
      await rm(root, { recursive: true, force: true });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  delete process.env.PI_SESSION_FILE;
  delete process.env.PI_SESSION_ID;
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd);
  const key = `synthetic-${randomUUID()}`;
  const authPath = join(agentDir, "auth.json");
  const expectedKeyPath = join(agentDir, "expected-key");
  const fileContents = `payload-${randomUUID()}`;
  await writeFile(join(cwd, "note.txt"), fileContents);
  await writeFile(authPath, JSON.stringify({ [providerId]: { type: "api_key", key } }));
  await writeFile(expectedKeyPath, key);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    extensions: [entry], defaultTools: ["codemode"], compaction: { enabled: false },
    retry: { enabled: false }, cacheWarming: "off",
  }));
  await writeFile(join(agentDir, "extensions/acceptance-provider.ts"),
    `export { default } from ${JSON.stringify(pathToFileURL(join(here, "provider.mjs")).href)};\n`);
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [sdk.createCodemodeExtension({ models: false })],
    systemPrompt,
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, [], "extension files must load successfully");
  assert(loaded.extensions.some((extension) => resolve(extension.path) === entry), "the configured delegation entry must load");
  const modelRuntime = await sdk.ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  ({ session: parent } = await sdk.createAgentSession({
    cwd, agentDir, modelRuntime, resourceLoader, settingsManager,
    sessionManager: sdk.SessionManager.inMemory(cwd), thinkingLevel: "off", tools,
  }));
  await parent.bindExtensions({ mode: "print" });
  const refresh = await modelRuntime.refresh({ allowNetwork: false });
  assert.equal(refresh.errors.size, 0);
  const model = modelRuntime.getModel(providerId, modelId);
  assert(model, "the discovered test provider must register its model");
  await parent.setModel(model);
  return { parent, modelRuntime, authPath, expectedKeyPath, fileContents };
}

export async function runCode(parent, code) {
  const before = parent.messages.length;
  await parent.prompt(`ACCEPTANCE_CODE:${code}`);
  const added = parent.messages.slice(before);
  const last = added.findLast((message) => message.role === "assistant");
  assert.equal(last?.stopReason, "stop", last?.errorMessage);
  assert.equal(text(last), "PARENT_DONE");
  const result = added.findLast((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert(result, "the parent must call real codemode");
  assert.notEqual(result.isError, true, text(result));
  return text(result);
}

export async function invoke(parent, args) {
  const output = await runCode(parent, `const result = await tools.delegate(${JSON.stringify(args)}); text("DELEGATION_RESULT:" + JSON.stringify(result));`);
  const match = output.match(/^DELEGATION_RESULT:(.+)$/m);
  assert(match, `codemode must return the delegation result:\n${output}`);
  const result = JSON.parse(match[1]);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert(Object.hasOwn(result.details ?? {}, "handle"), "delegation must return a follow-up handle");
  assert.notEqual(result.details.handle, null);
  assert.notEqual(result.details.handle, undefined);
  assert.doesNotThrow(() => JSON.stringify(result.details.handle), "the handle must be JSON-serializable");
  return result;
}

export const answer = (result) => text(result);
export { providerId };
