import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

// Real paths, so a cd through a symlink such as /tmp still counts as cwd
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** A shell command's first line, without leading cds into cwd; another folder shows as its last part when the path is absolute. */
export function shortCommand(command: string, cwd: string): string {
  const rest = command.trim().replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)[ \t]*(?:&&|;|\n)\s*)+/, (prefix) => {
    const match = [...prefix.matchAll(/cd\s+("[^"]*"|'[^']*'|\S+)[ \t]*(&&|;|\n)/g)].at(-1);
    if (!match) return prefix;
    const [, quoted, separator] = match;
    const dir = quoted.replace(/^["']|["']$/g, "");
    if (real(resolve(cwd, dir)) === real(resolve(cwd))) return "";
    return `cd ${isAbsolute(dir) ? `…/${basename(dir)}` : quoted}${separator === ";" ? ";" : " &&"} `;
  });
  return rest.split("\n")[0];
}
