import { isDeepStrictEqual } from "node:util";

export function selectAccountingTimestamp(saved, legacy, sessionId) {
  if (isTimestamp(saved.accountingAt)) {
    return saved.accountingAt;
  }

  if (
    saved.health?.status === "ok" &&
    isTimestamp(saved.heartbeatAt)
  ) {
    return saved.heartbeatAt;
  }

  if (
    legacy?.schemaVersion === saved.schemaVersion &&
    legacy.sessionId === sessionId &&
    legacy.health?.status === "ok" &&
    isTimestamp(legacy.accountingAt ?? legacy.heartbeatAt) &&
    isDeepStrictEqual(legacy.accounting, saved.accounting)
  ) {
    return legacy.accountingAt ?? legacy.heartbeatAt;
  }

  throw new Error("Persisted state has no valid accounting timestamp");
}

export function hasPrimaryAccountingTimestamp(saved) {
  return (
    isTimestamp(saved.accountingAt) ||
    (saved.health?.status === "ok" && isTimestamp(saved.heartbeatAt))
  );
}

export function reconcileRecoveryRecord(candidate, existing) {
  if (existing === null) {
    return candidate;
  }

  if (
    !sameBudgetUnit(existing, candidate) ||
    existing.usedNanoAiu < candidate.usedNanoAiu
  ) {
    throw new Error(
      `History record ${candidate.recordId} conflicts with interrupted recovery`,
    );
  }

  return existing;
}

export function reconcileLatestUnit(unit, record) {
  if (
    !sameCompletedUnit(unit, record) ||
    record.usedNanoAiu < unit.usedNanoAiu
  ) {
    throw new Error(
      `History record ${record.recordId} conflicts with provisional state`,
    );
  }

  return toCompletedUnit(record);
}

export function selectAuthoritativeHistoryRecord(records) {
  if (records.length === 0) {
    return null;
  }

  const first = records[0];
  for (const record of records.slice(1)) {
    if (!sameBudgetUnit(first, record)) {
      throw new Error(
        `History record ${record.recordId} belongs to another budget unit`,
      );
    }
  }

  const provisionalFloor = Math.max(
    0,
    ...records
      .filter((record) => record.provisional === true)
      .map((record) => record.usedNanoAiu),
  );
  for (const record of records) {
    if (
      record.provisional !== true &&
      record.usedNanoAiu < provisionalFloor
    ) {
      throw new Error(
        `History record ${record.recordId} loses known usage`,
      );
    }
  }

  let selected = first;
  for (const record of records.slice(1)) {
    const selectedProvisional = selected.provisional === true;
    const recordProvisional = record.provisional === true;
    if (
      record.usedNanoAiu > selected.usedNanoAiu ||
      (record.usedNanoAiu === selected.usedNanoAiu &&
        selectedProvisional &&
        !recordProvisional)
    ) {
      selected = record;
    } else if (
      record.usedNanoAiu === selected.usedNanoAiu &&
      recordProvisional === selectedProvisional &&
      !isDeepStrictEqual(record, selected)
    ) {
      throw new Error(
        `History record ${record.recordId} has conflicting completions`,
      );
    }
  }

  return selected;
}

export function isSameBudgetUnit(left, right) {
  return sameBudgetUnit(left, right);
}

export function toCompletedUnit(record) {
  return {
    id: record.recordId,
    kind: record.kind,
    phase: "completed",
    startedAt: record.startedAt,
    startEventId: record.startEventId,
    startInteractionId: record.startInteractionId,
    objectiveId: record.objectiveId,
    usedNanoAiu: record.usedNanoAiu,
    capAiCredits: record.capAiCredits,
    capSource: record.capSource,
    endedAt: record.endedAt,
    endEventId: record.endEventId,
    outcome: record.outcome,
    ...(record.provisional === true ? { provisional: true } : {}),
  };
}

function sameBudgetUnit(left, right) {
  return [
    "recordId",
    "sessionId",
    "kind",
    "startedAt",
    "startEventId",
    "startInteractionId",
    "objectiveId",
    "capAiCredits",
    "capSource",
  ].every((name) => isDeepStrictEqual(left[name], right[name]));
}

function sameCompletedUnit(unit, record) {
  return (
    unit.id === record.recordId &&
    [
      "kind",
      "startedAt",
      "startEventId",
      "startInteractionId",
      "objectiveId",
      "capAiCredits",
      "capSource",
    ].every((name) => isDeepStrictEqual(unit[name], record[name]))
  );
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value))
  );
}
