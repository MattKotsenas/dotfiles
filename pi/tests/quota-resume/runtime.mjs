import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root =
  process.env.PI_SDK_ROOT ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const require = createRequire(join(root, "package.json"));
async function dependency(name) {
  const path = require.resolve
    .paths(name)
    .map((base) => join(base, name))
    .find((base) => existsSync(join(base, "package.json")));
  const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  return { path, module: await import(pathToFileURL(join(path, manifest.exports?.["."]?.import ?? manifest.main))) };
}
export const sdk = await import(pathToFileURL(join(root, "dist/index.js")));
const aiDependency = await dependency("@earendil-works/pi-ai");
export const ai = aiDependency.module;
export const { formatProgramStatus } = (await dependency("@earendil-works/pi-tui")).module;
// Test the host's real error normalization and OSC reporter, including across SDK versions.
export const { stream: openaiResponses } = await import(
  pathToFileURL(join(aiDependency.path, "dist/api/openai-responses.js"))
);
export const { ProgramStatusReporter } = await import(
  pathToFileURL(join(root, "dist/modes/interactive/program-status-reporter.js"))
);
