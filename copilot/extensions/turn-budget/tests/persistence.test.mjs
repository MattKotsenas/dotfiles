import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  allocateStateGeneration,
  getHistoryPath,
  readLatestState,
  readJsonIfExists,
  retryTransientFileLock,
  writeJsonAtomic,
  writeStateSnapshot,
} from "../persistence.mjs";

test("atomically replaces a generic JSON file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "turn-budget-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.json");

  assert.equal(await readJsonIfExists(path), null);
  await writeJsonAtomic(path, { revision: 1 }, "test");
  await writeJsonAtomic(path, { revision: 2 }, "test");

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { revision: 2 });
});

test("writes immutable state snapshots and reads the latest revision", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "turn-budget-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const extensionGeneration = "00000000000000000100";

  assert.equal(await readLatestState(root), null);
  for (let revision = 1; revision <= 4; revision += 1) {
    await writeStateSnapshot(
      root,
      { extensionGeneration, extensionInstanceId: "instance", revision },
      "instance",
      extensionGeneration,
    );
  }

  assert.deepEqual(await readLatestState(root), {
    extensionGeneration,
    extensionInstanceId: "instance",
    revision: 4,
  });
  assert.deepEqual(
    (await readdir(root)).sort(),
    [
      "state.00000000000000000100.0000000000000002.instance.json",
      "state.00000000000000000100.0000000000000003.instance.json",
      "state.00000000000000000100.0000000000000004.instance.json",
    ],
  );
});

test("newer extension generations win equal revision races", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "turn-budget-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeStateSnapshot(
    root,
    {
      extensionGeneration: "00000000000000000100",
      extensionInstanceId: "old",
      revision: 7,
      marker: "old",
    },
    "old",
    "00000000000000000100",
  );
  await writeStateSnapshot(
    root,
    {
      extensionGeneration: "00000000000000000200",
      extensionInstanceId: "new",
      revision: 7,
      marker: "new",
    },
    "new",
    "00000000000000000200",
  );

  assert.equal((await readLatestState(root)).marker, "new");
});

test("allocates generations above persisted state across concurrent starts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "turn-budget-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "state.00000000000000000100.0000000000000007.old.json"),
    "{}",
    "utf8",
  );

  const generations = await Promise.all([
    allocateStateGeneration(root),
    allocateStateGeneration(root),
  ]);

  assert.deepEqual(generations.toSorted(), [
    "00000000000000000101",
    "00000000000000000102",
  ]);
});

test("ignores retained legacy state after the first snapshot is written", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "turn-budget-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "state.json"),
    JSON.stringify({ revision: 1 }),
    "utf8",
  );

  assert.deepEqual(await readLatestState(root), { revision: 1 });
  await writeStateSnapshot(
    root,
    {
      extensionGeneration: "00000000000000000100",
      extensionInstanceId: "instance",
      revision: 2,
    },
    "instance",
    "00000000000000000100",
  );

  assert.deepEqual(await readLatestState(root), {
    extensionGeneration: "00000000000000000100",
    extensionInstanceId: "instance",
    revision: 2,
  });
  assert.equal(
    (await readdir(root)).includes("state.json"),
    true,
  );
});

test("rejects snapshots whose filename and payload instances disagree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "turn-budget-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "state.00000000000000000100.0000000000000001.filename.json"),
    JSON.stringify({
      extensionGeneration: "00000000000000000100",
      extensionInstanceId: "payload",
      revision: 1,
    }),
    "utf8",
  );

  await assert.rejects(
    readLatestState(root),
    /State snapshot identity does not match its contents/,
  );
});

test("rejects snapshot revisions that lose precision as JavaScript numbers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "turn-budget-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "state.00000000000000000100.9007199254740993.instance.json"),
    JSON.stringify({
      extensionGeneration: "00000000000000000100",
      extensionInstanceId: "instance",
      revision: 9007199254740992,
    }),
    "utf8",
  );

  await assert.rejects(
    readLatestState(root),
    /State snapshot identity does not match its contents/,
  );
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
