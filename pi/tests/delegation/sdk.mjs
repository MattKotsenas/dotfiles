import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// PI_SDK_ROOT tests a specific installation; otherwise use the pinned development SDK.
const root =
  process.env.PI_SDK_ROOT ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
export const version = manifest.version;
export const sdk = await import(pathToFileURL(join(root, manifest.exports["."].import)));
const sdkRequire = createRequire(pathToFileURL(join(root, "package.json")));
const aiRoot = sdkRequire.resolve
  .paths("@earendil-works/pi-ai")
  .map((path) => join(path, "@earendil-works/pi-ai"))
  .find((path) => existsSync(join(path, "package.json")));
if (!aiRoot) throw new Error("The selected Pi SDK must have @earendil-works/pi-ai installed.");
const aiManifest = JSON.parse(await readFile(join(aiRoot, "package.json"), "utf8"));
export const ai = await import(pathToFileURL(join(aiRoot, aiManifest.exports["."].import)));
