import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getHistoryPath,
  readJsonIfExists,
  retryTransientFileLock,
  writeJsonAtomic,
} from "../persistence.mjs";

test("atomically replaces session state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "turn-budget-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.json");

  assert.equal(await readJsonIfExists(path), null);
  await writeJsonAtomic(path, { revision: 1 }, "test");
  await writeJsonAtomic(path, { revision: 2 }, "test");

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { revision: 2 });
});

test("rejects unsafe history record IDs", () => {
  assert.throws(
    () => getHistoryPath("history", "..\\outside"),
    /Unsafe history record ID/,
  );
});

test("retries transient Windows file-lock errors", async () => {
  let attempts = 0;

  const result = await retryTransientFileLock(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      }
      return "replaced";
    },
    { attempts: 3, delayMilliseconds: 0 },
  );

  assert.equal(result, "replaced");
  assert.equal(attempts, 3);
});

test("does not retry permanent file errors", async () => {
  let attempts = 0;

  await assert.rejects(
    retryTransientFileLock(async () => {
      attempts += 1;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
    /missing/,
  );

  assert.equal(attempts, 1);
});
