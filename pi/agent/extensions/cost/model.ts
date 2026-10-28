import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const COST_ENTRY = "cost";
interface OwnedRecord {
  version: 1;
  owner: string;
}
export interface CheckpointRecord extends OwnedRecord {
  kind: "checkpoint";
  id: string;
  name: string;
  afterEntryId: string | null;
}
export interface FooterRecord extends OwnedRecord {
  kind: "footer";
  id: string | null;
}
export type CostRecord =
  | CheckpointRecord
  | FooterRecord
  | (OwnedRecord & { kind: "remove"; id: string })
  | (OwnedRecord & { kind: "turn_start"; id: string; afterEntryId: string | null; excerpt: string })
  | (OwnedRecord & {
      kind: "turn_end";
      id: string;
      afterEntryId: string | null;
      status: "settled" | "aborted" | "interrupted";
    });

export function cleanText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
export function checkpointRecord(owner: string, name: string, afterEntryId: string | null): CheckpointRecord {
  return {
    version: 1,
    owner,
    kind: "checkpoint",
    id: randomUUID(),
    name: cleanText(name) || "Checkpoint",
    afterEntryId,
  };
}
export function footerRecord(owner: string, id: string | null): FooterRecord {
  return { version: 1, owner, kind: "footer", id };
}
export function costRecord(entry: SessionEntry): CostRecord | undefined {
  if (entry.type !== "custom" || entry.customType !== COST_ENTRY) return;
  const data = entry.data as Partial<CostRecord> | null;
  if (!data || typeof data !== "object" || data.version !== 1 || typeof data.owner !== "string") return;
  const anchor = "afterEntryId" in data && (data.afterEntryId === null || typeof data.afterEntryId === "string");
  switch (data.kind) {
    case "checkpoint":
      if (typeof data.id === "string" && typeof data.name === "string" && anchor) return data as CheckpointRecord;
      break;
    case "footer":
      if (data.id === null || typeof data.id === "string") return data as FooterRecord;
      break;
    case "remove":
      if (typeof data.id === "string") return data as CostRecord;
      break;
    case "turn_start":
      if (typeof data.id === "string" && typeof data.excerpt === "string" && anchor) return data as CostRecord;
      break;
    case "turn_end":
      if (typeof data.id === "string" && anchor && ["settled", "aborted", "interrupted"].includes(data.status ?? ""))
        return data as CostRecord;
  }
}

export interface Activity {
  id: string;
  afterEntryId: string;
  order: number;
  kind: "prompt" | "overhead";
  excerpt: string;
  onPath: boolean;
  main: number;
  tools: number;
  other: number;
  pathMain: number;
  pathTools: number;
  pathOther: number;
  cost: number;
  missing: boolean;
  provenance: "observed" | "historical" | "incomplete";
  partial: boolean;
}
export interface Checkpoint extends CheckpointRecord {
  after: number;
  total: number;
}
export interface CostSnapshot {
  activities: Activity[];
  checkpoints: Checkpoint[];
  range?: Checkpoint;
  baseline?: Checkpoint;
  total: number;
  pathTotal: number;
  footerCost: number;
}
