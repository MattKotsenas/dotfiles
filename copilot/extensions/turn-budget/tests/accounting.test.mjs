import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createAccountingState,
  reduceAccounting,
  restoreAccountingState,
} from "../accounting.mjs";

const policy = {
  ordinaryAiCredits: 1000,
  autopilotAiCredits: 1000,
};
const fixtures = JSON.parse(
  await readFile(
    new URL("./fixtures/observed-timelines.json", import.meta.url),
    "utf8",
  ),
);

for (const name of [
  "ordinary",
  "explicit",
  "inferred",
  "pauseResume",
  "continuationExhaustion",
]) {
  test(`accounts the observed ${name} timeline`, () => {
    const result = run(fixtures[name].events);
    assert.deepEqual(result.completedUnits.map(project), fixtures[name].expected);
  });
}

test("keeps continuation exhaustion quiescent until a later event proves the boundary", () => {
  const events = fixtures.continuationExhaustion.events.slice(0, -1);
  const result = run(events);

  assert.equal(result.completedUnits.length, 0);
  assert.equal(result.state.openUnit.phase, "quiescent");
  assert.equal(result.state.openUnit.usedNanoAiu, 3010575000);
});

test("uses the retained idle timestamp when new root work supersedes a quiescent unit", () => {
  const events = fixtures.continuationExhaustion.events.slice(0, -1);
  events.push({
    type: "user.message",
    id: "next-root",
    timestamp: "2026-09-07T01:16:00.000Z",
    data: {
      delivery: "idle",
      agentMode: "autopilot",
      interactionId: "next-interaction",
    },
  });

  const result = run(events);
  assert.equal(result.completedUnits[0].outcome, "superseded");
  assert.equal(
    result.completedUnits[0].endedAt,
    "2026-09-07T01:14:30.692Z",
  );
  assert.equal(result.state.openUnit.startEventId, "next-root");
  assert.equal(result.state.openUnit.usedNanoAiu, 0);
});

test("does not accept usage without an open budget unit", () => {
  assert.throws(
    () =>
      reduceAccounting(
        createAccountingState(),
        {
          type: "assistant.usage",
          id: "orphan-usage",
          timestamp: "2026-09-07T00:00:00.000Z",
          data: { totalNanoAiu: 1 },
        },
        policy,
      ),
    /without an open budget unit/,
  );
});

test("keeps steering messages inside the active autopilot unit", () => {
  const result = run([
    {
      type: "session.mode_changed",
      id: "mode-on",
      timestamp: "2026-09-07T00:00:00.000Z",
      data: { previousMode: "interactive", newMode: "autopilot" },
    },
    {
      type: "user.message",
      id: "root",
      timestamp: "2026-09-07T00:00:01.000Z",
      data: { delivery: "idle", agentMode: "autopilot" },
    },
    {
      type: "user.message",
      id: "steering",
      timestamp: "2026-09-07T00:00:02.000Z",
      data: { delivery: "steering", agentMode: "autopilot" },
    },
    {
      type: "assistant.usage",
      id: "usage",
      timestamp: "2026-09-07T00:00:03.000Z",
      data: { totalNanoAiu: 1 },
    },
  ]);

  assert.equal(result.state.openUnit.startEventId, "root");
  assert.equal(result.state.openUnit.usedNanoAiu, 1);
});

test("keeps descendant agent work inside the active autopilot unit", () => {
  const result = run([
    {
      type: "session.mode_changed",
      id: "mode-on",
      timestamp: "2026-09-07T00:00:00.000Z",
      data: { previousMode: "interactive", newMode: "autopilot" },
    },
    {
      type: "user.message",
      id: "root",
      timestamp: "2026-09-07T00:00:01.000Z",
      data: { delivery: "idle", agentMode: "autopilot" },
    },
    {
      type: "assistant.usage",
      id: "root-usage",
      timestamp: "2026-09-07T00:00:02.000Z",
      data: { totalNanoAiu: 2 },
    },
    {
      type: "user.message",
      id: "descendant",
      timestamp: "2026-09-07T00:00:03.000Z",
      data: {
        source: "agent-session-id",
        delivery: "idle",
      },
    },
    {
      type: "assistant.usage",
      id: "descendant-usage",
      timestamp: "2026-09-07T00:00:04.000Z",
      data: { totalNanoAiu: 3 },
    },
  ]);

  assert.equal(result.state.openUnit.startEventId, "root");
  assert.equal(result.state.openUnit.usedNanoAiu, 5);
});

test("arms and consumes the next override for ordinary work", () => {
  const result = run([
    nextBudget(2000),
    {
      type: "user.message",
      id: "ordinary-root",
      timestamp: "2026-09-07T00:00:01.000Z",
      data: { delivery: "idle" },
    },
  ]);

  assert.equal(result.state.pendingOverride, null);
  assert.equal(result.state.openUnit.capAiCredits, 2000);
  assert.equal(result.state.openUnit.capSource, "next-override");
});

