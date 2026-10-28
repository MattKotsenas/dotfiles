import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { project, unfinishedTurns } from "../agent/extensions/cost/ledger.ts";
import { COST_ENTRY, checkpointRecord, costRecord, footerRecord } from "../agent/extensions/cost/model.ts";
import { ai, sdk } from "./delegation/sdk.mjs";

const usage = (total) => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const assistant = (manager, cost, stopReason = "stop") =>
  manager.appendMessage({ ...ai.fauxAssistantMessage("answer", { stopReason }), usage: usage(cost) });
const user = (manager, text = "Question") => manager.appendMessage({ role: "user", content: text, timestamp: 0 });
const state = (manager, range) =>
  project(manager.getEntries(), new Set(manager.getBranch().map((entry) => entry.id)), manager.getSessionId(), range);
function mark(manager, name, afterEntryId = manager.getEntries().at(-1)?.id ?? null) {
  const record = checkpointRecord(manager.getSessionId(), name, afterEntryId);
  manager.appendCustomEntry(COST_ENTRY, record);
  return record;
}
function record(manager, data) {
  return manager.appendCustomEntry(COST_ENTRY, { version: 1, owner: manager.getSessionId(), ...data });
}

test("native ledger sources and billed failures reconcile without counting tool details twice", () => {
  const manager = sdk.SessionManager.inMemory();
  const root = user(manager);
  assistant(manager, 1, "error");
  assistant(manager, 2, "aborted");
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "child",
    toolName: "delegate",
    content: [],
    details: { usage: usage(100) },
    usage: usage(4),
    timestamp: 0,
    isError: false,
  });
  manager.appendUsage("cache_warm", "test", "model", usage(8));
  manager.appendCompaction("Summary", root, 1, undefined, false, usage(16));
  manager.branchWithSummary(root, "Branch", undefined, false, usage(32));
  const snapshot = state(manager);
  assert.equal(snapshot.total, 63);
  assert.equal(snapshot.pathTotal, 32);
  assert.equal(
    snapshot.activities.reduce((total, item) => total + item.cost, 0),
    63,
  );
  assert.equal(
    snapshot.activities.reduce((total, item) => total + item.tools, 0),
    4,
  );
  assert.equal(snapshot.activities.filter((item) => item.kind === "overhead").length, 3);
});

test("temporal checkpoints count abandoned branches, range/path slicing precedes grouping, baseline survives navigation", () => {
  const manager = sdk.SessionManager.inMemory();
  const root = user(manager);
  assistant(manager, 1);
  record(manager, { kind: "turn_start", id: "run", afterEntryId: manager.getEntries().at(-1).id, excerpt: "Observed" });
  assistant(manager, 2);
  const checkpoint = mark(manager, "Middle");
  manager.appendCustomEntry(COST_ENTRY, footerRecord(manager.getSessionId(), checkpoint.id));
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "tool",
    toolName: "delegate",
    content: [],
    usage: usage(4),
    timestamp: 0,
    isError: false,
  });
  record(manager, { kind: "turn_end", id: "run", afterEntryId: manager.getEntries().at(-1).id, status: "settled" });
  manager.branch(root);
  assistant(manager, 8);
  const snapshot = state(manager, checkpoint.id);
  assert.equal(snapshot.total, 15);
  assert.equal(snapshot.footerCost, 12);
  assert.equal(snapshot.baseline.id, checkpoint.id);
  assert.equal(
    snapshot.activities.reduce((n, item) => n + item.cost, 0),
    12,
  );
  assert.equal(
    snapshot.activities.reduce((n, item) => n + item.pathMain + item.pathTools + item.pathOther, 0),
    8,
  );
  const observed = snapshot.activities.find((item) => item.id === "run");
  assert.equal(observed.cost, 4);
  assert.equal(observed.partial, true);
  assert.equal(observed.provenance, "observed");
  assert.equal(state(manager).activities.find((item) => item.id === "run").cost, 6);
  record(manager, { kind: "remove", id: checkpoint.id });
  const undone = state(manager, checkpoint.id);
  assert.equal(undone.range, undefined);
  assert.equal(undone.baseline, undefined);
  assert.equal(undone.footerCost, 15);
  assert.equal(undone.checkpoints.length, 0);
});

