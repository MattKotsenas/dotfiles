import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { JobSupervisor } from "../agent/extensions/background/job-supervisor.ts";
import { byteCount, MemoryJobOutput } from "../agent/extensions/background/output-store.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(output) {
  const notifications = [];
  const supervisor = new JobSupervisor({
    output: () => output,
    displayLine: (data) => data.toString(),
    changed() {},
    completed: (job) => {
      notifications.push(job.id);
    },
  });
  return { supervisor, notifications };
}

test("completion waits for storage finish, then notifies with readable output", async () => {
  const storage = new MemoryJobOutput();
  const flush = deferred();
  const output = {
    writable: storage.writable,
    log: storage.log,
    tail: (limits) => storage.tail(limits),
    finish: async () => {
      await flush.promise;
      await storage.finish();
    },
    dispose: () => storage.dispose(),
  };
  const { supervisor, notifications } = setup(output);
  const execution = deferred();
  const job = supervisor.start({
    command: "controlled",
    group: 0,
    watched: false,
    controller: new AbortController(),
    run: (onData) => {
      onData(Buffer.from("stdout and stderr\n"));
      return execution.promise;
    },
  });
  try {
    assert.equal(job.phase, "running");
    assert.equal(job.log, null);
    execution.resolve({ exitCode: 7 });
    await Promise.resolve();
    assert.equal(job.phase, "flushing");
    assert.equal(await supervisor.wait(job, 0), false);
    assert.deepEqual(notifications, []);
    flush.resolve();
    assert.equal(await supervisor.wait(job, 1), true);
    assert.equal(job.phase, "complete");
    assert.equal(job.exitCode, 7);
    assert.deepEqual(await supervisor.tail(job), { text: "stdout and stderr", truncated: false });
    assert.deepEqual(notifications, [job.id]);
  } finally {
    flush.resolve();
    supervisor.shutdown();
  }
});

test("capture failure completes waiters with a failed job and diagnostic", async () => {
  const output = {
    writable: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
    log: null,
    tail: async () => {
      throw new Error("disk full");
    },
    finish: async () => {
      throw new Error("disk full");
    },
    dispose: async () => {},
  };
  const { supervisor } = setup(output);
  const job = supervisor.start({
    command: "controlled",
    group: 0,
    watched: false,
    controller: new AbortController(),
    run: async (onData) => {
      onData(Buffer.from("lost"));
      return { exitCode: 0 };
    },
  });
  try {
    assert.equal(await supervisor.wait(job, 1), true);
    assert.equal(job.status, "failed");
    assert.equal(job.exitCode, 0, "capture failure must not discard the observed exit code");
    const tail = await supervisor.tail(job);
    assert.match(tail.text, /capture.*disk full/i);
    assert.equal(tail.truncated, true);
  } finally {
    supervisor.shutdown();
  }
});

test("capture factory failure prevents execution from starting", () => {
  let started = false;
  const supervisor = new JobSupervisor({
    output: () => {
      throw new Error("invalid storage setting");
    },
    displayLine: () => "",
    changed() {},
    completed() {},
  });
  assert.throws(
    () =>
      supervisor.start({
        command: "controlled",
        group: 0,
        watched: false,
        controller: new AbortController(),
        run: async () => {
          started = true;
          return { exitCode: 0 };
        },
      }),
    /invalid storage/,
  );
  assert.equal(started, false);
  assert.equal(supervisor.jobs.size, 0);
});

test("a truncated handoff prefix stays visible even when the store tail fits", async () => {
  const { supervisor } = setup(new MemoryJobOutput());
  const job = supervisor.start({
    command: "controlled",
    group: 0,
    watched: false,
    controller: new AbortController(),
    earlier: { started: 100, output: Buffer.from("retained"), lastOutput: 101, truncated: true },
    run: async () => ({ exitCode: 0 }),
  });
  try {
    assert.equal(await supervisor.wait(job, 1), true);
    assert.deepEqual(await supervisor.tail(job), { text: "retained", truncated: true });
  } finally {
    supervisor.shutdown();
  }
});

test("bounded memory eviction is visible through supervisor tails", async () => {
  const { supervisor } = setup(new MemoryJobOutput(byteCount(8)));
  const job = supervisor.start({
    command: "controlled",
    group: 0,
    watched: false,
    controller: new AbortController(),
    run: async (onData) => {
      onData(Buffer.from("prefix\nlatest\n"));
      return { exitCode: 0 };
    },
  });
  try {
    assert.equal(await supervisor.wait(job, 1), true);
    const result = await supervisor.tail(job);
    assert.match(result.text, /latest$/);
    assert.equal(result.truncated, true);
  } finally {
    supervisor.shutdown();
  }
});
