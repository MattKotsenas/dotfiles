import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { answer, fixture, invoke, providerId, runCode } from "./delegation/fixture.mjs";

describe("delegation review regressions", { concurrency: false }, () => {
  for (const trusted of [false, true]) {
    test(`child project extension discovery respects parent trust=${trusted}`, { timeout: 15000 }, async (t) => {
      const { parent } = await fixture(t);
      const cwd = parent.sessionManager.getCwd();
      const marker = join(cwd, "project-extension-loaded");
      await mkdir(join(cwd, ".pi/extensions"), { recursive: true });
      // Added after the parent loads: only child discovery can execute this extension.
      await writeFile(
        join(cwd, ".pi/extensions/marker.ts"),
        `import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`,
      );
      parent.settingsManager.setProjectTrusted(trusted);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const result = await invoke(parent, { prompt: "Remember this word: trust-check", tools: [] });
      assert.equal(answer(result), "REMEMBERED");
      if (trusted) assert.equal(await readFile(marker, "utf8"), "loaded");
      else await assert.rejects(readFile(marker), { code: "ENOENT" });
    });
  }

  test("an existing child inherits a parent-only resolver replacement", { timeout: 15000 }, async (t) => {
    const { parent, modelRuntime, expectedKeyPath, authPath } = await fixture(t);
    const originalAuth = await readFile(authPath, "utf8");
    const child = await invoke(parent, {
      prompt: "Remember this word: resolver-history",
      systemPrompt: "Prefix recalled words with MEMORY:",
      tools: [],
    });
    const native = modelRuntime.getRegisteredNativeProvider(providerId);
    assert(native, "the parent must have a native provider to replace");
    const replacement = "synthetic-parent-resolver-only";
    assert.notEqual(JSON.parse(originalAuth)[providerId].key, replacement);
    modelRuntime.registerNativeProvider({
      ...native,
      auth: {
        apiKey: {
          name: "Parent replacement",
          resolve: async () => ({ auth: { apiKey: replacement } }),
        },
      },
    });
    await modelRuntime.refresh({ allowNetwork: false });
    await writeFile(expectedKeyPath, replacement);
    const recalled = await invoke(parent, {
      handle: child.details.handle,
      prompt: "What word did I ask you to remember?",
    });
    assert.equal(answer(recalled), "MEMORY:resolver-history");
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
  });

  test("parent runtime auth takes precedence over an unresolved models.json key", { timeout: 15000 }, async (t) => {
    const { parent, modelRuntime, expectedKeyPath, authPath } = await fixture(t);
    const agentDir = dirname(authPath);
    // A random-looking variable name is still explicitly checked, so inherited env cannot make this pass.
    const variable = "PI_DELEGATION_REGRESSION_UNSET_KEY";
    assert.equal(process.env[variable], undefined);
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: { [providerId]: { apiKey: `$${variable}` } },
      }),
    );
    await modelRuntime.setRuntimeApiKey(providerId, await readFile(expectedKeyPath, "utf8"));
    await modelRuntime.refresh({ allowNetwork: false });
    assert.match(await runCode(parent, 'text("PARENT_AUTH_WORKS");'), /PARENT_AUTH_WORKS/);
    const originalAuth = await readFile(authPath, "utf8");
    const result = await invoke(parent, { prompt: "Remember this word: configured-auth-check", tools: [] });
    assert.equal(answer(result), "REMEMBERED");
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
  });
});
