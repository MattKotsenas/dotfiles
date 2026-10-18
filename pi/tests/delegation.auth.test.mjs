import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("production auth adapter SDK compatibility", { timeout: 150000 }, async (t) => {
  const fixtures = await mkdtemp(join(tmpdir(), "pi-delegation-auth-"));
  try {
    const files = ["auth", "auth-lifecycle", "model-refresh"].map((name) =>
      fileURLToPath(new URL(`./delegation/${name}.cases.mjs`, import.meta.url)));
    const env = { ...process.env, PI_DELEGATION_AUTH_FIXTURES: fixtures, PI_OFFLINE: "1" };
    delete env.NODE_TEST_CONTEXT; // The workers are a new test run, not nested test-runner imports.
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], {
      env,
      encoding: "utf8", timeout: 120000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    assert.ifError(result.error);
    assert.equal(result.status, 0, output);
    assert.match(output, /^# tests [1-9]\d*$/m);
    assert.match(output, /^# fail 0$/m);
    assert.match(output, /^# cancelled 0$/m);
    assert.match(output, /^# skipped 0$/m);
    t.diagnostic(output.trim());
  } finally {
    // Superseded SDK model-refresh work can outlive its returned promise. Delete
    // fixture files only after the test workers exit, so it cannot recreate them.
    await rm(fixtures, { recursive: true, force: true });
  }
});
