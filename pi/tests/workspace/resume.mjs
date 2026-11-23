import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { host, selection } from "./host.mjs";
import { counters, SM, sdk } from "./offline.mjs";

const [file, cwd, model, thinking] = process.argv.slice(2);
const before = readFileSync(file, "utf8");
const hasExistingContext = SM.open(file).buildSessionProjection().messages.length > 0;
const h = await host({ A: cwd }, {}, SM.open(file));
try {
  assert.equal(h.runtime.cwd, cwd);
  assert.equal(process.cwd(), cwd);
  assert.deepEqual(selection(h), { model, thinking });
  assert.deepEqual(h.errors, []);
  const after = readFileSync(file, "utf8");
  if (hasExistingContext) assert.equal(after, before);
  else
    assert(
      after.startsWith(before),
      "message-free SDK startup may append native setup records but cannot rewrite history",
    );
  assert.deepEqual(counters(), {
    fetchAttempts: 0,
    networkAttempts: 0,
    modelRequests: 0,
  });
  console.log(
    JSON.stringify({
      version: sdk.VERSION,
      cwd,
      id: h.runtime.session.sessionId,
      model,
      thinking,
      counters: counters(),
    }),
  );
} finally {
  await h.runtime.dispose();
}