test("uses the next override for inferred autopilot work", () => {
  const result = run([
    nextBudget(2500),
    {
      type: "session.mode_changed",
      id: "mode-on",
      timestamp: "2026-09-07T00:00:01.000Z",
      data: { previousMode: "interactive", newMode: "autopilot" },
    },
    {
      type: "user.message",
      id: "autopilot-root",
      timestamp: "2026-09-07T00:00:02.000Z",
      data: { delivery: "idle", agentMode: "autopilot" },
    },
  ]);

  assert.equal(result.state.pendingOverride, null);
  assert.equal(result.state.openUnit.capAiCredits, 2500);
  assert.equal(result.state.openUnit.capSource, "next-override");
});

test("uses a next override only once", () => {
  const first = run([
    nextBudget(2000),
    {
      type: "user.message",
      id: "first-root",
      timestamp: "2026-09-07T00:00:01.000Z",
      data: { delivery: "idle" },
    },
    {
      type: "session.idle",
      id: "first-idle",
      timestamp: "2026-09-07T00:00:02.000Z",
      data: {},
    },
    {
      type: "user.message",
      id: "second-root",
      timestamp: "2026-09-07T00:00:03.000Z",
      data: { delivery: "idle" },
    },
  ]);

  assert.equal(first.completedUnits[0].capSource, "next-override");
  assert.equal(first.state.openUnit.capAiCredits, 1000);
  assert.equal(first.state.openUnit.capSource, "ordinary-default");
});

test("explicit native caps win and still consume the next override", () => {
  const armed = run([nextBudget(2500)]).state;
  assert.equal(armed.pendingOverride.aiCredits, 2500);

  const result = reduceAccounting(
    armed,
    {
      type: "session.autopilot_objective_changed",
      id: "objective",
      timestamp: "2026-09-07T00:00:01.000Z",
      data: {
        operation: "create",
        id: 1,
        status: "active",
        creditLimitAiCredits: 30,
      },
    },
    policy,
  );

  assert.equal(result.state.pendingOverride, null);
  assert.equal(result.state.openUnit.capAiCredits, 30);
  assert.equal(result.state.openUnit.capSource, "explicit-native");
});

test("a later next override replaces the pending value", () => {
  const result = run([
    nextBudget(1500),
    {
      ...nextBudget(2000, "2026-09-07T00:00:01.000Z"),
      id: "budget-next-replacement",
    },
  ]);

  assert.deepEqual(result.state.pendingOverride, {
    aiCredits: 2000,
    setAt: "2026-09-07T00:00:01.000Z",
    setEventId: "budget-next-replacement",
  });
});

test("arming an override does not widen an open unit", () => {
  const first = run([
    {
      type: "user.message",
      id: "first-root",
      timestamp: "2026-09-07T00:00:00.000Z",
      data: { delivery: "idle" },
    },
    nextBudget(2000, "2026-09-07T00:00:01.000Z"),
  ]);

  assert.equal(first.state.openUnit.capAiCredits, 1000);
  assert.equal(first.state.pendingOverride.aiCredits, 2000);

  const second = run(
    [
      {
        type: "session.idle",
        id: "first-idle",
        timestamp: "2026-09-07T00:00:02.000Z",
        data: {},
      },
      {
        type: "user.message",
        id: "second-root",
        timestamp: "2026-09-07T00:00:03.000Z",
        data: { delivery: "idle" },
      },
    ],
    first.state,
  );

  assert.equal(second.state.openUnit.capAiCredits, 2000);
  assert.equal(second.state.openUnit.capSource, "next-override");
});

test("restores pre-override accounting state with no pending override", () => {
  const state = createAccountingState();
  delete state.pendingOverride;

  assert.equal(restoreAccountingState(state).pendingOverride, null);
});

test("restores a pending next override", () => {
  const state = run([nextBudget(2000)]).state;

  assert.deepEqual(
    restoreAccountingState(state).pendingOverride,
    state.pendingOverride,
  );
});

function run(events, initialState = createAccountingState()) {
  let state = initialState;
  const completedUnits = [];

  for (const event of events) {
    const result = reduceAccounting(state, event, policy);
    state = result.state;
    completedUnits.push(...result.completedUnits);
  }

  return { state, completedUnits };
}

function nextBudget(
  aiCredits,
  timestamp = "2026-09-07T00:00:00.000Z",
) {
  return {
    type: "budget.next",
    id: `budget-next-${aiCredits}`,
    timestamp,
    data: { aiCredits },
  };
}

function project(unit) {
  return {
    kind: unit.kind,
    usedNanoAiu: unit.usedNanoAiu,
    capAiCredits: unit.capAiCredits,
    capSource: unit.capSource,
    outcome: unit.outcome,
    endedAt: unit.endedAt,
    endEventId: unit.endEventId,
  };
}
