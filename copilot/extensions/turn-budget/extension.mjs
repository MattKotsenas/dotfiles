import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";
import {
  createAccountingState,
  reduceAccounting,
  restoreAccountingState,
  validatePolicy,
} from "./accounting.mjs";
import { parseBudgetCommand } from "./budget-command.mjs";
import {
  getHistoryPath,
  readJsonIfExists,
  writeJsonAtomic,
} from "./persistence.mjs";
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
      description: "Set the AI-credit cap for the next budget unit",
      handler: handleBudgetCommand,
    },
  ],
});

if (!session.workspacePath) {
  throw new Error("Turn budget requires an infinite-session workspace");
}

const instanceId = randomUUID();
const root = join(session.workspacePath, "files", "turn-budget");
const statePath = join(root, "state.json");
const policy = validatePolicy(config);

let accounting = createAccountingState();
let revision = 0;
let heartbeat;

operations.enqueue(initialize);

session.on((event) => {
  if (TRACKED_EVENTS.has(event.type)) {
    operations.enqueue(() => processEvent(event));
  }
});

async function initialize() {
  const [saved, mode, activity, objective] = await Promise.all([
    readJsonIfExists(statePath),
    session.rpc.mode.get(),
    session.rpc.metadata.activity(),
    readCurrentObjective(),
  ]);

  if (saved) {
    if (
      saved.schemaVersion !== STATE_SCHEMA_VERSION ||
      saved.sessionId !== session.sessionId
    ) {
      throw new Error("state.json belongs to another schema or session");
    }

    accounting = restoreAccountingState(saved.accounting);
    revision = saved.revision;
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
      throw new Error(
        "Turn budget restarted after an active unit lost event continuity",
      );
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

    if (!accounting.openUnit && objective?.status === "active") {
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

  for (const unit of result.completedUnits) {
    await writeJsonAtomic(
      getHistoryPath(root, unit.id),
      toHistoryRecord(unit),
      instanceId,
    );
  }

  accounting = result.state;
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

  return operations.enqueue(async () => {
    await applyAccountingEvent({
      type: "budget.next",
      id: `budget-next-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      data: command,
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
  revision += 1;
  await writeJsonAtomic(
    statePath,
    {
      schemaVersion: STATE_SCHEMA_VERSION,
      sessionId: session.sessionId,
      extensionInstanceId: instanceId,
      revision,
      heartbeatAt: new Date().toISOString(),
      health: { status: "ok" },
      accounting,
    },
    instanceId,
  );
}

async function reportFailure(error) {
  clearInterval(heartbeat);
  const message = error instanceof Error ? error.message : String(error);

  await writeJsonAtomic(
    statePath,
    {
      schemaVersion: STATE_SCHEMA_VERSION,
      sessionId: session.sessionId,
      extensionInstanceId: instanceId,
      revision: revision + 1,
      heartbeatAt: new Date().toISOString(),
      health: { status: "fault", message },
      accounting,
    },
    instanceId,
  );
  await session.log(`Turn budget stopped: ${message}`, { level: "error" });
}

function toHistoryRecord(unit) {
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
  };
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
