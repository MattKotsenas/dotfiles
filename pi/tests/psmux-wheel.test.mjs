import assert from "node:assert/strict";
import { test } from "node:test";
import psmuxWheel from "../agent/extensions/psmux-wheel.ts";

const environment = { PSMUX_SESSION: "main", TMUX: "/tmp/psmux-123/default,4567,0", TMUX_PANE: "%568" };

async function launch({ mode = "tui", env = environment, result = { code: 0, stderr: "", killed: false } } = {}) {
  const handlers = new Map();
  const calls = [];
  const notices = [];
  psmuxWheel({
    on: (event, handler) => handlers.set(event, handler),
    exec: async (...args) => { calls.push(args); return result; },
  });
  assert.equal(calls.length, 0, "loading an extension must not start a process");
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  for (const key of Object.keys(environment)) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    await handlers.get("session_start")({}, { mode, ui: { notify: (...args) => notices.push(args) } });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { calls, notices };
}

test("interactive psmux startup enables the override only on the inherited pane", async () => {
  const { calls, notices } = await launch();
  assert.deepEqual(calls, [["psmux", ["set-option", "-p", "-t", "%568", "@mouse-force", "on"], { timeout: 5_000 }]]);
  assert.deepEqual(notices, []);
  const other = await launch({ env: { ...environment, PSMUX_SESSION: "other-session", TMUX_PANE: "%12" } });
  assert.equal(other.calls[0][1][3], "%12");
});

test("non-interactive modes and missing or invalid pane identifiers have no effects", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    assert.deepEqual(await launch({ mode }), { calls: [], notices: [] });
  }
  for (const env of [
    {},
    { TMUX_PANE: "%568" },
    { PSMUX_SESSION: "main" },
    { ...environment, PSMUX_SESSION: "" },
    { ...environment, TMUX: "" },
    ...["", "568", "%", "%568; kill-server", "-a"].map(TMUX_PANE => ({ ...environment, TMUX_PANE })),
    { PSMUX_SESSION: "main", TMUX_PANE: "%568" },
  ]) {
    assert.deepEqual(await launch({ env }), { calls: [], notices: [] });
  }
});

test("command failure and timeout are reported without pretending the workaround succeeded", async () => {
  for (const [result, detail] of [
    [{ code: 1, stderr: " can't find pane \n", killed: false }, "can't find pane"],
    [{ code: 1, stderr: "", killed: false }, "exit 1"],
    [{ code: 0, stderr: "", killed: true }, "command timed out"],
  ]) {
    const { calls, notices } = await launch({ result });
    assert.equal(calls.length, 1);
    assert.deepEqual(notices, [[`psmux wheel workaround failed: ${detail}`, "warning"]]);
  }
});
