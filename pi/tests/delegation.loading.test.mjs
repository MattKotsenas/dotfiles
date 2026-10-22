import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sdk } from "./delegation/sdk.mjs";
import { answer, fixture, invoke, runCode } from "./delegation/fixture.mjs";

test("delegation is available through codemode by default", async (t) => {
  const { parent, fileContents, authPath } = await fixture(t, { discoverDelegation: true });
  const settings = JSON.parse(await readFile(join(dirname(authPath), "settings.json"), "utf8"));
  assert.deepEqual(settings.extensions, [], "precondition: no explicit extension path");
  assert.deepEqual(settings.defaultTools, ["+codemode"], "precondition: no explicit delegation activation");
  assert(parent.getActiveToolNames().includes("codemode"));
  assert(!parent.getActiveToolNames().includes("delegate"), "delegation must stay codemode-only");
  assert(!parent.getActiveToolNames().includes("delegates"), "discovery must stay codemode-only");
  assert.match(await runCode(parent, "text((await tools.delegates({})).details.children);"), /\[\]/);
  const result = await invoke(parent, {
    prompt: "Read note.txt and return its exact contents.",
    systemPrompt: { replace: "Prefix file contents with CHILD:" },
    tools: ["read"],
  });
  assert.equal(answer(result), `CHILD:${fileContents}`);
  const listed = await runCode(parent, "text((await tools.delegates({})).details.children);");
  assert(listed.includes(result.details.handle), "codemode must discover the new child's handle");
});

test("settings can disable discovered delegation and an explicit session path can enable it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-delegation-loading-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "extensions", "delegation");
  await mkdir(directory, { recursive: true });
  const entry = join(directory, "index.ts");
  const production = new URL("../agent/extensions/delegation/index.ts", import.meta.url).href;
  await writeFile(entry, `export { default } from ${JSON.stringify(production)};\n`);
  async function load(extensions, additionalExtensionPaths = []) {
    const loader = new sdk.DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: sdk.SettingsManager.inMemory({ extensions }),
      additionalExtensionPaths,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    return loaded.extensions.some((extension) => extension.tools.has("delegate"));
  }
  assert.equal(await load([]), true, "conventional discovery must load the extension first");
  const disabled = ["-./extensions/delegation/index.ts"];
  assert.equal(await load(disabled), false, "the settings exclusion must prevent registration");
  assert.equal(
    await load(disabled, [entry]),
    true,
    "explicit CLI loading must override the exclusion for this invocation",
  );
  assert.equal(await load(disabled), false, "the session override must not persist");
});
