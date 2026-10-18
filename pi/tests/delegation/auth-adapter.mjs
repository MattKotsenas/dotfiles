import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sdk } from "./sdk.mjs";

// Use Pi's real file loader so SDK aliases, private-module lookup, and TypeScript
// loading are exercised. This bridge exposes helpers only in the SDK test worker.
const fixtures = process.env.PI_DELEGATION_AUTH_FIXTURES;
if (!fixtures) throw new Error("Run through pi/tests/delegation.auth.test.mjs.");
const root = await mkdtemp(join(fixtures, "adapter-loader-"));
const auth = new URL("../../agent/extensions/delegation/auth.ts", import.meta.url).href;
const refresh = new URL("../../agent/extensions/delegation/model-refresh.ts", import.meta.url).href;
const entry = join(root, "bridge.ts");
await writeFile(entry, `import * as auth from ${JSON.stringify(auth)}; import * as refresh from ${JSON.stringify(refresh)};
export default pi => pi.registerCommand("test-adapter", { handler: () => ({ ...auth, ...refresh }) });\n`);
const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root,
  settingsManager: sdk.SettingsManager.inMemory(), noExtensions: true,
  additionalExtensionPaths: [entry], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions.find((item) => item.commands.has("test-adapter"));
assert(extension, "the adapter bridge must load");
export const { getParentCredentials, inheritParentAuth, trackModelRefreshes } = await extension.commands.get("test-adapter").handler();
