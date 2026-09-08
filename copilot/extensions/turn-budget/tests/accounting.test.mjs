import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createAccountingState,
  reduceAccounting,
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

function run(events) {
  let state = createAccountingState();
  const completedUnits = [];

  for (const event of events) {
    const result = reduceAccounting(state, event, policy);
    state = result.state;
    completedUnits.push(...result.completedUnits);
  }

  return { state, completedUnits };
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
