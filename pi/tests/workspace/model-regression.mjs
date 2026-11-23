import assert from "node:assert/strict";
import { choose, directories, durable, host, selection } from "./host.mjs";
import { counters } from "./offline.mjs";

const dirs = directories("native-empty-selection");
const manager = durable(dirs.A, true);
const h = await host(dirs, {}, manager);
try {
  assert(!manager.getEntries().some((e) => e.customType === "workspace-empty-selection"));
  await choose(h, "right", "high");
  const id = h.runtime.session.sessionId;
  await h.move(dirs.B);
  assert.equal(h.runtime.cwd, dirs.B);
  assert.equal(h.runtime.session.sessionId, id);
  assert.deepEqual(
    selection(h),
    { model: "right", thinking: "high" },
    "native message-free checkpoint needs selection marker BEFORE SDK startup",
  );
} finally {
  await h.runtime.dispose();
  assert.deepEqual(counters(), { fetchAttempts: 0, networkAttempts: 0, modelRequests: 0 });
}
