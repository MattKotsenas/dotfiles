import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export type Identity = { path: string; id: string; cwd: string };

// Owned temporary cleanup. The caller owns this exact reservation; no directory scan.
import { readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

function samePath(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false;
  const normalize = (value: string) => (process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value));
  return normalize(a) === normalize(b);
}

export function cleanupOwnedTemporary(fresh: ExtensionContext, original: Identity, owned: Omit<Identity, "cwd">) {
  try {
    const currentFile = fresh.sessionManager.getSessionFile();
    const refuse = (reason: string) => ({
      status: "refused",
      warning: `Temporary cleanup refused: ${reason}`,
    });
    if (samePath(owned.path, original.path)) return refuse("original-path guard");
    if (samePath(owned.path, currentFile)) return refuse("active-path guard");
    if (
      fresh.sessionManager.getSessionId() !== original.id ||
      !samePath(currentFile, original.path) ||
      !samePath(fresh.cwd, original.cwd)
    ) {
      return refuse("current original id/file/cwd mismatch");
    }
    if (owned.id === original.id) return refuse("temporary id equals original id");

    let bytes: string;
    try {
      bytes = readFileSync(owned.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      throw error;
    }
    const header = JSON.parse(bytes.split("\n", 1)[0]);
    if (header.type !== "session" || header.id !== owned.id) {
      return refuse("session header type/UUID mismatch");
    }
    // Best-effort cleanup: validation and unlink are not atomic.
    try {
      unlinkSync(owned.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
      throw error;
    }
    return { status: "deleted" };
  } catch (error) {
    // Cleanup failure does not turn a completed workspace replacement into failure.
    return {
      status: "failed",
      code: (error as NodeJS.ErrnoException).code,
      warning: `Temporary cleanup failed: ${(error as Error).message}`,
    };
  }
}