test("turn intervals include automatic compaction and custom starts but exclude idle overhead", () => {
  const manager = sdk.SessionManager.inMemory();
  const root = user(manager, "Historical");
  assistant(manager, 1);
  const before = manager.getEntries().at(-1).id;
  manager.appendCompaction("Automatic", root, 1, undefined, false, usage(2));
  record(manager, { kind: "turn_start", id: "custom", afterEntryId: before, excerpt: "Custom work" });
  assistant(manager, 4);
  const after = manager.getEntries().at(-1).id;
  record(manager, { kind: "turn_end", id: "custom", afterEntryId: after, status: "settled" });
  manager.appendUsage("cache_warm", "test", "model", usage(8));
  assert.deepEqual(unfinishedTurns(manager.getEntries(), manager.getSessionId()), []);
  const snapshot = state(manager);
  assert.equal(snapshot.total, 15);
  assert.equal(snapshot.activities.find((item) => item.id === "custom").cost, 6);
  assert.equal(snapshot.activities.at(-1).kind, "overhead");
  assert.equal(snapshot.activities.at(-1).cost, 8);
  assert.deepEqual(
    snapshot.activities.map((item) => item.provenance),
    ["historical", "observed", "historical"],
  );
});

test("missing usage, measured zero, terminal-safe excerpts and invalid custom records remain distinct", () => {
  const manager = sdk.SessionManager.inMemory();
  user(manager, "\x1b[31mHello\x1b[0m\nworld\x07");
  const message = ai.fauxAssistantMessage("legacy");
  delete message.usage;
  manager.appendMessage(message);
  manager.appendCustomEntry(COST_ENTRY, { version: 1, owner: manager.getSessionId(), kind: "checkpoint", id: 2 });
  manager.appendCustomEntry(COST_ENTRY, "not an object");
  assert.equal(state(manager).activities[0].missing, true);
  assert.equal(state(manager).activities[0].excerpt, "Hello world");
  assert.equal(state(manager).checkpoints.length, 0);
  const measured = sdk.SessionManager.inMemory();
  user(measured);
  assistant(measured, 0);
  assert.equal(state(measured).activities[0].missing, false);
  assert.equal(state(measured).total, 0);
});

test("resume preserves owner-scoped checkpoints and forked children ignore inherited selections", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cost-ledger-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = sdk.SessionManager.create(dir, dir);
  user(manager);
  assistant(manager, 1);
  const checkpoint = mark(manager, "Saved");
  manager.appendCustomEntry(COST_ENTRY, footerRecord(manager.getSessionId(), checkpoint.id));
  assistant(manager, 2);
  const path = manager.getSessionFile();
  const bytes = await readFile(path, "utf8");
  assert.equal(state(sdk.SessionManager.open(path, dir)).footerCost, 2);
  const extracting = sdk.SessionManager.open(path, dir);
  const childPath = extracting.createBranchedSession(extracting.getLeafId());
  const child = sdk.SessionManager.open(childPath, dir);
  assert.notEqual(child.getSessionId(), manager.getSessionId());
  assert.equal(state(child).total, 3);
  assert.equal(state(child).checkpoints.length, 0);
  assert.equal(state(child).baseline, undefined);
  const fresh = mark(child, "Tangent");
  child.appendCustomEntry(COST_ENTRY, footerRecord(child.getSessionId(), fresh.id));
  assert.equal(state(child).footerCost, 0);
  assistant(child, 4);
  assert.equal(state(child).footerCost, 4);
  assert.equal(state(child).total, 7);
  assert.equal(await readFile(path, "utf8"), bytes);
});

