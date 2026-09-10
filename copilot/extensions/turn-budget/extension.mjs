import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { joinSession } from "@github/copilot-sdk/extension";
import {
  createAccountingState,
  reduceAccounting,
  restoreAccountingState,
  validatePolicy,
} from "./accounting.mjs";
import { parseBudgetCommand } from "./budget-command.mjs";
import {
  formatBudgetHistory,
  readHistoryRecord,
  readHistoryRecords,
} from "./history.mjs";
import {
  allocateStateGeneration,
  getHistoryCandidatePath,
  getHistoryPath,
  readLatestState,
  readJsonIfExists,
  writeJsonExclusive,
  writeStateSnapshot,
} from "./persistence.mjs";
import {
  hasPrimaryAccountingTimestamp,
  isSameBudgetUnit,
  reconcileRecoveryRecord,
  reconcileLatestUnit,
  selectAccountingTimestamp,
  toCompletedUnit,
} from "./recovery.mjs";
import { createOperationQueue } from "./operation-queue.mjs";

const STATE_SCHEMA_VERSION = 1;
const TRACKED_EVENTS = new Set([
  "session.mode_changed",
  "session.autopilot_objective_changed",
  "session.task_complete",
  "user.message",
  "assistant.usage",
  "session.idle",
  "session.shutdown",
]);
const aiCreditFormatter = new Intl.NumberFormat("en-US");

const config = parseConfig(
  JSON.parse(await readFile(new URL("./config.json", import.meta.url), "utf8")),
);

const operations = createOperationQueue(reportFailure);
const session = await joinSession({
  commands: [
    {
      name: "budget",
      description: "Set the next cap or show turn prices",
      handler: handleBudgetCommand,
    },
  ],
});

if (!session.workspacePath) {
  throw new Error("Turn budget requires an infinite-session workspace");
}

const instanceId = randomUUID();
const root = join(session.workspacePath, "files", "turn-budget");
const extensionGeneration = await allocateStateGeneration(root);
const policy = validatePolicy(config);

let accounting = createAccountingState();
let revision = 0;
let heartbeat;
let accountingAt = null;

operations.enqueue(initialize);

session.on((event) => {
  if (TRACKED_EVENTS.has(event.type)) {
    operations.enqueue(() => processEvent(event));
  }
});

async function initialize() {
  const [saved, mode, activity, objective] = await Promise.all([
    readLatestState(root),
    session.rpc.mode.get(),
    session.rpc.metadata.activity(),
    readCurrentObjective(),
  ]);
  let recoveredUnit = false;

  if (saved) {
    if (
      saved.schemaVersion !== STATE_SCHEMA_VERSION ||
      saved.sessionId !== session.sessionId
    ) {
      throw new Error("Persisted state belongs to another schema or session");
    }

    accounting = restoreAccountingState(saved.accounting);
    revision = saved.revision;
    accountingAt = await resolveAccountingTimestamp(saved);
  } else {
    accounting = createAccountingState({
      mode,
      objectiveId: objective?.id ?? null,
      objectiveStatus: objective?.status ?? null,
    });
  }

  if (activity.hasActiveWork) {
    throw new Error(
      "Turn budget loaded after active work began and cannot reconstruct its usage",
    );
  }

  if (saved) {
    if (
      accounting.openUnit &&
      accounting.openUnit.phase !== "quiescent"
    ) {
      const recovery = reduceAccounting(
        accounting,
        {
          type: "session.shutdown",
          id: `restart-${instanceId}`,
          timestamp: accountingAt,
          data: {},
        },
        policy,
      );
      const record = await writeRecoveryRecord(recovery.completedUnits[0]);
      accounting = {
        ...recovery.state,
        latestUnit: toCompletedUnit(record),
      };
      recoveredUnit = true;
    }

    if (
      accounting.openUnit &&
      (accounting.mode !== mode ||
        (accounting.objective.id ?? null) !== (objective?.id ?? null) ||
        (accounting.objective.status ?? null) !==
          (objective?.status ?? null))
    ) {
      throw new Error(
        "Turn budget lost event continuity while a budget unit was open",
      );
    }

    if (
      !accounting.openUnit &&
      objective?.status === "active" &&
      !recoveredUnit
    ) {
      throw new Error(
        "Turn budget has no open unit for the active objective",
      );
    }

    if (!accounting.openUnit) {
      accounting.mode = mode;
      accounting.objective = {
        id: objective?.id ?? null,
        status: objective?.status ?? null,
      };
    }
  } else {
    if (objective?.status === "active") {
      throw new Error(
        "Turn budget loaded after active work began and cannot reconstruct its usage",
      );
    }
  }

  await persistState();
  if (recoveredUnit) {
    await session.log(
      "Recovered the last known partial budget unit as interrupted",
      { level: "warning" },
    );
  }
  heartbeat = setInterval(
    () => operations.enqueue(persistState),
    config.heartbeatSeconds * 1000,
  );
  heartbeat.unref();
}

