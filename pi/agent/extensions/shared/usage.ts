import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export function entryUsage(entry: SessionEntry): Usage | undefined {
  if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
    return entry.message.usage;
  }
  if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") return entry.usage;
}

/** Count new ledger entries, including work that has left the active conversation. */
export function usageSince(sessionManager: Pick<SessionManager, "getEntries">, firstEntry: number): Usage {
  const total: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const entry of sessionManager.getEntries().slice(firstEntry)) {
    const usage = entryUsage(entry);
    if (!usage) continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
    for (const key of ["cacheWrite1h", "reasoning"] as const) {
      if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
      total.cost[key] += usage.cost[key];
  }
  return total;
}
