import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sdk } from "./delegation/sdk.mjs";

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
      cwd: root, agentDir: root, settingsManager: sdk.SettingsManager.inMemory({ extensions }),
      additionalExtensionPaths, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    return loaded.extensions.some((extension) => extension.tools.has("delegate"));
  }
  assert.equal(await load([]), true, "conventional discovery must load the extension first");
  const disabled = ["-./extensions/delegation/index.ts"];
  assert.equal(await load(disabled), false, "the settings exclusion must prevent registration");
  assert.equal(await load(disabled, [entry]), true, "explicit CLI loading must override the exclusion for this invocation");
  assert.equal(await load(disabled), false, "the session override must not persist");
});
