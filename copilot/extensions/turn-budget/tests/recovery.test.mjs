import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPrimaryAccountingTimestamp,
  isSameBudgetUnit,
  reconcileRecoveryRecord,
  reconcileLatestUnit,
  selectAuthoritativeHistoryRecord,
  selectAccountingTimestamp,
  toCompletedUnit,
} from "../recovery.mjs";

const sessionId = "session-1";

test("uses the persisted accounting timestamp when present", () => {
  const saved = state({
    accountingAt: "2026-09-10T01:00:00.000Z",
    heartbeatAt: "2026-09-10T06:00:00.000Z",
  });

  assert.equal(
    selectAccountingTimestamp(saved, null, sessionId),
    "2026-09-10T01:00:00.000Z",
  );
});

test("uses a matching legacy heartbeat for a pre-accountingAt fault", () => {
  const saved = {
    ...state({ heartbeatAt: "2026-09-10T06:04:15.332Z" }),
    health: { status: "fault" },
  };
  const legacy = state({
    heartbeatAt: "2026-09-10T01:05:55.521Z",
  });

  assert.equal(
    selectAccountingTimestamp(saved, legacy, sessionId),
    "2026-09-10T01:05:55.521Z",
  );
});

test("prefers a healthy saved heartbeat over older legacy state", () => {
  const saved = state({
    heartbeatAt: "2026-09-10T02:00:00.000Z",
  });
  const legacy = state({
    heartbeatAt: "2026-09-10T01:05:55.521Z",
  });

  assert.equal(hasPrimaryAccountingTimestamp(saved), true);
  assert.equal(
    selectAccountingTimestamp(saved, legacy, sessionId),
    "2026-09-10T02:00:00.000Z",
  );
});

test("rejects unrelated legacy accounting for an unhealthy snapshot", () => {
  const saved = {
    ...state({ heartbeatAt: "2026-09-10T06:04:15.332Z" }),
    health: { status: "fault" },
  };
  const legacy = state({
    heartbeatAt: "2026-09-10T01:05:55.521Z",
    openUnit: { id: "other", usedNanoAiu: 123 },
  });

  assert.throws(
    () => selectAccountingTimestamp(saved, legacy, sessionId),
    /no valid accounting timestamp/,
  );
});

test("rejects an unhealthy pre-accountingAt state without matching history", () => {
  const saved = {
    ...state({ heartbeatAt: "2026-09-10T06:04:15.332Z" }),
    health: { status: "fault" },
  };

  assert.throws(
    () => selectAccountingTimestamp(saved, null, sessionId),
    /no valid accounting timestamp/,
  );
});

test("keeps an existing completion instead of replacing it with recovery", () => {
  const candidate = record({
    usedNanoAiu: 100,
    outcome: "interrupted",
    endedAt: "2026-09-10T01:00:00.000Z",
    endEventId: "restart",
  });
  const completed = record({
    usedNanoAiu: 150,
    outcome: "completed",
    endedAt: "2026-09-10T00:59:00.000Z",
    endEventId: "idle",
  });

  assert.deepEqual(
    reconcileRecoveryRecord(candidate, completed),
    completed,
  );
  assert.deepEqual(toCompletedUnit(completed), {
    id: completed.recordId,
    kind: completed.kind,
    phase: "completed",
    startedAt: completed.startedAt,
    startEventId: completed.startEventId,
    startInteractionId: completed.startInteractionId,
    objectiveId: completed.objectiveId,
    usedNanoAiu: completed.usedNanoAiu,
    capAiCredits: completed.capAiCredits,
    capSource: completed.capSource,
    endedAt: completed.endedAt,
    endEventId: completed.endEventId,
    outcome: completed.outcome,
  });
});

test("rejects an existing record that would lose known usage", () => {
  assert.throws(
    () =>
      reconcileRecoveryRecord(
        record({ usedNanoAiu: 150 }),
        record({ usedNanoAiu: 100 }),
      ),
    /conflicts with interrupted recovery/,
  );
});

