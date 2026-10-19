import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ai, sdk } from "./delegation/sdk.mjs";

// SDK-only regression: no delegation extension, codemode, live credentials or network.
async function parentSession(t, beforeTree) {
  const root = await mkdtemp(join(tmpdir(), "pi-native-navigation-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const credentials = new ai.InMemoryCredentialStore();
  await credentials.modify("navigation-test", async () => ({ type: "api_key", key: "synthetic" }));
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    systemPrompt: "Synthetic navigation regression.",
    extensionFactories: [
      (pi) => {
        const fake = ai.fauxProvider({ provider: "navigation-test", models: [{ id: "scripted" }], tokensPerSecond: 0 });
        pi.registerProvider({
          ...fake.provider,
          auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: { apiKey: "synthetic" } }) } },
          streamSimple(model, context, options) {
            fake.setResponses([ai.fauxAssistantMessage("DONE")]);
            return fake.provider.streamSimple(model, context, options);
          },
        });
        pi.on("session_before_tree", beforeTree);
      },
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const { session } = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager: sdk.SessionManager.inMemory(root),
    tools: [],
    thinkingLevel: "off",
  });
  t.after(async () => {
    await session.abort();
    session.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      throw new Error(error.error);
    },
  });
  const refreshed = await modelRuntime.refresh({ allowNetwork: false });
  assert.equal(refreshed.errors.size, 0);
  await session.setModel(modelRuntime.getModel("navigation-test", "scripted"));
  return session;
}

for (const trigger of ["user", "custom"]) {
  for (const overlaps of [false, true]) {
    test(`native ${trigger} turn retains its accepted history when started ${overlaps ? "during" : "after"} navigation`, {
      timeout: 20000,
      skip:
        overlaps &&
        "Pi 1.2.0/1.3.0 allow turns to overlap navigation (#9154); parent scheduling is outside delegation.",
    }, async (t) => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const parent = await parentSession(t, async () => {
        entered.resolve();
        await release.promise;
      });
      await parent.prompt("seed");
      const target = parent.sessionManager.getLeafId();
      await parent.prompt("later");
      assert.notEqual(parent.sessionManager.getLeafId(), target);
      const marker = `accepted-${trigger}-turn`;
      const contains = (messages) =>
        messages.some((message) =>
          typeof message.content === "string"
            ? message.content === marker
            : message.content.some((block) => block.type === "text" && block.text === marker),
        );
      assert.equal(contains(parent.messages), false);
      const navigation = parent.navigateTree(target);
      await entered.promise;
      try {
        if (!overlaps) {
          release.resolve();
          assert.equal((await navigation).cancelled, false);
        }
        if (trigger === "user") await parent.prompt(marker);
        else
          await parent.sendCustomMessage(
            { customType: "navigation-test", content: marker, display: false },
            { triggerTurn: true },
          );
        assert.equal(contains(parent.messages), true, "the completed turn must be accepted before checking navigation");
      } finally {
        release.resolve();
        await navigation;
      }
      assert.equal(contains(parent.messages), true, "navigation must not discard a successfully accepted turn");
    });
  }
}
