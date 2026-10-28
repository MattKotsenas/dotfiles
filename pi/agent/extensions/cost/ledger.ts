import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { entryUsage } from "../shared/usage.ts";
import { cleanText, costRecord, type Activity, type Checkpoint, type CostRecord, type CostSnapshot } from "./model.ts";

type Start = Extract<CostRecord, { kind: "turn_start" }>;
type End = Extract<CostRecord, { kind: "turn_end" }>;
interface Turn {
  start: Start;
  marker: number;
  begin: number;
  end: number;
  finish?: End;
}
interface Group {
  item: Activity;
  first: number;
  last: number;
  charges: number[];
  members: number[];
}

const amount = (entry: SessionEntry) => {
  const cost = entryUsage(entry)?.cost.total;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
};
const key = (record: { owner: string; id: string }) => JSON.stringify([record.owner, record.id]);

function turns(entries: SessionEntry[], positions: Map<string, number>): Turn[] {
  const found = new Map<string, Turn>();
  entries.forEach((entry, index) => {
    const record = costRecord(entry);
    if (record?.kind === "turn_start") {
      const cursor = record.afterEntryId === null ? -1 : positions.get(record.afterEntryId);
      if (cursor !== undefined && cursor < index) {
        found.set(key(record), { start: record, marker: index, begin: cursor + 1, end: entries.length - 1 });
      }
    } else if (record?.kind === "turn_end") {
      const turn = found.get(key(record));
      const cursor = record.afterEntryId === null ? -1 : positions.get(record.afterEntryId);
      if (turn && cursor !== undefined && cursor >= turn.begin && cursor < index) {
        turn.end = cursor;
        turn.finish = record;
      }
    }
  });
  const result = [...found.values()];
  result.forEach((turn, index) => {
    // An inherited unfinished span must not claim work started in its child.
    if (!turn.finish && result[index + 1]) turn.end = Math.min(turn.end, result[index + 1].begin - 1);
  });
  return result;
}

export function unfinishedTurns(entries: SessionEntry[], owner: string): Array<{ id: string }> {
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  return turns(entries, positions)
    .filter((turn) => turn.start.owner === owner && !turn.finish)
    .map((turn) => ({ id: turn.start.id }));
}

