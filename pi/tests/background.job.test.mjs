import assert from "node:assert/strict";
import test from "node:test";
import { Job } from "../agent/extensions/background/job.ts";

const metadata = { id: "bg1", command: "build", log: "memory:output", started: 100, group: 2, watched: false };
const create = () => new Job(metadata);
const outcomes = [
  { name: "success", outcome: { exitCode: 0 }, status: "exited", exitCode: 0 },
  { name: "nonzero exit", outcome: { exitCode: 7 }, status: "exited", exitCode: 7 },
  { name: "unknown exit", outcome: { exitCode: null }, status: "exited", exitCode: null },
  { name: "failure", outcome: { error: true }, status: "failed", exitCode: undefined },
];

// Enumerate stop, settlement, and log-flush ordering, including repeated stop requests.
for (const stops of [0, 1, 2]) {
  for (const { name, outcome, status, exitCode } of outcomes) {
    test(`${name}, ${stops} stop requests: terminal result precedes observable completion`, () => {
      const job = create();
      assert.equal(job.phase, "running");
      assert.equal(job.status, "running");
      assert.equal(job.ended, undefined);
      assert.equal(job.exitCode, undefined);
      assert.equal(job.stopRequested, false);
      assert.deepEqual(job.snapshot(100), {
        id: "bg1",
        command: "build",
        log: "memory:output",
        status: "running",
        exit_code: null,
        wall_time_seconds: 0,
        output: "",
        output_truncated: false,
      });
      for (let i = 0; i < stops; i++) assert.equal(job.requestStop(), true);
      assert.equal(job.stopRequested, stops > 0);
      assert.equal(job.status, "running", "stop requests alone cannot claim termination");
      assert.equal(job.ended, undefined);
      job.settle(outcome, 1234);
      assert.equal(job.phase, "flushing");
      assert.equal(job.status, outcome.error && stops ? "killed" : status);
      assert.equal(job.exitCode, exitCode);
      assert.equal(job.ended, undefined, "waiters must still wait for the output flush");
      assert.equal(job.requestStop(), false, "settled execution cannot be stopped");
      assert.throws(() => job.settle({ exitCode: 9 }, 2000), /settle/);
      assert.equal(job.phase, "flushing", "rejected transition leaves state intact");
      job.flushed();
      assert.equal(job.phase, "complete");
      assert.equal(job.ended, 1234);
      assert.equal(job.requestStop(), false);
      const snapshot = job.snapshot(9000, "last output");
      assert.equal(snapshot.wall_time_seconds, 1.1, "completed elapsed time freezes at execution settlement");
      assert.equal(snapshot.output, "last output");
      assert.equal(snapshot.exit_code, exitCode ?? null);
      assert.throws(() => job.flushed(), /flush/);
      assert.throws(() => job.settle({ error: true }, 2000), /settle/);
      assert.deepEqual(job.snapshot(10000, "last output"), snapshot);
    });
  }
}

test("flush cannot complete an execution which is still running", () => {
  const job = create();
  assert.equal(job.phase, "running");
  assert.throws(() => job.flushed(), /flush/);
  assert.equal(job.status, "running");
  assert.equal(job.ended, undefined);
  job.settle({ exitCode: 0 }, 500);
  job.flushed();
  assert.equal(job.status, "exited");
});

test("output tracks activity without erasing the latest nonempty display line", () => {
  const job = create();
  assert.equal(job.lastOutput, undefined);
  assert.equal(job.lastLine, undefined);
  for (const [line, at, expected] of [
    ["first", 200, "first"],
    [undefined, 300, "first"],
    ["latest 雪", 400, "latest 雪"],
  ]) {
    job.output(line, at);
    assert.equal(job.lastOutput, at);
    assert.equal(job.lastLine, expected);
  }
  assert.equal(job.snapshot(700).wall_time_seconds, 0.6);
  job.settle({ exitCode: 0 }, 800);
  assert.throws(() => job.output("late", 900), /output/);
  job.flushed();
  assert.throws(() => job.output("late", 1000), /output/);
  assert.equal(job.lastLine, "latest 雪");
  assert.equal(job.lastOutput, 400);
});

test("handoff preserves earlier activity and job grouping metadata", () => {
  const job = new Job({ ...metadata, watched: true, lastOutput: 80 });
  assert.equal(job.started, 100);
  assert.equal(job.lastOutput, 80);
  assert.equal(job.group, 2);
  assert.equal(job.watched, true);
  job.output("buffered", 90);
  assert.equal(job.lastOutput, 90);
  assert.equal(job.started, 100);
});

for (const outcome of outcomes) {
  test(`capture failure overrides ${outcome.name} only after flushing`, () => {
    const job = new Job({ ...metadata, log: null });
    assert.equal(job.phase, "running");
    job.settle(outcome.outcome, 200);
    assert.equal(job.status, outcome.status);
    assert.equal(job.ended, undefined);
    job.flushed(false);
    assert.equal(job.phase, "complete");
    assert.equal(job.status, "failed");
    assert.equal(job.exitCode, outcome.exitCode, "capture failure preserves a known command exit code");
    assert.equal(job.ended, 200);
    const snapshot = job.snapshot(300, "capture unavailable", true);
    assert.equal(snapshot.log, null);
    assert.equal(snapshot.output_truncated, true);
  });
}

test("a stop after failure cannot reclassify it as killed", () => {
  const job = create();
  assert.equal(job.stopRequested, false);
  job.settle({ error: true }, 200);
  assert.equal(job.status, "failed");
  assert.equal(job.requestStop(), false);
  assert.equal(job.stopRequested, false);
  job.flushed();
  assert.equal(job.status, "failed");
});
