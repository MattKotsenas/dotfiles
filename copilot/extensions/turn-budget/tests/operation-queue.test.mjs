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