/** Project recorded spending, independently of compaction and the current conversation leaf. */
export function project(
  entries: SessionEntry[],
  pathIds: ReadonlySet<string>,
  owner: string,
  rangeId?: string,
): CostSnapshot {
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  const prefix = [0];
  let pathTotal = 0;
  for (const entry of entries) {
    const cost = amount(entry);
    prefix.push(prefix[prefix.length - 1] + cost);
    if (pathIds.has(entry.id)) pathTotal += cost;
  }
  const total = prefix[entries.length];
  const groups: Group[] = [];
  const create = (
    index: number,
    id: string,
    kind: Activity["kind"],
    excerpt: string,
    provenance: Activity["provenance"],
  ) => {
    const group: Group = {
      first: index,
      last: index,
      charges: [],
      members: [index],
      item: {
        id,
        afterEntryId: entries[index].id,
        order: 0,
        kind,
        excerpt: cleanText(excerpt).slice(0, 120),
        onPath: false,
        main: 0,
        tools: 0,
        other: 0,
        pathMain: 0,
        pathTools: 0,
        pathOther: 0,
        cost: 0,
        missing: false,
        provenance,
        partial: false,
      },
    };
    groups.push(group);
    return group;
  };
  const observed: Array<Group | undefined> = Array(entries.length);
  for (const turn of turns(entries, positions)) {
    // A fork can copy a start without its settlement. Its unknown end cannot
    // define an interval in the child's ledger.
    if ((!turn.finish && turn.start.owner !== owner) || turn.end < turn.marker) continue;
    const group = create(
      turn.marker,
      turn.start.id,
      "prompt",
      turn.start.excerpt,
      turn.finish && turn.finish.status !== "interrupted" ? "observed" : "incomplete",
    );
    for (let index = turn.begin; index <= turn.end; index++) observed[index] = group;
  }
  const users = new Map<string, Group>();
  const ancestors = new Map<string, string | undefined>();
  entries.forEach((entry, index) => {
    const user = entry.type === "message" && entry.message.role === "user";
    ancestors.set(entry.id, user ? entry.id : ancestors.get(entry.parentId ?? ""));
    if (entry.type === "message" && entry.message.role === "user") {
      if (observed[index]) {
        observed[index].last = Math.max(observed[index].last, index);
        observed[index].first = Math.min(observed[index].first, index);
        observed[index].members.push(index);
      } else {
        const content = entry.message.content;
        const text =
          typeof content === "string"
            ? content
            : content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(" ");
        users.set(entry.id, create(index, entry.id, "prompt", text, "historical"));
      }
    }
    const usage = entryUsage(entry);
    const assistant = entry.type === "message" && entry.message.role === "assistant";
    if (!usage && !assistant) return;
    const field =
      entry.type === "message" && entry.message.role === "assistant"
        ? "main"
        : entry.type === "message" && entry.message.role === "toolResult"
          ? "tools"
          : "other";
    let group = observed[index] ?? (field !== "other" ? users.get(ancestors.get(entry.id) ?? "") : undefined);
    if (!group) {
      const label =
        entry.type === "compaction"
          ? "Compaction"
          : entry.type === "branch_summary"
            ? "Branch summary"
            : entry.type === "usage"
              ? entry.kind === "cache_warm"
                ? "Cache warming"
                : entry.kind
              : "Unattributed model usage";
      group = create(index, entry.id, "overhead", label, "historical");
    }
    group.first = Math.min(group.first, index);
    group.last = Math.max(group.last, index);
    group.charges.push(index);
    group.members.push(index);
  });
  // Completion order makes each displayed mark a temporal boundary even when
  // historical ancestry groups span compaction or work on another branch.
  groups.sort((left, right) => left.last - right.last || left.first - right.first);
  groups.forEach((group, order) => {
    group.item.order = order;
    group.item.afterEntryId = entries[group.last].id;
  });
  const checkpoints = new Map<string, Checkpoint>();
  let selectedFooter: string | null = null;
  entries.forEach((entry, index) => {
    const record = costRecord(entry);
    if (!record || record.owner !== owner) return;
    if (record.kind === "checkpoint") {
      const cursor = record.afterEntryId === null ? -1 : positions.get(record.afterEntryId);
      if (cursor === undefined || cursor >= index) return;
      checkpoints.set(record.id, {
        ...record,
        name: cleanText(record.name),
        total: prefix[cursor + 1],
        after: groups.findLastIndex((group) => group.last <= cursor),
      });
    } else if (record.kind === "remove") checkpoints.delete(record.id);
    else if (record.kind === "footer") selectedFooter = record.id;
  });
  const range = rangeId ? checkpoints.get(rangeId) : undefined;
  const baseline = selectedFooter ? checkpoints.get(selectedFooter) : undefined;
  const cutoff = range?.afterEntryId ? (positions.get(range.afterEntryId) ?? -1) : -1;
  const activities = groups
    .filter((group) => group.last > cutoff)
    .map((group) => {
      const item = { ...group.item, partial: cutoff >= group.first };
      // A branch filter must also keep a zero-cost user activity on that path.
      item.onPath = group.members.some((index) => index > cutoff && pathIds.has(entries[index].id));
      for (const index of group.charges) {
        if (index <= cutoff) continue;
        const entry = entries[index];
        const usage = entryUsage(entry);
        if (!usage || !Number.isFinite(usage.cost.total)) {
          item.missing = true;
          continue;
        }
        const cost = usage.cost.total;
        const field =
          entry.type === "message" && entry.message.role === "assistant"
            ? "main"
            : entry.type === "message" && entry.message.role === "toolResult"
              ? "tools"
              : "other";
        item[field] += cost;
        item.cost += cost;
        if (pathIds.has(entry.id)) {
          item.onPath = true;
          if (field === "main") item.pathMain += cost;
          else if (field === "tools") item.pathTools += cost;
          else item.pathOther += cost;
        }
      }
      return item;
    });
  return {
    activities,
    checkpoints: [...checkpoints.values()],
    range,
    baseline,
    total,
    pathTotal,
    footerCost: total - (baseline?.total ?? 0),
  };
}
