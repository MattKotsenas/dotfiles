import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const piRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cases = join(piRoot, "tests", "workspace");
const extension = join(piRoot, "agent", "extensions", "workspace");

function isolated(t, script, { noMarker = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(key)),
  );
  Object.assign(env, {
    WORKSPACE_TEST_ROOT: root,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_OFFLINE: "1",
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
  });
  for (const path of [env.HOME, env.PI_CODING_AGENT_DIR, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) {
    mkdirSync(path, { recursive: true });
  }
  if (noMarker) {
    const copy = join(root, "mutant");
    cpSync(extension, copy, { recursive: true });
    const path = join(copy, "continuation.ts");
    const source = readFileSync(path, "utf8");
    const target = "manager.appendCustomEntry(selectionType,";
    assert.equal(source.split(target).length, 2, "exactly one recognized marker mutation target");
    writeFileSync(path, source.replace(target, 'manager.appendCustomEntry("workspace-disabled-control",'));
    env.WORKSPACE_TEST_PLUGIN = join(copy, "index.ts");
  }
  const child = spawnSync(process.execPath, [join(cases, script)], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const output = (child.stdout ?? "") + (child.stderr ?? "");
  assert.ifError(child.error);
  assert.equal(child.signal, null, output);
  return { status: child.status, output };
}

for (const [script, observations, resumes] of [
  ["transitions.mjs", 30, 5],
  ["root-branch.mjs", 5, 3],
  ["model-regression.mjs", 0, 0],
]) {
  test(`workspace SDK: ${script}`, { timeout: 210000 }, (t) => {
    const { status, output } = isolated(t, script);
    assert.equal(status, 0, output);
    assert.equal((output.match(/^PASS (?!fresh resume)/gm) ?? []).length, observations, output);
    assert.equal((output.match(/^PASS fresh resume/gm) ?? []).length, resumes, output);
    t.diagnostic(output.trim() || "Focused model-selection regression passed.");
  });
}

test("workspace SDK: focused model regression rejects the no-marker mutant", { timeout: 210000 }, (t) => {
  const { status, output } = isolated(t, "model-regression.mjs", { noMarker: true });
  assert.equal(status, 1, output);
  assert.match(output, /AssertionError \[ERR_ASSERTION\]/);
  assert.match(output, /native message-free checkpoint needs selection marker BEFORE SDK startup/);
  assert.match(output, /operator: 'deepStrictEqual'/);
  assert.match(output, /actual: \{ model: 'left', thinking: 'low' \}/);
  assert.match(output, /expected: \{ model: 'right', thinking: 'high' \}/);
  t.diagnostic("The same focused regression rejected the mutant at the right/high selection assertion.");
});
