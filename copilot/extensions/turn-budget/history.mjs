import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const KINDS = new Set(["ordinary", "autopilot"]);
const CAP_SOURCES = new Set([
  "explicit-native",
  "next-override",
  "autopilot-default",
  "ordinary-default",
]);
const OUTCOMES = new Set([
  "completed",
  "interrupted",
  "mode-exit",
  "native-cap",
  "objective-deleted",
  "paused",
  "superseded",
]);
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECORD_ID = /^[A-Za-z0-9._-]+$/;
const aiCreditFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const percentFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

export async function readHistoryRecords(historyPath, sessionId) {
  let entries;
  try {
    entries = await readdir(historyPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        try {
          const value = JSON.parse(
            await readFile(join(historyPath, entry.name), "utf8"),
          );
          const record = validateHistoryRecord(value, sessionId);
          if (entry.name !== `${record.recordId}.json`) {
            throw new TypeError("history filename does not match its record ID");
          }
          return record;
        } catch (error) {
          throw new Error(`Invalid history record ${entry.name}: ${error.message}`, {
            cause: error,
          });
        }
      }),
  );

  assertUniqueRecordIds(records);
  return records;
}

export function validateHistoryRecord(value, sessionId) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    value.sessionId !== sessionId ||
    typeof value.recordId !== "string" ||
    !RECORD_ID.test(value.recordId) ||
    !KINDS.has(value.kind) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.endedAt) ||
    !isNonEmptyString(value.startEventId) ||
    !isNonEmptyString(value.endEventId) ||
    !isOptionalString(value.startInteractionId) ||
    !isOptionalInteger(value.objectiveId) ||
    !Number.isSafeInteger(value.usedNanoAiu) ||
    value.usedNanoAiu < 0 ||
    !Number.isFinite(value.capAiCredits) ||
    value.capAiCredits <= 0 ||
    !CAP_SOURCES.has(value.capSource) ||
    !OUTCOMES.has(value.outcome) ||
    Date.parse(value.endedAt) < Date.parse(value.startedAt)
  ) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.sessionId !== undefined &&
      value.sessionId !== sessionId
    ) {
      throw new TypeError("history record belongs to another session");
    }
    throw new TypeError("history record contains unsupported values");
  }

  return structuredClone(value);
}

export function formatBudgetHistory({ records, openUnit, limit }) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("history limit must be a positive integer");
  }

  assertUniqueRecordIds(records);

  if (records.length === 0) {
    return [
      "Budget history: no completed units",
      openUnit ? formatActiveUnit(openUnit) : "Active: none",
    ].join("\n");
  }

  const newestFirst = records.toSorted(
    (left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt),
  );
  const usage = records
    .map((record) => toAiCredits(record.usedNanoAiu))
    .toSorted((left, right) => left - right);
  const total = usage.reduce((sum, value) => sum + value, 0);
  const average = total / usage.length;
  const median =
    usage.length % 2 === 1
      ? usage[(usage.length - 1) / 2]
      : (usage[usage.length / 2 - 1] + usage[usage.length / 2]) / 2;
  const maximum = usage.at(-1);
  const overCap = records.filter(
    (record) => toAiCredits(record.usedNanoAiu) > record.capAiCredits,
  ).length;
  const recent = newestFirst.slice(0, limit);

  return [
    `Budget history: ${records.length} completed | over cap ${overCap}`,
    `Total: ${formatPrice(total)}`,
    `Typical: median ${formatPrice(median)} | average ${formatPrice(average)}`,
    `Maximum: ${formatPrice(maximum)}`,
    openUnit ? formatActiveUnit(openUnit) : "Active: none",
    `Recent ${recent.length}${recent.length < records.length ? ` of ${records.length}` : ""} (newest first):`,
    ...recent.map(formatCompletedUnit),
  ].join("\n");
}

function formatActiveUnit(unit) {
  return `Active: ${unit.kind} | ${formatUsage(unit)} | ${unit.capSource}`;
}

function formatCompletedUnit(record) {
  return `${formatTimestamp(record.endedAt)} | ${record.kind} | ${formatUsage(record)} | ${record.outcome} | ${record.capSource}`;
}

function formatUsage(unit) {
  const used = toAiCredits(unit.usedNanoAiu);
  const percentage = (used / unit.capAiCredits) * 100;
  return `${formatAic(used)} / ${formatAic(unit.capAiCredits)} AIC (${formatUsd(used)} / ${formatUsd(unit.capAiCredits)}) | ${percentFormatter.format(percentage)}%`;
}

function formatPrice(aiCredits) {
  return `${formatAic(aiCredits)} AIC (${formatUsd(aiCredits)})`;
}

function formatAic(value) {
  return aiCreditFormatter.format(value);
}

function formatUsd(aiCredits) {
  return usdFormatter.format(aiCredits / 100);
}

function formatTimestamp(value) {
  return `${new Date(value).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function toAiCredits(nanoAiu) {
  return nanoAiu / 1_000_000_000;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value) {
  return value === null || isNonEmptyString(value);
}

function isOptionalInteger(value) {
  return value === null || Number.isSafeInteger(value);
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP.test(value) &&
    new Date(value).toISOString() === value
  );
}

function assertUniqueRecordIds(records) {
  const recordIds = records.map((record) => record.recordId);
  if (
    recordIds.some(
      (recordId) =>
        typeof recordId !== "string" ||
        !RECORD_ID.test(recordId),
    )
  ) {
    throw new TypeError("history contains an invalid record ID");
  }

  if (new Set(recordIds).size !== records.length) {
    throw new TypeError("history contains duplicate record IDs");
  }
}
