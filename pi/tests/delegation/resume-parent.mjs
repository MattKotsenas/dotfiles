import assert from "node:assert/strict";
import { sdk } from "./sdk.mjs";
import { providerId, modelId } from "./provider.mjs";
import { invoke, runCode } from "./fixture.mjs";

// A fresh process opens only the parent's native file and current agent configuration.
const [file, cwd, agentDir, args] = process.argv.slice(2);
const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
const resourceLoader = new sdk.DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noSkills: true,
  noThemes: true,
  noPromptTemplates: true,
  noContextFiles: true,
  extensionFactories: [sdk.createCodemodeExtension({ models: false })],
  systemPrompt: "Execute the supplied codemode script.",
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
const modelRuntime = await sdk.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
const { session } = await sdk.createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  resourceLoader,
  modelRuntime,
  sessionManager: sdk.SessionManager.open(file),
});
try {
  await session.bindExtensions({ mode: "print" });
  await modelRuntime.refresh({ allowNetwork: false });
  await session.setModel(modelRuntime.getModel(providerId, modelId));
  const listing = await runCode(session, 'text("CHILDREN:" + JSON.stringify(await tools.delegates({})));');
  console.log(`DISCOVERY:${listing}`);
  const result = await invoke(session, JSON.parse(args));
  console.log(`RESUMED:${JSON.stringify({ listing, result })}`);
} finally {
  await session.abort();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
