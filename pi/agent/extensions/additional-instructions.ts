import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { globSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export function instructionPath(path: string, agentDir: string): string {
  if (path === "~") return homedir();
  if (/^~[/\\]/.test(path)) return resolve(homedir(), path.slice(2));
  if (path.startsWith("~")) throw new Error(`Unsupported home path: ${path}; use ~/path`);
  return resolve(agentDir, path);
}

export function additionalInstructions(pi: ExtensionAPI, agentDir: string) {
  pi.on("before_agent_start", (event, ctx) => {
    const warn = (error: unknown) => {
      const message = `additional-instructions: ${error instanceof Error ? error.message : error}`;
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.error(message);
    };
    let paths: string[];
    try {
      const settingsPath = join(agentDir, "settings.json");
      let settings;
      try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      paths = settings.additionalInstructions?.paths ?? [];
      if (!Array.isArray(paths) || paths.some(path => typeof path !== "string" || !path.trim())) {
        throw new Error("additionalInstructions.paths must be an array of non-empty paths");
      }
    } catch (error) { warn(error); return; }

    const files = event.systemPromptOptions.contextFiles;
    const seen = new Set(files.map(file => {
      try { return realpathSync(file.path); }
      catch { return resolve(file.path); }
    }));
    const add = (path: string) => {
      try {
        const canonical = realpathSync(path);
        if (seen.has(canonical)) return;
        const content = readFileSync(path, "utf8");
        seen.add(canonical);
        files.push({ path, content });
      } catch (error) { warn(error); }
    };
    for (const configured of paths) {
      try {
        const path = instructionPath(configured, agentDir);
        // Node glob patterns use forward slashes, including on Windows.
        const pattern = sep === "\\" ? path.replaceAll("\\", "/") : path;
        const matches = globSync(pattern, { withFileTypes: true })
          .filter(entry => entry.isFile() || entry.isSymbolicLink())
          .map(entry => join(entry.parentPath, entry.name))
          .sort();
        if (matches.length === 0) warn(new Error(`No files matched: ${configured}`));
        for (const file of matches) add(file);
      } catch (error) { warn(error); }
    }
  });
}

export default function (pi: ExtensionAPI) {
  additionalInstructions(pi, getAgentDir());
}
