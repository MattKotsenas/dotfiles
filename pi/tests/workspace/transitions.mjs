import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { choose, directories, durable, host, rows, selection, user, workspace } from "./host.mjs";
import { counters, root, SM } from "./offline.mjs";

const results = [];
const pass = (name) => {
  results.push(name);
  console.log(`PASS ${name}`);
};
const noMessages = (h) => assert(!h.runtime.session.sessionManager.getEntries().some((e) => e.type === "message"));
function freshResume(h, file, expected) {
  const child = spawnSync(
    process.execPath,
    [
      join(dirname(fileURLToPath(import.meta.url)), "resume.mjs"),
      file,
      h.runtime.cwd,
      expected.model,
      expected.thinking,
    ],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  console.log("PASS fresh resume");
}

// One fresh UUID at B; all subsequent moves keep that UUID and one file.
{
  const dirs = directories("transition"),
    control = { persistTemporary: true };
  const h = await host(dirs, control);
  try {
    const old = h.runtime.session.sessionFile,
      originalId = h.runtime.session.sessionId;
    assert(!existsSync(old));
    await choose(h);
    await workspace(h, "A");
    await h.move(dirs.B);
    const id = h.runtime.session.sessionId;
    assert.notEqual(id, originalId);
    let file = await workspace(h, "B", id);
    assert(!existsSync(old));
    noMessages(h);
    assert(rows(file).some((e) => e.customType === "workspace-empty-selection"));
    assert.deepEqual(selection(h), { model: "right", thinking: "high" });
    const bFile = file,
      prefix = readFileSync(file, "utf8").split("\n").slice(1).join("\n");
    control.shutdown = true;
    await h.move(dirs.C);
    assert.equal(h.runtime.cwd, dirs.C, "durable message-free SECOND move must reach C");
    file = await workspace(h, "C", id);
    noMessages(h);
    assert(!existsSync(bFile));
    assert(readFileSync(file, "utf8").split("\n").slice(1).join("\n").startsWith(prefix));
    assert.deepEqual(selection(h), { model: "right", thinking: "high" });
    control.shutdown = false;
    await choose(h, "left", "low");
    await h.runtime.session.prompt("/test-reload");
    assert.deepEqual(selection(h), { model: "left", thinking: "low" });
    await h.runtime.switchSession(file);
    assert.deepEqual(selection(h), { model: "left", thinking: "low" });
    freshResume(h, file, selection(h));
    await h.runtime.switchSession(file); // Load native setup records appended by the separate empty resume.
    noMessages(h);
    await choose(h);
    // Actual prompt path persists the first user message. The provider deliberately
    // denies the request locally, so this performs no inference or request auth.
    await h.runtime.session.prompt("FIRST_REAL_PROMPT_OFFLINE");
    assert(
      h.runtime.session.sessionManager
        .getEntries()
        .some(
          (e) =>
            e.type === "message" &&
            e.message.role === "user" &&
            e.message.content.some?.((c) => c.text === "FIRST_REAL_PROMPT_OFFLINE"),
        ),
    );
    await choose(h, "left", "low");
    await h.runtime.switchSession(file);
    assert.deepEqual(
      selection(h),
      { model: "left", thinking: "low" },
      "native selection must override the old right/high marker after chat",
    );
    const sm = h.runtime.session.sessionManager;
    user(sm, "LEFT_ACTIVE");
    const left = sm.appendCustomEntry("state", { retain: "all fields" });
    user(sm, "RIGHT_ABANDONED");
    await choose(h, "right", "high");
    await h.runtime.session.prompt(`/test-tree ${left}`);
    assert.equal(sm.getLeafId(), left);
    assert.equal(
      sm.buildSessionContext().model.modelId,
      "left",
      "selected branch projection differs from visible runtime model",
    );
    assert.deepEqual(selection(h), { model: "right", thinking: "high" });
    assert(!h.runtime.session.messages.some((m) => m.content === "RIGHT_ABANDONED"));
    const initial = rows(file),
      selected = selection(h);
    control.shutdown = true;
    for (const mark of ["D", "E"]) {
      const oldFile = h.runtime.session.sessionFile;
      await h.move(dirs[mark]);
      file = await workspace(h, mark, id);
      assert(!existsSync(oldFile));
      assert.deepEqual(rows(file).slice(1, initial.length), initial.slice(1));
      assert.deepEqual(rows(file)[0], { ...initial[0], cwd: dirs[mark] });
      assert(h.runtime.session.sessionManager.getEntries().some((e) => e.message?.content === "RIGHT_ABANDONED"));
      assert(!h.runtime.session.messages.some((m) => m.content === "RIGHT_ABANDONED"));
      for (const shutdownId of h.shutdownIds) assert(h.runtime.session.sessionManager.getEntry(shutdownId));
      assert.deepEqual(selection(h), selected);
      freshResume(h, file, selected);
    }
    assert(h.temporaryPaths.length >= 3);
    assert(h.temporaryPaths.every((file) => !existsSync(file)));
    pass(
      "empty A-B-C, manual selection/reload/fresh resume, first prompt, branches D-E, one UUID/file and temporary cleanup",
    );
  } finally {
    await h.runtime.dispose();
  }
}

// Native durable files can be message-free without our marker, including custom state.
for (const customOnly of [false, true]) {
  const dirs = directories(`external-${customOnly}`);
  let manager = durable(dirs.A, customOnly);
  const source = manager.getSessionFile();
  const originalRows = rows(source);
  Object.assign(originalRows[0], {
    parentSession: join(root, "synthetic-parent.jsonl"),
    studyExtra: { nested: [1, "PRESERVE"] },
  });
  writeFileSync(source, `${originalRows.map((e) => JSON.stringify(e)).join("\n")}\n`);
  manager = SM.open(source);
  const h = await host(dirs, { shutdown: true }, manager);
  try {
    const id = manager.getSessionId(),
      original = rows(manager.getSessionFile());
    assert(!original.some((e) => e.customType === "workspace-empty-selection"));
    noMessages(h);
    await choose(h);
    await h.move(dirs.B);
    const file = await workspace(h, "B", id);
    noMessages(h);
    assert.deepEqual(rows(file).slice(1, original.length), original.slice(1));
    assert.deepEqual(rows(file)[0], { ...original[0], cwd: dirs.B });
    assert(rows(file).some((e) => e.customType === "workspace-empty-selection" && e.data.model.id === "right"));
    assert.deepEqual(selection(h), { model: "right", thinking: "high" });
    freshResume(h, file, selection(h));
    pass(`external durable message-free custom=${customOnly}`);
  } finally {
    await h.runtime.dispose();
  }
}

for (const kind of [
  "missing",
  "file",
  "quote",
  "noop",
  "query",
  "no-session",
  "unwritten-custom",
  "print",
  "rpc",
  "json",
]) {
  const dirs = directories(`guard-${kind}`),
    manager = kind === "no-session" ? SM.inMemory(dirs.A) : SM.create(dirs.A);
  const h = await host(dirs, { mode: ["print", "rpc", "json"].includes(kind) ? kind : "tui" }, manager);
  try {
    if (kind === "unwritten-custom") manager.appendCustomEntry("valuable", { retain: true });
    const file = manager.getSessionFile(),
      entries = manager.getEntries();
    if (file) assert(!existsSync(file));
    let arg = `"${dirs.B}"`;
    if (kind === "missing") arg = '"missing"';
    if (kind === "file") arg = '"marker.txt"';
    if (kind === "quote") arg = '"unterminated';
    if (kind === "noop") arg = `"${dirs.A}"`;
    if (kind === "query") arg = "";
    await h.runtime.session.prompt(`/cd ${arg}`);
    assert.equal(h.runtime.cwd, dirs.A);
    assert.equal(process.cwd(), dirs.A);
    assert.deepEqual(manager.getEntries(), entries);
    if (file) assert(!existsSync(file));
    assert.equal(h.starts.length, 1);
    assert.deepEqual(h.errors, []);
    if (kind === "query") assert.deepEqual(h.notes.at(-1), { text: dirs.A, type: "info" });
    if (!["noop", "query"].includes(kind)) assert(h.notes.some((n) => n.type === "error"));
    pass(`guard ${kind}`);
  } finally {
    await h.runtime.dispose();
  }
}
for (const mode of ["print", "rpc", "json"]) {
  const dirs = directories(`resume-${mode}`),
    h = await host(dirs, { mode });
  try {
    const target = durable(dirs.B);
    await h.runtime.switchSession(target.getSessionFile());
    h.noChdir = true;
    await workspace(h, "B", target.getSessionId());
    assert.equal(process.cwd(), dirs.A);
    const before = h.runtime.session.sessionFile;
    await h.move(dirs.C);
    assert.equal(h.runtime.session.sessionFile, before);
    pass(`nonterminal resume/move ${mode}`);
  } finally {
    await h.runtime.dispose();
  }
}
for (const kind of ["relative", "home", "single-quotes", "native-backslashes"]) {
  const dirs = directories(`path-${kind}`),
    h = await host(dirs);
  try {
    let arg = kind === "relative" ? '"../B with spaces"' : kind === "single-quotes" ? `'${dirs.B}'` : `"${dirs.B}"`;
    if (kind === "home") {
      const target = join(process.env.HOME, `home-${Date.now()}`);
      const { mkdirSync } = await import("node:fs");
      mkdirSync(target);
      arg = `"~/${basename(target)}"`;
      await h.runtime.session.prompt(`/cd ${arg}`);
      assert.equal(h.runtime.cwd, target);
    } else {
      if (kind === "native-backslashes") assert(dirs.B.includes("\\"), "Windows path precondition");
      await h.runtime.session.prompt(`/cd ${arg}`);
      await workspace(h, "B", h.runtime.session.sessionId);
    }
    assert.deepEqual(h.errors, []);
    pass(`path ${kind}`);
  } finally {
    await h.runtime.dispose();
  }
}
for (const answer of [undefined, "Cancel", "Move anyway"]) {
  const dirs = directories(`sharing-${answer}`),
    manager = durable(dirs.A);
  user(manager, "LOCAL");
  const h = await host(dirs, { answer, shutdown: true }, manager);
  try {
    const source = manager.getSessionFile(),
      external = SM.open(source);
    const unknown = external.appendCustomEntry("external", { retained: true });
    assert.equal(manager.getEntry(unknown), undefined);
    const bytes = readFileSync(source, "utf8");
    await h.move(dirs.B);
    assert(h.notes.some((n) => n.options && n.text.includes("cannot detect an idle instance")));
    if (answer === "Move anyway") {
      await workspace(h, "B", manager.getSessionId());
      assert(h.runtime.session.sessionManager.getEntry(unknown));
      assert(
        !h.runtime.session.sessionManager.getBranch().some((entry) => entry.id === unknown),
        "external history remains stored outside the active branch",
      );
    } else {
      assert.equal(h.runtime.cwd, dirs.A);
      assert.equal(readFileSync(source, "utf8"), bytes);
      assert.equal(h.starts.length, 1);
    }
    assert.deepEqual(h.errors, []);
    pass(`sharing ${answer}`);
  } finally {
    await h.runtime.dispose();
  }
}
for (const cancelAt of [1, 2]) {
  const dirs = directories(`cancel-${cancelAt}`),
    manager = durable(dirs.A);
  const h = await host(dirs, { cancelAt, persistTemporary: true }, manager);
  try {
    const source = manager.getSessionFile(),
      bytes = readFileSync(source, "utf8");
    await h.move(dirs.B);
    assert.equal(h.runtime.cwd, dirs.A);
    if (cancelAt === 1) {
      assert.equal(readFileSync(source, "utf8"), bytes);
      assert.equal(h.runtime.session.sessionId, manager.getSessionId());
      assert.equal(h.starts.length, 1);
    } else {
      assert(!existsSync(source));
      assert.notEqual(h.runtime.session.sessionId, manager.getSessionId());
      assert(existsSync(h.runtime.session.sessionFile));
      assert(existsSync(SM.findById(dirs.B, manager.getSessionId())));
      assert(h.notes.some((n) => n.text.includes("No rollback")));
    }
    assert.deepEqual(h.errors, []);
    pass(`durable cancel ${cancelAt}`);
  } finally {
    await h.runtime.dispose();
  }
}
{
  const dirs = directories("empty-cancel"),
    h = await host(dirs, { cancelAt: 1 });
  try {
    const id = h.runtime.session.sessionId;
    await h.move(dirs.B);
    assert.equal(h.runtime.session.sessionId, id);
    assert.equal((await SM.list(dirs.B)).length, 0);
    assert.equal(h.starts.length, 1);
    pass("empty first cancellation removes candidate");
  } finally {
    await h.runtime.dispose();
  }
}
for (const late of [false, true]) {
  const dirs = directories(`collision-${late}`),
    manager = durable(dirs.A),
    control = { lateCollision: late };
  const h = await host(dirs, control, manager);
  try {
    const source = manager.getSessionFile(),
      destination = join(SM.create(dirs.B).getSessionDir(), basename(source));
    if (!late) writeFileSync(destination, "COLLISION");
    const bytes = readFileSync(source, "utf8");
    await h.move(dirs.B);
    assert.equal(readFileSync(destination, "utf8"), "COLLISION");
    assert(existsSync(source));
    assert.equal(h.errors.length, 1);
    if (late) assert(h.errors[0].includes('"phase":"relocation"'));
    else {
      assert.equal(readFileSync(source, "utf8"), bytes);
      assert.equal(h.starts.length, 1);
    }
    pass(`collision late=${late}`);
  } finally {
    await h.runtime.dispose();
  }
}
{
  const dirs = directories("factory-failure"),
    manager = durable(dirs.A);
  const h = await host(dirs, { failAt: 2, persistTemporary: true }, manager);
  try {
    const old = await h.capture();
    await h.move(dirs.B);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /INJECTED_FACTORY_2/);
    assert.match(h.errors[0], /"phase":"second-switch"/);
    assert.match(h.errors[0], /"sourceExists":false/);
    assert.match(h.errors[0], /"destinationExists":true/);
    assert.match(h.errors[0], /"context":"unavailable"/);
    assert.match(h.errors[0], /"currentRuntime":"unknown"/);
    assert.throws(() => old.sessionManager.getSessionId(), /stale/);

    // Runtime was torn down; no successful rollback or usable-host claim.
    pass("factory failure reports paths/existence and inaccessible context/unknown runtime");
  } finally {
    await h.runtime.dispose();
  }
}
assert.equal(counters().fetchAttempts, 0);
assert.equal(counters().networkAttempts, 0);
assert.equal(
  counters().modelRequests,
  0,
  "first real prompt must be blocked at offline request authentication before the provider is called",
);
pass("zero network/inference; first real prompt blocked locally at request authentication");

assert.equal(results.length, 30, "all transition observations must run");
