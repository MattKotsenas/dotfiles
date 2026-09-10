import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  formatBudgetHistory,
  readHistoryRecords,
  validateHistoryRecord,
} from "../history.mjs";

const sessionId = "session-1";

test("formats session prices, active usage, and bounded recent history", () => {
  const records = [
    record({
      recordId: "old",
      endedAt: "2026-01-01T12:00:00.000Z",
      usedAiCredits: 100,
    }),
    record({
      recordId: "middle",
      kind: "autopilot",
      endedAt: "2026-01-02T12:00:00.000Z",
      usedAiCredits: 500,
      capSource: "next-override",
      outcome: "paused",
    }),
    record({
      recordId: "new",
      kind: "autopilot",
      endedAt: "2026-01-03T12:00:00.000Z",
      usedAiCredits: 1200,
      capSource: "explicit-native",
      outcome: "native-cap",
    }),
  ];
  const openUnit = {
    kind: "ordinary",
    usedNanoAiu: 25_000_000_000,
    capAiCredits: 1000,
    capSource: "ordinary-default",
  };

  assert.equal(
    formatBudgetHistory({ records, openUnit, limit: 3, timeZone: "UTC" }),
    [
      "Budget history: 3 completed | over cap 1",
      "Total: 1,800 AIC ($18.00)",
      "Typical: median 500 AIC ($5.00) | average 600 AIC ($6.00)",
      "Maximum: 1,200 AIC ($12.00)",
      "Active: T | $0.25 | 25 / 1,000 AIC | 3% | DEF",
      "Recent price trend: ▁▄█  $1.00 - $12.00 (oldest -> newest)",
      "Recent 3 (local time, newest first):",
      "When         M    Cost  Used AIC  Cap AIC     %  End    Limit",
      "01-03 12:00  A  $12.00     1,200    1,000  120%  CAP    GOAL",
      "01-02 12:00  A   $5.00       500    1,000   50%  PAUSE  NEXT",
      "01-01 12:00  T   $1.00       100    1,000   10%  OK     DEF",
      "M: T turn, A autopilot | Limit: DEF default, NEXT one-shot, GOAL explicit",
      "End: OK completed, INT interrupted, EXIT mode exit, CAP cap, DEL deleted, PAUSE paused, NEW superseded",
    ].join("\n"),
  );
});

test("formats an empty history without inventing prices", () => {
  assert.equal(
    formatBudgetHistory({
      records: [],
      openUnit: null,
      limit: 10,
      timeZone: "UTC",
    }),
    "Budget history: no completed units\nActive: none",
  );
});

test("rejects duplicate record identities before aggregation", () => {
  const duplicate = record({ recordId: "duplicate" });

  assert.throws(
    () =>
      formatBudgetHistory({
        records: [duplicate, structuredClone(duplicate)],
        openUnit: null,
        limit: 10,
      }),
    /duplicate record IDs/,
  );

  assert.throws(
    () =>
      formatBudgetHistory({
        records: [
          {
            ...duplicate,
            recordId: new String("duplicate"),
          },
        ],
        openUnit: null,
        limit: 10,
      }),
    /invalid record ID/,
  );

  let reads = 0;
  const stateful = {
    ...duplicate,
    get recordId() {
      reads += 1;
      return reads === 1 ? "duplicate" : new String("duplicate");
    },
  };
  assert.throws(
    () =>
      formatBudgetHistory({
        records: [stateful, structuredClone(duplicate)],
        openUnit: null,
        limit: 10,
      }),
    /duplicate record IDs/,
  );
});

test("validates persisted history records", () => {
  assert.deepEqual(
    validateHistoryRecord(record({ recordId: "valid" }), sessionId),
    record({ recordId: "valid" }),
  );
  assert.throws(
    () =>
      validateHistoryRecord(
        record({ recordId: "wrong-session", sessionId: "session-2" }),
        sessionId,
      ),
    /belongs to another session/,
  );
  assert.throws(
    () =>
      validateHistoryRecord(
        record({ recordId: "negative", usedAiCredits: -1 }),
        sessionId,
      ),
    /unsupported values/,
  );
  assert.throws(
    () =>
      validateHistoryRecord(
        record({
          recordId: "local-time",
          endedAt: "2026-01-01T12:00:00",
        }),
        sessionId,
      ),
    /unsupported values/,
  );
  assert.throws(
    () =>
      validateHistoryRecord(
        record({
          recordId: "unsupported-outcome",
          outcome: "unsupported",
        }),
        sessionId,
      ),
    /unsupported values/,
  );
});

test("loads only JSON history files and rejects malformed records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turn-budget-history-"));
  try {
    await writeFile(
      join(directory, "valid.json"),
      JSON.stringify(record({ recordId: "valid" })),
      "utf8",
    );
    await writeFile(join(directory, "ignored.tmp"), "not JSON", "utf8");

    assert.deepEqual(
      await readHistoryRecords(directory, sessionId),
      [record({ recordId: "valid" })],
    );

    await writeFile(join(directory, "broken.json"), "{", "utf8");
    await assert.rejects(
      readHistoryRecords(directory, sessionId),
      /Invalid history record broken\.json/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a history filename that does not match its record ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turn-budget-history-"));
  try {
    await writeFile(
      join(directory, "wrong-name.json"),
      JSON.stringify(record({ recordId: "actual-name" })),
      "utf8",
    );

    await assert.rejects(
      readHistoryRecords(directory, sessionId),
      /history filename does not match its record ID/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads an absent history directory as empty", async () => {
  const directory = join(
    tmpdir(),
    `missing-turn-budget-history-${randomUUID()}`,
  );

  assert.deepEqual(await readHistoryRecords(directory, sessionId), []);
});

function record({
  recordId,
  sessionId: recordSessionId = sessionId,
  kind = "ordinary",
  endedAt = "2026-01-01T12:00:00.000Z",
  usedAiCredits = 100,
  capAiCredits = 1000,
  capSource = "ordinary-default",
  outcome = "completed",
} = {}) {
  return {
    schemaVersion: 1,
    recordId,
    sessionId: recordSessionId,
    kind,
    startedAt: "2026-01-01T11:59:00.000Z",
    endedAt,
    startEventId: `start-${recordId}`,
    endEventId: `end-${recordId}`,
    startInteractionId: `interaction-${recordId}`,
    objectiveId: kind === "autopilot" ? 1 : null,
    usedNanoAiu: usedAiCredits * 1_000_000_000,
    capAiCredits,
    capSource,
    outcome,
  };
}
