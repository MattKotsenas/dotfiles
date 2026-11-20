import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixture, runCode } from "./delegation/fixture.mjs";

const entry = fileURLToPath(new URL("../sandbox/sandbox.ts", import.meta.url));

test("reloading in SANDBOX restores the previous HOST tools", async t => {
  const { parent } = await fixture(t, { entry });
  parent.settingsManager.applyOverrides({ codemode: { mode: "only" } });
  parent.setActiveToolsByName(["codemode", "sandbox_manage", "bash", "read", "edit"]);

  const toggle = mode => parent.extensionRunner.getCommand("sandbox")
    .handler(mode, parent.extensionRunner.createCommandContext());
  const assertCallableTools = async expected => {
    const actual = await runCode(parent, "text(JSON.stringify(ALL_TOOLS.map(tool => tool.name).sort()))");
    assert.deepEqual(JSON.parse(actual.trim().split("\n").at(-1)), expected);
  };
  const host = ["bash", "edit", "read", "sandbox_manage"];
  const sandbox = ["sandbox_edit", "sandbox_manage", "sandbox_read", "sandbox_shell"];

  await assertCallableTools(host);
  await toggle("on");
  await assertCallableTools(sandbox);

  await parent.reload();
  await assertCallableTools(host);

  await toggle("on");
  await assertCallableTools(sandbox);
  await toggle("off");
  await assertCallableTools(host);
  assert.match(await runCode(parent, 'text(await tools.bash({command: "pwd"}))'), /pi-delegation-acceptance-/);
});