test("forking before a settlement record cannot attribute child overhead to an inherited unfinished turn", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cost-inherited-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parent = sdk.SessionManager.create(dir, dir);
  record(parent, { kind: "turn_start", id: "parent-run", afterEntryId: null, excerpt: "Parent run" });
  user(parent, "Parent run");
  const answer = assistant(parent, 1);
  record(parent, { kind: "turn_end", id: "parent-run", afterEntryId: answer, status: "settled" });
  assert.equal(state(parent).activities[0].provenance, "observed");
  const file = parent.getSessionFile();
  const bytes = await readFile(file, "utf8");
  const completeExtractor = sdk.SessionManager.open(file, dir);
  const completeChild = sdk.SessionManager.open(completeExtractor.createBranchedSession(parent.getLeafId()), dir);
  assert.notEqual(completeChild.getSessionId(), parent.getSessionId());
  assert.equal(state(completeChild).activities[0].provenance, "observed", "complete copied boundaries remain usable");
  completeChild.appendUsage("cache_warm", "test", "model", usage(3));
  assert.equal(state(completeChild).activities.at(-1).kind, "overhead");
  const extracting = sdk.SessionManager.open(file, dir);
  const child = sdk.SessionManager.open(extracting.createBranchedSession(answer), dir);
  assert(
    child
      .getEntries()
      .map(costRecord)
      .some((item) => item?.kind === "turn_start"),
  );
  assert(
    !child
      .getEntries()
      .map(costRecord)
      .some((item) => item?.kind === "turn_end"),
  );
  const checkpoint = mark(child, "Tangent");
  child.appendCustomEntry(COST_ENTRY, footerRecord(child.getSessionId(), checkpoint.id));
  const idle = child.appendUsage("cache_warm", "test", "model", usage(7));
  const checkIdle = () => {
    const snapshot = state(child, checkpoint.id);
    const warming = snapshot.activities.find((item) => item.afterEntryId === idle.id);
    assert(warming, "the individual idle charge remains visible");
    assert.equal(warming.cost, 7);
    assert.equal(warming.kind, "overhead");
    assert.equal(warming.excerpt, "Cache warming");
    assert(!snapshot.activities.some((item) => item.id === "parent-run"));
  };
  checkIdle();
  record(child, { kind: "turn_start", id: "child-run", afterEntryId: idle.id, excerpt: "Child work" });
  user(child, "Child work");
  assistant(child, 2);
  record(child, { kind: "turn_end", id: "child-run", afterEntryId: child.getEntries().at(-1).id, status: "settled" });
  checkIdle();
  assert.equal(state(child).footerCost, 9);
  assert.equal(state(child, checkpoint.id).activities.find((item) => item.id === "child-run").cost, 2);
  assert.equal(await readFile(file, "utf8"), bytes);
});

test("unmatched turns are incomplete, foreign incomplete spans cannot absorb the next turn, malformed anchors fall back", () => {
  const manager = sdk.SessionManager.inMemory();
  record(manager, { kind: "turn_start", id: "old", afterEntryId: null, excerpt: "Interrupted" });
  assistant(manager, 1);
  assert.deepEqual(unfinishedTurns(manager.getEntries(), manager.getSessionId()), [{ id: "old" }]);
  const before = manager.getEntries().at(-1).id;
  record(manager, { kind: "turn_start", id: "new", afterEntryId: before, excerpt: "New" });
  assistant(manager, 2);
  record(manager, { kind: "turn_end", id: "new", afterEntryId: manager.getEntries().at(-1).id, status: "settled" });
  assert.equal(state(manager).activities.find((item) => item.id === "old").cost, 1);
  assert.equal(state(manager).activities.find((item) => item.id === "old").provenance, "incomplete");
  assert.equal(state(manager).activities.find((item) => item.id === "new").cost, 2);
  record(manager, { kind: "turn_start", id: "bad", afterEntryId: "not-copied", excerpt: "No anchor" });
  assistant(manager, 4);
  record(manager, { kind: "turn_end", id: "bad", afterEntryId: manager.getEntries().at(-1).id, status: "settled" });
  assert.equal(state(manager).total, 7);
  assert(!state(manager).activities.some((item) => item.id === "bad" && item.provenance === "observed"));
  assert(
    manager
      .getEntries()
      .map(costRecord)
      .some((item) => item?.kind === "turn_start"),
  );
});
