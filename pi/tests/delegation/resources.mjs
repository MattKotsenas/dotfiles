import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ai, sdk } from "./sdk.mjs";
import { getParentCredentials, inheritParentAuth, trackModelRefreshes } from "./auth-adapter.mjs";

// The worker runner owns deletion after all SDK background work has exited.
const fixtures = process.env.PI_DELEGATION_AUTH_FIXTURES;
if (!fixtures) throw new Error("Run through pi/tests/delegation.auth.test.mjs.");

export async function jsonFile(name, value) {
  const root = await mkdtemp(join(fixtures, "data-"));
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

export async function credentialStore(provider, credential) {
  const store = new ai.InMemoryCredentialStore();
  await store.modify(provider, () => credential);
  return store;
}

async function trackedRuntime(options) {
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, ...options });
  return { runtime, waitForRefreshes: trackModelRefreshes(runtime) };
}

export async function refreshModels(runtime, waitForRefreshes) {
  const result = await runtime.refresh({ allowNetwork: false });
  assert.equal(result.errors.size, 0);
  await waitForRefreshes();
}

export function unresolvedApiKey() {
  const name = `PI_UNSET_${randomUUID().replaceAll("-", "_")}`;
  assert.equal(process.env[name], undefined);
  return `$${name}`;
}

export async function registeredRuntime(provider, options) {
  const tracked = await trackedRuntime(options);
  tracked.runtime.registerNativeProvider(provider);
  await refreshModels(tracked.runtime, tracked.waitForRefreshes);
  return tracked;
}

export async function inheritingRuntime(parent, modelsPath = null) {
  const tracked = await trackedRuntime({ credentials: getParentCredentials(parent), modelsPath });
  await inheritParentAuth(tracked.runtime, parent);
  return tracked;
}

export async function createSession(t, { authPath, modelsPath, ...options }) {
  return bindSession(t, await trackedRuntime({ authPath, modelsPath }), options);
}

export async function inheritingSession(t, parent, { modelsPath, ...options }) {
  return bindSession(t, await inheritingRuntime(parent, modelsPath), options);
}

async function bindSession(
  t,
  { runtime: modelRuntime, waitForRefreshes },
  { provider, extensionFactories = [], tools = [], systemPrompt },
) {
  const root = await mkdtemp(join(fixtures, "session-"));
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
    defaultTools: [],
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [(pi) => pi.registerProvider(provider), ...extensionFactories],
    systemPrompt,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    settingsManager,
    resourceLoader,
    model: provider.getModels()[0],
    thinkingLevel: "off",
    tools,
    sessionManager: sdk.SessionManager.inMemory(root),
  });
  t.after(async () => {
    await session.abort();
    session.dispose();
  });
  await session.bindExtensions({ mode: "print" });
  await refreshModels(modelRuntime, waitForRefreshes);
  return { session, waitForRefreshes };
}
