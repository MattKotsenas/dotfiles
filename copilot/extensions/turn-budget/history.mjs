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
const SPARKLINE_LEVELS = [..."▁▂▃▄▅▆▇█"];
const MODE_CODES = {
  ordinary: "T",
  autopilot: "A",
};
const OUTCOME_CODES = {
  completed: "OK",
  interrupted: "INT",
  "mode-exit": "EXIT",
  "native-cap": "CAP",
  "objective-deleted": "DEL",
  paused: "PAUSE",
  superseded: "NEW",
};
const CAP_SOURCE_CODES = {
  "explicit-native": "GOAL",
  "next-override": "NEXT",
  "autopilot-default": "DEF",
  "ordinary-default": "DEF",
};

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

export function formatBudgetHistory({
  records,
  openUnit,
  limit,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}) {
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
    formatSparkline(recent),
    `Recent ${recent.length}${recent.length < records.length ? ` of ${records.length}` : ""} (local time, newest first):`,
    ...formatHistoryTable(recent, timeZone),
    "M: T turn, A autopilot | Limit: DEF default, NEXT one-shot, GOAL explicit",
    "End: OK completed, INT interrupted, EXIT mode exit, CAP cap, DEL deleted, PAUSE paused, NEW superseded",
  ].join("\n");
}

function formatActiveUnit(unit) {
  const used = toAiCredits(unit.usedNanoAiu);
  const percentage = (used / unit.capAiCredits) * 100;
  return `Active: ${MODE_CODES[unit.kind]} | ${formatUsd(used)} | ${formatAic(used)} / ${formatAic(unit.capAiCredits)} AIC | ${percentFormatter.format(percentage)}% | ${CAP_SOURCE_CODES[unit.capSource]}`;
}

function formatHistoryTable(records, timeZone) {
  const rows = records.map((record) => {
    const used = toAiCredits(record.usedNanoAiu);
    return [
      formatTimestamp(record.endedAt, timeZone),
      MODE_CODES[record.kind],
      formatUsd(used),
      formatAic(used),
      formatAic(record.capAiCredits),
      `${percentFormatter.format((used / record.capAiCredits) * 100)}%`,
      OUTCOME_CODES[record.outcome],
      CAP_SOURCE_CODES[record.capSource],
    ];
  });
  const columns = [
    { header: "When", align: "left" },
    { header: "M", align: "left" },
    { header: "Cost", align: "right" },
    { header: "Used AIC", align: "right" },
    { header: "Cap AIC", align: "right" },
    { header: "%", align: "right" },
    { header: "End", align: "left" },
    { header: "Limit", align: "left" },
  ];
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => row[index].length)),
  );
  const formatRow = (row) =>
    row
      .map((value, index) =>
        columns[index].align === "right"
          ? value.padStart(widths[index])
          : value.padEnd(widths[index]),
      )
      .join("  ")
      .trimEnd();

  return [formatRow(columns.map((column) => column.header)), ...rows.map(formatRow)];
}

function formatSparkline(records) {
  const prices = records
    .toReversed()
    .map((record) => toAiCredits(record.usedNanoAiu));
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  const sparkline =
    minimum === maximum
      ? SPARKLINE_LEVELS[3].repeat(prices.length)
      : prices
          .map((price) => {
            const ratio = (price - minimum) / (maximum - minimum);
            return SPARKLINE_LEVELS[
              Math.round(ratio * (SPARKLINE_LEVELS.length - 1))
            ];
          })
          .join("");
  const range =
    minimum === maximum
      ? formatUsd(minimum)
      : `${formatUsd(minimum)} - ${formatUsd(maximum)}`;

  return `Recent price trend: ${sparkline}  ${range} (oldest -> newest)`;
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

function formatTimestamp(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(new Date(value))
    .reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});

  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
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
