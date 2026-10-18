import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve the installed package's public entry points without installing dependencies in dotfiles.
const root = process.env.PI_SDK_ROOT;
if (!root) throw new Error("Set PI_SDK_ROOT to the installed @earendil-works/pi-coding-agent directory.");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
export const version = manifest.version;
export const sdk = await import(pathToFileURL(join(root, manifest.exports["."].import)));
const aiRoot = join(root, "node_modules/@earendil-works/pi-ai");
const aiManifest = JSON.parse(await readFile(join(aiRoot, "package.json"), "utf8"));
export const ai = await import(pathToFileURL(join(aiRoot, aiManifest.exports["."].import)));
