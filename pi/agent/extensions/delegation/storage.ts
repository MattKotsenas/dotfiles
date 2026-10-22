import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type ExtensionContext,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";

type Status = "running" | "stopping" | "interrupted" | "completed" | "failed";
export type ChildRecord = {
  version: 1;
  owner: string;
  handle: string;
  prompt: string;
  status: Status;
  sessionFile?: string;
  sessionId: string;
  systemPrompt?: { append: string; replace?: never } | { replace: string; append?: never };
  tools?: string[];
  provider: string;
  model: string;
  thinkingLevel: ExtensionContext["thinkingLevel"];
  reportedEntryCount: number;
  leafId: string | null;
};
export function openChild(record: ChildRecord): SessionManager {
  if (!record.sessionFile || !existsSync(record.sessionFile))
    throw new Error("Delegated conversation file is missing or empty");
  const contents = readFileSync(record.sessionFile, "utf8");
  if (!contents.trim()) throw new Error("Delegated conversation file is missing or empty");
  const damaged = () => new Error("Delegated conversation is damaged or does not match its checkpoint");
  let entries: FileEntry[];
  // Pi skips malformed JSONL; recovery must not silently discard recorded history.
  try {
    entries = contents
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    throw damaged();
  }
  const [header, ...ledger] = entries;
  if (header?.type !== "session" || header.version !== CURRENT_SESSION_VERSION || header.id !== record.sessionId)
    throw damaged();
  const ids = new Set<string>();
  for (const entry of ledger) {
    if (
      entry?.type === "session" ||
      typeof entry?.id !== "string" ||
      ids.has(entry.id) ||
      (entry.parentId !== null && !ids.has(entry.parentId))
    )
      throw damaged();
    ids.add(entry.id);
  }
  if (record.reportedEntryCount > ledger.length || (record.leafId !== null && !ids.has(record.leafId))) throw damaged();
  const manager = SessionManager.open(record.sessionFile);
  if (record.leafId === null) manager.resetLeaf();
  else manager.branch(record.leafId);
  return manager;
}

export function createChildSession(ctx: ExtensionContext, cwd: string): SessionManager {
  const parentFile = ctx.sessionManager.getSessionFile();
  if (!parentFile) return SessionManager.inMemory(cwd);
  const directory = /\.jsonl$/i.test(parentFile) ? parentFile.slice(0, -6) : `${parentFile}.children`;
  const manager = SessionManager.create(cwd, directory, { parentSession: parentFile });
  // Persist identity before startup so an interrupted first call is recoverable.
  mkdirSync(directory, { recursive: true });
  const file = manager.getSessionFile();
  if (!file) throw new Error("Native child session has no file");
  writeFileSync(file, `${JSON.stringify(manager.getHeader())}\n`, { flag: "wx", mode: 0o600 });
  return SessionManager.open(file);
}

export const entryType = "delegation.child.v1";

export function restoreChildren(ctx: ExtensionContext): Map<string, ChildRecord> {
  const records = new Map<string, ChildRecord>();
  const reported = new Map<string, number>();
  // Spending belongs to the full ledger even when conversation history rewinds.
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== entryType) continue;
    const record = entry.data as ChildRecord;
    if (record.owner !== ctx.sessionManager.getSessionId() || record.version !== 1) continue;
    reported.set(record.sessionId, Math.max(reported.get(record.sessionId) ?? 0, record.reportedEntryCount));
  }
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== entryType) continue;
    const record = entry.data as ChildRecord;
    if (record.owner !== ctx.sessionManager.getSessionId() || !record.sessionFile) continue;
    if (record.version !== 1) throw new Error("Unsupported delegation checkpoint version");
    records.set(record.handle, {
      ...record,
      reportedEntryCount: reported.get(record.sessionId) ?? record.reportedEntryCount,
      status: record.status === "running" || record.status === "stopping" ? "interrupted" : record.status,
    });
  }
  return records;
}
