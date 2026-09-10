const SCHEMA_VERSION = 1;
const MODES = new Set(["interactive", "plan", "autopilot"]);
const TERMINAL_OBJECTIVE_STATUSES = new Set([
  "paused",
  "cap_reached",
  "completed",
]);

export function validatePolicy(policy) {
  for (const name of ["ordinaryAiCredits", "autopilotAiCredits"]) {
    if (!Number.isFinite(policy[name]) || policy[name] <= 0) {
      throw new TypeError(`${name} must be a positive finite number`);
    }
  }

  return policy;
}

export function createAccountingState({
  mode = "interactive",
  objectiveId = null,
  objectiveStatus = null,
} = {}) {
  assertMode(mode);

  return {
    schemaVersion: SCHEMA_VERSION,
    mode,
    objective: {
      id: objectiveId,
      status: objectiveStatus,
    },
    pendingOverride: null,
    openUnit: null,
    latestUnit: null,
  };
}

export function restoreAccountingState(value) {
  if (
    value?.schemaVersion !== SCHEMA_VERSION ||
    !MODES.has(value.mode) ||
    !isObjective(value.objective) ||
    !isPendingOverride(value.pendingOverride ?? null) ||
    !isUnitOrNull(value.openUnit) ||
    !isUnitOrNull(value.latestUnit)
  ) {
    throw new TypeError("Persisted state contains an unsupported accounting state");
  }

  return {
    ...structuredClone(value),
    pendingOverride: value.pendingOverride ?? null,
  };
}

