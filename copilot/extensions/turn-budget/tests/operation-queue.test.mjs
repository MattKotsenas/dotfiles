import assert from "node:assert/strict";
import test from "node:test";
import { createOperationQueue } from "../operation-queue.mjs";

test("does not run operations already queued behind a failure", async () => {
  const writes = [];
  let releaseFailure;
  const failureStarted = new Promise((resolve) => {
    releaseFailure = resolve;
  });
  const queue = createOperationQueue(async (error) => {
    writes.push(`fault:${error.message}`);
  });

  queue.enqueue(async () => {
    await failureStarted;
    throw new Error("broken");
  });
  queue.enqueue(async () => {
    writes.push("ok");
  });

  releaseFailure();
  await queue.flush();

  assert.deepEqual(writes, ["fault:broken"]);
});

test("runs serialized reads after a mutation failure", async () => {
  const writes = [];
  const queue = createOperationQueue(async (error) => {
    writes.push(`fault:${error.message}`);
  });

  await queue.enqueue(async () => {
    throw new Error("broken");
  });
  await queue.enqueueRead(async () => {
    writes.push("read");
  });
  await queue.enqueue(async () => {
    writes.push("mutation");
  });
  await queue.flush();

  assert.deepEqual(writes, ["fault:broken", "read"]);
});

test("serializes reads with healthy mutations", async () => {
  const writes = [];
  const queue = createOperationQueue(() => {});

  queue.enqueue(async () => {
    writes.push("mutation");
  });
  queue.enqueueRead(async () => {
    writes.push("read");
  });
  queue.enqueue(async () => {
    writes.push("next mutation");
  });
  await queue.flush();

  assert.deepEqual(writes, ["mutation", "read", "next mutation"]);
});
