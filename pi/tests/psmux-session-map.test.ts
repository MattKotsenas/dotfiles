import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import extension, { createSessionMap } from "../agent/extensions/psmux-session-map.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-session-map-"));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("publishes current identity, replaces it on transitions, and clears its own mapping", () => {
  const { directory, cleanup } = fixture();
  try {
    const map = createSessionMap(directory);
    const file = map.file;
    map.publish("first", "C:\\sessions\\first.jsonl");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { sessionId: "first", sessionFile: "C:\\sessions\\first.jsonl" });
    map.publish("second", "C:\\sessions\\second.jsonl");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).sessionId, "second");
    assert.equal(readdirSync(directory).length, 1);
    map.clear();
    map.clear();
    assert.deepEqual(readdirSync(directory), []);
  } finally { cleanup(); }
});

test("ephemeral sessions remove the previous identity", () => {
  const { directory, cleanup } = fixture();
  try {
    const map = createSessionMap(directory);
    map.publish("old", "C:\\old.jsonl");
    map.publish("ephemeral", undefined);
    assert.deepEqual(readdirSync(directory), []);
  } finally { cleanup(); }
});

test("scavenges crash leftovers on publish, retaining live PID files and unrelated files", () => {
  const { directory, cleanup } = fixture();
  try {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const dead = `${child.stdout}-${randomUUID()}.json`;
    const live = `${process.ppid}-${randomUUID()}.json`;
    writeFileSync(join(directory, dead), "crash leftover");
    writeFileSync(join(directory, `${dead}.tmp`), "interrupted publication");
    writeFileSync(join(directory, live), "live parent");
    writeFileSync(join(directory, "unrelated"), "keep");
    const map = createSessionMap(directory);
    map.publish("current", "C:\\current.jsonl");
    assert.equal(readFileSync(join(directory, live), "utf8"), "live parent");
    assert.equal(readdirSync(directory).length, 3);
    assert.ok(!readdirSync(directory).includes(dead));
    assert.ok(!readdirSync(directory).includes(`${dead}.tmp`));
  } finally { cleanup(); }
});

test("PID reuse during scavenging cannot delete the new incarnation's publication", () => {
  const { directory, cleanup } = fixture();
  const kill = process.kill;
  const reusedPid = 987654321;
  const oldFile = join(directory, `${reusedPid}-${randomUUID()}.json`);
  const newFile = join(directory, `${reusedPid}-${randomUUID()}.json`);
  try {
    writeFileSync(oldFile, "old owner");
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid !== reusedPid) return kill(pid, signal);
      // Model a new owner publishing after the dead-process observation, before unlink.
      writeFileSync(newFile, "new owner");
      throw Object.assign(new Error("old process is gone"), { code: "ESRCH" });
    }) as typeof process.kill;
    createSessionMap(directory).publish("current", "C:\\current.jsonl");
    assert.ok(!readdirSync(directory).includes(oldFile.split(/[\\/]/).at(-1)!));
    assert.equal(readFileSync(newFile, "utf8"), "new owner");
  } finally { process.kill = kill; cleanup(); }
});

test("shutdown cannot delete another writer's replacement", () => {
  const { directory, cleanup } = fixture();
  try {
    const old = createSessionMap(directory);
    const current = createSessionMap(directory);
    old.publish("old", "C:\\old.jsonl");
    current.publish("current", "C:\\current.jsonl");
    old.clear();
    assert.equal(JSON.parse(readFileSync(current.file, "utf8")).sessionId, "current");
  } finally { cleanup(); }
});

test("registers lifecycle handlers without creating runtime state; excludes non-TUI sessions", async () => {
  const { directory, cleanup } = fixture();
  const previousHome = process.env.USERPROFILE;
  const previousSession = process.env.PSMUX_SESSION;
  const previousTmux = process.env.TMUX;
  const previousPane = process.env.TMUX_PANE;
  try {
    process.env.USERPROFILE = directory;
    process.env.PSMUX_SESSION = "isolated";
    process.env.TMUX = "isolated,1,0";
    process.env.TMUX_PANE = "%1";
    const handlers = new Map<string, Function>();
    extension({ on: (event: string, handler: Function) => handlers.set(event, handler) } as never);
    assert.deepEqual(readdirSync(directory), []);
    const sessionManager = { getSessionId: () => "first", getSessionFile: () => "C:\\first.jsonl" };
    await handlers.get("session_start")!({}, { mode: "print", sessionManager });
    assert.deepEqual(readdirSync(directory), []);
    await handlers.get("session_start")!({ reason: "startup" }, { mode: "tui", sessionManager });
    const maps = join(directory, ".pi", "agent", "psmux-sessions");
    const file = join(maps, readdirSync(maps)[0]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).sessionId, "first");
    for (const reason of ["reload", "new", "resume", "fork"]) {
      await handlers.get("session_shutdown")!({ reason });
      const next = { getSessionId: () => reason, getSessionFile: () => `C:\\${reason}.jsonl` };
      await handlers.get("session_start")!({ reason }, { mode: "tui", sessionManager: next });
      assert.equal(JSON.parse(readFileSync(file, "utf8")).sessionId, reason);
    }
    await handlers.get("session_shutdown")!({ reason: "quit" });
    assert.deepEqual(readdirSync(join(directory, ".pi", "agent", "psmux-sessions")), []);
  } finally {
    for (const [key, value] of Object.entries({ USERPROFILE: previousHome, PSMUX_SESSION: previousSession, TMUX: previousTmux, TMUX_PANE: previousPane })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    cleanup();
  }
});