test("selects the highest immutable completion candidate", () => {
  const provisional = {
    ...record({
      usedNanoAiu: 100,
      outcome: "interrupted",
      endEventId: "restart",
    }),
    provisional: true,
  };
  const completion = record({
    usedNanoAiu: 150,
    outcome: "completed",
    endEventId: "idle",
  });

  assert.deepEqual(
    selectAuthoritativeHistoryRecord([
      provisional,
      record({
        usedNanoAiu: 125,
        outcome: "completed",
        endEventId: "earlier-idle",
      }),
      completion,
    ]),
    completion,
  );
});

test("selects the highest provisional recovery candidate", () => {
  const lower = {
    ...record({ usedNanoAiu: 100, endEventId: "restart-low" }),
    provisional: true,
  };
  const higher = {
    ...record({ usedNanoAiu: 150, endEventId: "restart-high" }),
    provisional: true,
  };

  assert.deepEqual(
    selectAuthoritativeHistoryRecord([lower, higher]),
    higher,
  );
  assert.deepEqual(
    selectAuthoritativeHistoryRecord([higher, lower]),
    higher,
  );
});

test("rejects every real completion below the provisional usage floor", () => {
  const provisional = {
    ...record({ usedNanoAiu: 100 }),
    provisional: true,
  };

  assert.throws(
    () =>
      selectAuthoritativeHistoryRecord([
        provisional,
        record({ usedNanoAiu: 150, outcome: "completed" }),
        record({
          usedNanoAiu: 80,
          outcome: "completed",
          endEventId: "late-low-completion",
        }),
      ]),
    /loses known usage/,
  );
  assert.throws(
    () =>
      selectAuthoritativeHistoryRecord([
        record({
          usedNanoAiu: 80,
          outcome: "completed",
          endEventId: "early-low-completion",
        }),
        provisional,
        record({ usedNanoAiu: 150, outcome: "completed" }),
      ]),
    /loses known usage/,
  );
});

test("does not treat a reused record ID as the same budget unit", () => {
  assert.equal(
    isSameBudgetUnit(
      record({ usedNanoAiu: 200 }),
      {
        ...record({ usedNanoAiu: 100 }),
        startedAt: "2026-09-10T00:01:00.000Z",
      },
    ),
    false,
  );
});

test("refreshes provisional state from a promoted completion", () => {
  const provisionalRecord = {
    ...record({
      usedNanoAiu: 100,
      outcome: "interrupted",
      endEventId: "restart",
    }),
    provisional: true,
  };
  const provisionalUnit = toCompletedUnit(provisionalRecord);
  const completion = record({
    usedNanoAiu: 150,
    outcome: "completed",
    endEventId: "idle",
  });

  assert.deepEqual(
    reconcileLatestUnit(provisionalUnit, completion),
    toCompletedUnit(completion),
  );
});

function state({
  heartbeatAt,
  accountingAt,
  openUnit = { id: "ordinary-root", usedNanoAiu: 123 },
} = {}) {
  return {
    schemaVersion: 1,
    sessionId,
    heartbeatAt,
    health: { status: "ok" },
    ...(accountingAt === undefined ? {} : { accountingAt }),
    accounting: { openUnit },
  };
}

function record({
  usedNanoAiu = 100,
  outcome = "interrupted",
  endedAt = "2026-09-10T01:00:00.000Z",
  endEventId = "restart",
} = {}) {
  return {
    schemaVersion: 1,
    recordId: "ordinary-root",
    sessionId,
    kind: "ordinary",
    startedAt: "2026-09-10T00:00:00.000Z",
    endedAt,
    startEventId: "root",
    endEventId,
    startInteractionId: "interaction",
    objectiveId: null,
    usedNanoAiu,
    capAiCredits: 1000,
    capSource: "ordinary-default",
    outcome,
  };
}
