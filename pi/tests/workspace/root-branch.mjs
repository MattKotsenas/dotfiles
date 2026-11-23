import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { choose, directories, durable, host, selection, user, workspace } from "./host.mjs";
import { counters, root } from "./offline.mjs";

const markerType = "workspace-empty-selection";
const marker = (sm, model, thinkingLevel) =>
  sm.appendCustomEntry(markerType, {
    model: { provider: "study", id: model },
    thinkingLevel,
  });
const branchMarkers = (sm) => sm.getBranch().filter((e) => e.type === "custom" && e.customType === markerType);
const results = [];
async function test(name, action) {
  try {
    await action();
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error.stack ?? error) });
    console.error(`FAIL ${name}\n${error.stack ?? error}`);
  }
}
function freshResume(h, name) {
  const child = spawnSync(
    process.execPath,
    [
      join(dirname(fileURLToPath(import.meta.url)), "resume.mjs"),
      h.runtime.session.sessionFile,
      h.runtime.cwd,
      "right",
      "high",
    ],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    },
  );
  const output = (child.stdout ?? "") + (child.stderr ?? "") + (child.error ? String(child.error) : "");
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, output);
  console.log(`PASS fresh resume ${name}`);
}
for (const kind of ["abandoned-user", "context-edit-omitted-user"]) {
  await test(kind, async () => {
    const dirs = directories(kind),
      sm = durable(dirs.A);
    sm.appendModelChange("study", "left");
    const setup = sm.appendThinkingLevelChange("low");
    const message = user(sm, "PERSISTED_USER");
    if (kind === "context-edit-omitted-user") sm.appendContextEdit(message, null);
    const h = await host(dirs, {}, sm);
    try {
      if (kind === "abandoned-user") await h.runtime.session.prompt(`/test-tree ${setup}`);
      assert(sm.getEntries().some((e) => e.type === "message"));
      assert.equal(
        sm.buildSessionProjection().messages.length,
        0,
        "precondition: selected projection has no messages despite a stored native message",
      );
      assert.equal(h.runtime.session.messages.length, 0);
      await choose(h, "right", "high");
      const id = sm.getSessionId(),
        source = sm.getSessionFile();
      await h.move(dirs.B);
      assert.deepEqual(
        selection(h),
        { model: "right", thinking: "high" },
        "message-free selected branch must retain visible selection through move",
      );
      await workspace(h, "B", id);
      assert(!existsSync(source));
      const moved = h.runtime.session.sessionManager;
      assert.equal(moved.buildSessionProjection().messages.length, 0);
      assert(moved.getEntries().some((e) => e.id === message));
      assert.deepEqual(branchMarkers(moved).at(-1).data, {
        model: { provider: "study", id: "right" },
        thinkingLevel: "high",
      });
      freshResume(h, kind);
    } finally {
      await h.runtime.dispose();
    }
  });
}
await test("only selected branch marker restores on reload", async () => {
  const dirs = directories("branch-marker"),
    sm = durable(dirs.A);
  const setup = sm.appendThinkingLevelChange("low");
  const selected = marker(sm, "left", "low");
  sm.branch(setup);
  const abandoned = marker(sm, "right", "high");
  const h = await host(dirs, {}, sm);
  try {
    assert.deepEqual(
      selection(h),
      { model: "right", thinking: "high" },
      "precondition: runtime initially selects the later right branch",
    );
    await h.runtime.session.prompt(`/test-tree ${selected}`);
    assert.equal(branchMarkers(sm).at(-1).id, selected);
    assert(sm.getEntry(abandoned));
    const latestStoredMarker = sm.getEntries().findLast((e) => e.customType === markerType);
    assert(
      !sm.getBranch().some((e) => e.id === latestStoredMarker.id),
      "precondition: latest stored marker belongs to an abandoned branch",
    );
    await h.runtime.session.prompt("/test-reload");
    assert.deepEqual(
      selection(h),
      { model: "left", thinking: "low" },
      "abandoned branch marker must not override the selected branch marker",
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.runtime.dispose();
  }
});
await test("abandoned marker cannot mark an unmarked selected branch", async () => {
  const dirs = directories("branch-without-marker"),
    sm = durable(dirs.A);
  const setup = sm.appendThinkingLevelChange("low");
  marker(sm, "right", "high");
  const h = await host(dirs, {}, sm);
  try {
    await h.runtime.session.prompt(`/test-tree ${setup}`);
    assert.equal(branchMarkers(sm).length, 0);
    await choose(h, "left", "low");
    assert.equal(
      branchMarkers(sm).length,
      0,
      "manual selection must not copy an abandoned branch marker into an unmarked branch",
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.runtime.dispose();
  }
});
await test("selected custom_message uses native selection without new marker", async () => {
  const dirs = directories("custom-message"),
    sm = durable(dirs.A);
  sm.appendModelChange("study", "left");
  sm.appendThinkingLevelChange("low");
  marker(sm, "right", "high");
  sm.appendCustomMessageEntry("context", "SELECTED_CUSTOM_MESSAGE", false);
  assert(!sm.getEntries().some((e) => e.type === "message"));
  assert.equal(sm.buildSessionProjection().messages.length, 1);
  const h = await host(dirs, {}, sm);
  try {
    assert.deepEqual(
      selection(h),
      { model: "left", thinking: "low" },
      "projected custom_message makes native selection authoritative even without native message records",
    );
    await choose(h, "right", "high");
    assert.equal(branchMarkers(sm).length, 1, "native selection changes must not refresh the old empty marker");
    await h.move(dirs.B);
    await workspace(h, "B", sm.getSessionId());
    assert.equal(
      branchMarkers(h.runtime.session.sessionManager).length,
      1,
      "continuation must not append an empty marker when custom context has messages",
    );
    freshResume(h, "custom-message");
  } finally {
    await h.runtime.dispose();
  }
});
assert.deepEqual(counters(), {
  fetchAttempts: 0,
  networkAttempts: 0,
  modelRequests: 0,
});
assert.equal(
  results.filter((r) => !r.passed).length,
  0,
  "selected-projection and branch-marker regressions must all pass",
);

assert.equal(results.length, 5, "all selected-branch observations must run");