async function processEvent(event) {
  const normalized = await normalizeEvent(event);
  await applyAccountingEvent(normalized);

  if (event.type === "session.shutdown") {
    clearInterval(heartbeat);
  }
}

async function applyAccountingEvent(event) {
  const result = reduceAccounting(accounting, event, policy);

  const completedRecords = await writeCompletedUnits(result.completedUnits);
  accounting = result.state;
  if (completedRecords.length > 0) {
    accounting.latestUnit = toCompletedUnit(completedRecords.at(-1));
  }
  accountingAt = event.timestamp;
  await persistState();
}

async function handleBudgetCommand({ args }) {
  let command;
  try {
    command = parseBudgetCommand(args);
  } catch (error) {
    await session.log(error.message, { level: "error" });
    return;
  }

  if (command.action === "history") {
    return operations.enqueueRead(async () => {
      try {
        const records = await readHistoryRecords(
          join(root, "history"),
          session.sessionId,
        );
        await session.log(
          formatBudgetHistory({
            records,
            openUnit: accounting.openUnit,
            limit: command.limit,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await session.log(`Budget history unavailable: ${message}`, {
          level: "error",
        });
      }
    });
  }

  return operations.enqueue(async () => {
    await applyAccountingEvent({
      type: "budget.next",
      id: `budget-next-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      data: { aiCredits: command.aiCredits },
    });
    await session.log(
      `Next budget set to ${aiCreditFormatter.format(command.aiCredits)} AIC`,
    );
  });
}

async function normalizeEvent(event) {
  const normalized = {
    type: event.type,
    id: event.id,
    timestamp: event.timestamp,
    data: {},
  };

  switch (event.type) {
    case "session.mode_changed":
      normalized.data = {
        previousMode: event.data.previousMode,
        newMode: event.data.newMode,
      };
      break;

    case "session.autopilot_objective_changed": {
      const objective =
        event.data.status === "active" ? await readCurrentObjective() : null;
      if (
        event.data.status === "active" &&
        (!objective || objective.id !== event.data.id)
      ) {
        throw new Error("Active objective state is unavailable or mismatched");
      }
      normalized.data = {
        operation: event.data.operation,
        id: event.data.id,
        status: event.data.status,
        ...(objective?.creditLimitAiCredits === undefined
          ? {}
          : { creditLimitAiCredits: objective.creditLimitAiCredits }),
      };
      break;
    }

    case "user.message":
      normalized.data = {
        source: event.data.source,
        delivery: event.data.delivery,
        agentMode: event.data.agentMode,
        isAutopilotContinuation: event.data.isAutopilotContinuation,
        interactionId: event.data.interactionId,
      };
      break;

    case "assistant.usage":
      normalized.data = {
        totalNanoAiu: event.data.copilotUsage?.totalNanoAiu,
      };
      break;

    case "session.task_complete":
      normalized.data = { success: event.data.success };
      break;
  }

  return normalized;
}

async function readCurrentObjective() {
  const { content } = await session.rpc.workspaces.readAutopilotObjective();
  if (content === null) {
    return null;
  }

  const current = JSON.parse(content).current;
  if (!current) {
    return null;
  }

  if (
    !Number.isInteger(current.id) ||
    typeof current.status !== "string" ||
    (current.creditLimit !== undefined &&
      (!Number.isFinite(current.creditLimit?.credits) ||
        current.creditLimit.credits <= 0))
  ) {
    throw new Error("Autopilot objective contains unsupported values");
  }

  return {
    id: current.id,
    status: current.status,
    creditLimitAiCredits: current.creditLimit?.credits,
  };
}

async function persistState() {
  await refreshLatestUnit();
  const heartbeatAt = new Date().toISOString();
  accountingAt ??= heartbeatAt;
  revision += 1;
  await writeStateSnapshot(
    root,
    {
      schemaVersion: STATE_SCHEMA_VERSION,
      sessionId: session.sessionId,
      extensionInstanceId: instanceId,
      extensionGeneration,
      revision,
      heartbeatAt,
      accountingAt,
      health: { status: "ok" },
      accounting,
    },
    instanceId,
    extensionGeneration,
  );
}

async function refreshLatestUnit() {
  const latestUnit = accounting.latestUnit;
  if (!latestUnit) {
    return;
  }

  const record = await readHistoryRecord(
    join(root, "history"),
    session.sessionId,
    latestUnit.id,
  );
  accounting.latestUnit = reconcileLatestUnit(latestUnit, record);
}

async function writeCompletedUnits(units) {
  const records = [];
  for (const unit of units) {
    const record = toHistoryRecord(unit);
    const existing = await writeHistoryRecord(record);
    if (isDeepStrictEqual(existing, record)) {
      records.push(record);
      continue;
    }
    if (
      isSameBudgetUnit(existing, record) &&
      existing.usedNanoAiu >= record.usedNanoAiu &&
      existing.provisional !== true
    ) {
      records.push(existing);
      continue;
    }

    await writeJsonExclusive(
      getHistoryCandidatePath(
        root,
        record.recordId,
        record.usedNanoAiu,
        instanceId,
      ),
      record,
      instanceId,
    );
    const authoritative = await readHistoryRecord(
      join(root, "history"),
      session.sessionId,
      record.recordId,
    );
    if (
      authoritative.provisional === true ||
      authoritative.usedNanoAiu < record.usedNanoAiu
    ) {
      throw new Error(
        `History record ${record.recordId} did not retain completed usage`,
      );
    }
    records.push(authoritative);
  }
  return records;
}

async function writeRecoveryRecord(unit) {
  const record = toHistoryRecord(unit, { provisional: true });
  const existing = await writeHistoryRecord(record);
  if (
    isSameBudgetUnit(existing, record) &&
    existing.usedNanoAiu < record.usedNanoAiu
  ) {
    await writeJsonExclusive(
      getHistoryCandidatePath(
        root,
        record.recordId,
        record.usedNanoAiu,
        instanceId,
      ),
      record,
      instanceId,
    );
    return readHistoryRecord(
      join(root, "history"),
      session.sessionId,
      record.recordId,
    );
  }
  return reconcileRecoveryRecord(record, existing);
}

async function writeHistoryRecord(record) {
  const path = getHistoryPath(root, record.recordId);
  if (await writeJsonExclusive(path, record, instanceId)) {
    return record;
  }

  return readHistoryRecord(
    join(root, "history"),
    session.sessionId,
    record.recordId,
  );
}

async function reportFailure(error) {
  clearInterval(heartbeat);
  const message = error instanceof Error ? error.message : String(error);

  await writeStateSnapshot(
    root,
    {
      schemaVersion: STATE_SCHEMA_VERSION,
      sessionId: session.sessionId,
      extensionInstanceId: instanceId,
      extensionGeneration,
      revision: revision + 1,
      heartbeatAt: new Date().toISOString(),
      accountingAt,
      health: { status: "fault", message },
      accounting,
    },
    instanceId,
    extensionGeneration,
  );
  await session.log(`Turn budget stopped: ${message}`, { level: "error" });
}

function toHistoryRecord(unit, { provisional = false } = {}) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    recordId: unit.id,
    sessionId: session.sessionId,
    kind: unit.kind,
    startedAt: unit.startedAt,
    endedAt: unit.endedAt,
    startEventId: unit.startEventId,
    endEventId: unit.endEventId,
    startInteractionId: unit.startInteractionId,
    objectiveId: unit.objectiveId,
    usedNanoAiu: unit.usedNanoAiu,
    capAiCredits: unit.capAiCredits,
    capSource: unit.capSource,
    outcome: unit.outcome,
    ...(provisional ? { provisional: true } : {}),
  };
}

async function resolveAccountingTimestamp(saved) {
  if (hasPrimaryAccountingTimestamp(saved)) {
    return selectAccountingTimestamp(saved, null, session.sessionId);
  }

  const legacy = await readJsonIfExists(join(root, "state.json"));
  return selectAccountingTimestamp(saved, legacy, session.sessionId);
}

function parseConfig(value) {
  if (
    value?.schemaVersion !== 1 ||
    !Number.isFinite(value.heartbeatSeconds) ||
    value.heartbeatSeconds <= 0
  ) {
    throw new TypeError("config.json contains unsupported values");
  }

  return value;
}