export function reduceAccounting(state, event, policy) {
  validatePolicy(policy);
  assertEvent(event);

  const next = structuredClone(state);
  const completedUnits = [];

  const finish = (endedAt, endEventId, outcome) => {
    const openUnit = next.openUnit;
    if (!openUnit) {
      throw new Error("Cannot finish a budget unit when none is open");
    }

    const completed = {
      ...openUnit,
      phase: "completed",
      endedAt,
      endEventId,
      outcome,
    };

    delete completed.lastIdleAt;
    delete completed.lastIdleEventId;
    delete completed.terminalReason;

    next.openUnit = null;
    next.latestUnit = completed;
    completedUnits.push(completed);
  };

  const start = (kind) => {
    if (next.openUnit) {
      throw new Error("Cannot start a budget unit while another is open");
    }

    const explicitCap = event.data?.creditLimitAiCredits;
    if (
      explicitCap !== undefined &&
      (!Number.isFinite(explicitCap) || explicitCap <= 0)
    ) {
      throw new TypeError("creditLimitAiCredits must be positive and finite");
    }

    const usesExplicitCap = kind === "autopilot" && explicitCap !== undefined;
    const pendingOverride = next.pendingOverride;
    const usesPendingOverride =
      !usesExplicitCap && pendingOverride !== null;
    next.pendingOverride = null;

    next.openUnit = {
      id: `${kind}-${event.id}`,
      kind,
      phase: "active",
      startedAt: event.timestamp,
      startEventId: event.id,
      startInteractionId: event.data?.interactionId ?? null,
      objectiveId: next.objective.id,
      usedNanoAiu: 0,
      capAiCredits: usesExplicitCap
        ? explicitCap
        : usesPendingOverride
          ? pendingOverride.aiCredits
          : kind === "autopilot"
            ? policy.autopilotAiCredits
            : policy.ordinaryAiCredits,
      capSource: usesExplicitCap
        ? "explicit-native"
        : usesPendingOverride
          ? "next-override"
          : kind === "autopilot"
            ? "autopilot-default"
            : "ordinary-default",
      lastIdleAt: null,
      lastIdleEventId: null,
      terminalReason: null,
    };
  };

  const signalAutopilotTerminal = (reason) => {
    if (next.openUnit?.kind !== "autopilot") {
      return;
    }

    if (next.openUnit.phase === "quiescent") {
      finish(
        next.openUnit.lastIdleAt,
        next.openUnit.lastIdleEventId,
        reason,
      );
      return;
    }

    next.openUnit.phase = "terminal-pending";
    next.openUnit.terminalReason = reason;
  };

  switch (event.type) {
    case "budget.next": {
      const aiCredits = event.data.aiCredits;
      if (!Number.isSafeInteger(aiCredits) || aiCredits <= 0) {
        throw new TypeError(
          "budget.next requires a positive safe integer AI-credit cap",
        );
      }

      next.pendingOverride = {
        aiCredits,
        setAt: event.timestamp,
        setEventId: event.id,
      };
      break;
    }

    case "session.mode_changed": {
      assertMode(event.data.newMode);
      const previousMode = next.mode;
      next.mode = event.data.newMode;

      if (previousMode === "autopilot" && next.mode !== "autopilot") {
        signalAutopilotTerminal("mode-exit");
      }
      break;
    }

    case "session.autopilot_objective_changed": {
      const previousStatus = next.objective.status;
      const { operation, status } = event.data;

      if (operation === "delete") {
        next.objective = { id: null, status: null };
        signalAutopilotTerminal("objective-deleted");
        break;
      }

      next.objective = {
        id: event.data.id ?? next.objective.id,
        status: status ?? next.objective.status,
      };

      if (status === "active") {
        const startsNewUnit =
          operation === "create" ||
          TERMINAL_OBJECTIVE_STATUSES.has(previousStatus);

        if (startsNewUnit) {
          if (next.openUnit?.kind === "autopilot") {
            if (next.openUnit.phase !== "quiescent") {
              throw new Error(
                "An objective started while an autopilot budget unit was active",
              );
            }

            finish(
              next.openUnit.lastIdleAt,
              next.openUnit.lastIdleEventId,
              "superseded",
            );
          }

          start("autopilot");
        } else if (next.openUnit?.kind === "autopilot") {
          if (next.openUnit.phase === "terminal-pending") {
            throw new Error(
              "An objective became active after a terminal signal",
            );
          }

          next.openUnit.phase = "active";
          next.openUnit.lastIdleAt = null;
          next.openUnit.lastIdleEventId = null;
        } else {
          start("autopilot");
        }
      } else if (status === "paused") {
        signalAutopilotTerminal("paused");
      } else if (status === "cap_reached") {
        signalAutopilotTerminal("native-cap");
      } else if (status === "completed") {
        signalAutopilotTerminal("completed");
      }
      break;
    }

    case "user.message": {
      const isAutomatic =
        event.data.source === "autopilot" ||
        event.data.isAutopilotContinuation === true;
      const isObjectiveRoot = event.data.source === "autopilot-objective";
      const isDescendant =
        typeof event.data.source === "string" &&
        event.data.source.startsWith("agent-");
      const isQueued = event.data.delivery === "queued";
      const isSteering = event.data.delivery === "steering";
      const kind =
        isAutomatic ||
        isObjectiveRoot ||
        event.data.agentMode === "autopilot" ||
        next.mode === "autopilot"
          ? "autopilot"
          : "ordinary";

      if (!next.openUnit) {
        if (isDescendant || isQueued || isSteering) {
          throw new Error(
            "An in-flight user message arrived without an open unit",
          );
        }

        start(kind);
        break;
      }

      if (next.openUnit.kind === "ordinary") {
        break;
      }

      if (isDescendant) {
        break;
      }

      if (isAutomatic || isObjectiveRoot) {
        if (next.openUnit.phase === "terminal-pending") {
          throw new Error(
            "An autopilot continuation arrived after a terminal signal",
          );
        }

        next.openUnit.phase = "active";
        next.openUnit.lastIdleAt = null;
        next.openUnit.lastIdleEventId = null;
        break;
      }

      if (
        next.openUnit.phase === "quiescent" &&
        !isQueued &&
        !isSteering
      ) {
        finish(
          next.openUnit.lastIdleAt,
          next.openUnit.lastIdleEventId,
          "superseded",
        );
        start(kind);
      } else if (
        next.openUnit.phase === "active" &&
        !isQueued &&
        !isSteering
      ) {
        throw new Error(
          "New root work arrived before the autopilot unit became idle",
        );
      }
      break;
    }

    case "assistant.usage": {
      const usedNanoAiu = event.data.totalNanoAiu;
      if (!Number.isSafeInteger(usedNanoAiu) || usedNanoAiu < 0) {
        throw new TypeError(
          "assistant.usage must contain a non-negative safe integer totalNanoAiu",
        );
      }
      if (!next.openUnit) {
        throw new Error("Usage arrived without an open budget unit");
      }

      const total = next.openUnit.usedNanoAiu + usedNanoAiu;
      if (!Number.isSafeInteger(total)) {
        throw new RangeError("Budget unit usage exceeds safe integer precision");
      }
      next.openUnit.usedNanoAiu = total;
      break;
    }

    case "session.task_complete":
      if (event.data.success === true) {
        signalAutopilotTerminal("completed");
      }
      break;

    case "session.idle":
      if (next.openUnit?.kind === "ordinary") {
        finish(event.timestamp, event.id, "completed");
      } else if (next.openUnit?.kind === "autopilot") {
        if (next.openUnit.phase === "terminal-pending") {
          finish(
            event.timestamp,
            event.id,
            next.openUnit.terminalReason ?? "completed",
          );
        } else {
          next.openUnit.phase = "quiescent";
          next.openUnit.lastIdleAt = event.timestamp;
          next.openUnit.lastIdleEventId = event.id;
        }
      }
      break;

    case "session.shutdown":
      if (next.openUnit) {
        finish(event.timestamp, event.id, "interrupted");
      }
      break;
  }

  return { state: next, completedUnits };
}

function assertEvent(event) {
  if (
    typeof event?.type !== "string" ||
    typeof event.id !== "string" ||
    event.id.length === 0 ||
    typeof event.timestamp !== "string" ||
    Number.isNaN(Date.parse(event.timestamp))
  ) {
    throw new TypeError("Accounting events require a type, id, and timestamp");
  }
}

function assertMode(mode) {
  if (!MODES.has(mode)) {
    throw new TypeError(`Unsupported session mode: ${mode}`);
  }
}

function isObjective(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    (value.id === null || Number.isInteger(value.id)) &&
    (value.status === null || typeof value.status === "string")
  );
}

function isPendingOverride(value) {
  return (
    value === null ||
    (typeof value === "object" &&
      Number.isSafeInteger(value.aiCredits) &&
      value.aiCredits > 0 &&
      typeof value.setAt === "string" &&
      !Number.isNaN(Date.parse(value.setAt)) &&
      typeof value.setEventId === "string" &&
      value.setEventId.length > 0)
  );
}

function isUnitOrNull(value) {
  return (
    value === null ||
    (typeof value === "object" &&
      typeof value.id === "string" &&
      Number.isSafeInteger(value.usedNanoAiu))
  );
}
