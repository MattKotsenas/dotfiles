import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const message = "Set windowsHide: true as the last subprocess option to suppress Windows console windows.";

test("subprocess lint rule requires a final explicit windowsHide option", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subprocess-options-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ["missing-options", 'spawn("node", [])', false],
    ["missing-flag", 'execFileSync("pwsh", [], {encoding:"utf8"})', false],
    ["false-flag", 'spawnSync("node", [], {windowsHide:false})', false],
    ["commented-flag", 'spawn("node", [], {\n// windowsHide: true\n})', false],
    ["false-plus-comment", 'spawn("node", [], {windowsHide:false,\n// windowsHide: true\n})', false],
    ["nested-flag", 'execFile("node", [], {env:{windowsHide:true}})', false],
    ["overridden-flag", 'fork("worker", [], {windowsHide:true, ...options})', false],
    ["flag-in-string", 'execFileSync("node", ["windowsHide: true"])', false],
    ["promisified-missing-flag", 'promisify(execFile)("node", [], {timeout:1000})', false],
    ["alias-missing-flag", 'execFileCallback("node", [])', false],
    ["explicit-flag", 'spawn("node", [], {windowsHide:true})', true],
    ["flag-with-comment", 'spawn("node", [], {windowsHide:true // keep the console hidden\n})', true],
    ["multiple-options", 'spawnSync("node", [], {env, encoding:"utf8", timeout:1000, windowsHide:true})', true],
    ["flag-after-spread", 'fork("worker", [], {...options, windowsHide:true})', true],
    ["promisified-flag", 'promisify(execFile)("node", [], {timeout:1000, windowsHide:true})', true],
    ["no-argv", 'execFileSync("node", {windowsHide:true})', true],
    ["callback", 'execFile("node", [], {windowsHide:true}, callback)', true],
    ["callback-no-argv", 'execFile("node", {windowsHide:true}, callback)', true],
    ["other-api", 'pi.exec("node", [])', true],
  ];
  assert(
    cases.some(([, , valid]) => valid),
    "precondition: positive controls exist",
  );
  assert(
    cases.some(([, , valid]) => !valid),
    "precondition: negative controls exist",
  );
  for (const [name, source] of cases) await writeFile(join(root, `${name}.test.mjs`), source);
  await writeFile(
    join(root, "biome.json"),
    JSON.stringify({
      files: { includes: ["**/*.mjs"] },
      plugins: [fileURLToPath(new URL("./process-options.grit", import.meta.url))],
    }),
  );
  // Use the native binary on Windows; the npm launcher starts its own child without windowsHide.
  const executable =
    process.platform === "win32"
      ? fileURLToPath(import.meta.resolve(`@biomejs/cli-win32-${process.arch}/biome.exe`))
      : process.execPath;
  const prefix = process.platform === "win32" ? [] : [fileURLToPath(import.meta.resolve("@biomejs/biome/bin/biome"))];
  const result = spawnSync(executable, [...prefix, "lint", "--config-path", root, "--reporter=json", root], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  const diagnostics = report.diagnostics.filter((entry) => entry.message === message);
  const rejected = diagnostics.map((entry) => entry.location.path.split(/[\\/]/).at(-1)).sort();
  const expected = cases
    .filter(([, , valid]) => !valid)
    .map(([name]) => `${name}.test.mjs`)
    .sort();
  assert.deepEqual(rejected, expected, result.stdout + result.stderr);
  assert.equal(report.summary.errors, expected.length, "only deliberate rule violations fail lint");
});
