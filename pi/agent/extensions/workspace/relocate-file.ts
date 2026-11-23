// Publish a complete destination without replacing any existing path.

import { randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function relocateFile(source: string, destination: string, sessionId: string, cwd: string) {
  const bytes = readFileSync(source, "utf8");
  const newline = bytes.indexOf("\n");
  const header = JSON.parse(bytes.slice(0, newline));
  if (header.type !== "session" || header.id !== sessionId) throw new Error("Source identity changed");
  const candidate = join(dirname(destination), `.workspace-move-${randomUUID()}.tmp`);
  let created = false,
    failure: unknown;
  try {
    const fd = openSync(candidate, "wx");
    created = true;
    try {
      writeFileSync(fd, JSON.stringify({ ...header, cwd }) + bytes.slice(newline));
    } finally {
      closeSync(fd);
    }
    // link() fails if destination exists. Unlike rename(), it cannot overwrite it.
    // The private candidate link is removed; no old-path alias is retained.
    linkSync(candidate, destination);
  } catch (error) {
    failure = error;
  }
  if (created) {
    try {
      unlinkSync(candidate);
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "Publication and candidate cleanup failed") : error;
    }
  }
  if (failure) {
    throw Object.assign(failure instanceof Error ? failure : new Error(String(failure)), { candidatePath: candidate });
  }
  // A failure here leaves both complete files. Report both; do not delete either history.
  unlinkSync(source);
}
