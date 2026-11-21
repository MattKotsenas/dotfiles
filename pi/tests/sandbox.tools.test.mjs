import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixture, invoke, runCode } from "./delegation/fixture.mjs";

const sandboxExtension = fileURLToPath(new URL("../sandbox/sandbox.ts", import.meta.url));
const sandbox = ["sandbox_edit", "sandbox_read", "sandbox_shell"];
const host = ["bash", "edit", "read"];
const options = { extraExtensions: [sandboxExtension], defaultTools: ["codemode", ...host] };
const list = "text(JSON.stringify(ALL_TOOLS.map(tool => tool.name).sort()))";
const names = output => JSON.parse(output.trim().split("\n").at(-1));
const toggle = (parent, mode) => parent.extensionRunner.getCommand("sandbox")
  .handler(mode, parent.extensionRunner.createCommandContext());
const setup = async (t, overrides) => {
  const { parent } = await fixture(t, { ...options, ...overrides });
  parent.settingsManager.applyOverrides({ codemode: { mode: "only" } });
  return parent;
};

test("sandbox stays available with host access enabled, and reload revokes host access without forgetting tools", async t => {
  const parent = await setup(t);
  const always = ["delegate", "delegates", ...sandbox, "sandbox_manage"].sort();
  const assertTools = async expected => assert.deepEqual(names(await runCode(parent, list)), expected);

  await assertTools(always);
  await toggle(parent, "off");
  await assertTools([...always, ...host].sort());
  assert.match(await runCode(parent, 'text(await tools.bash({command: "pwd"}))'), /pi-delegation-acceptance-/);

  await parent.reload();
  await assertTools(always);
  await toggle(parent, "off");
  await assertTools([...always, ...host].sort());
  await toggle(parent, "on");
  await assertTools(always);
});

test("a child handle uses the parent's tool access on each turn, including after reload", async t => {
  const parent = await setup(t, { persisted: true });
  const prompt = "SANDBOX_CHILD_CODE:" + list;
  const ask = async args => invoke(parent, { prompt, ...args });
  const answer = result => result.content[0].text;

  const first = await ask({});
  const { handle } = first.details;
  assert.deepEqual(names(answer(first)), sandbox);

  await toggle(parent, "off");
  const second = await ask({ handle });
  assert.equal(second.details.handle, handle);
  assert.deepEqual(names(answer(second)), [...host, ...sandbox].sort());
  const pwd = await invoke(parent, { handle, prompt: 'SANDBOX_CHILD_CODE:text(await tools.bash({command: "pwd"}))' });
  assert.match(answer(pwd), /pi-delegation-acceptance-/);

  await parent.reload();
  assert.deepEqual(names(answer(await ask({ handle }))), sandbox);
  const narrowed = await ask({ tools: ["bash", "sandbox_read", "sandbox_manage"] });
  assert.deepEqual(names(answer(narrowed)), ["sandbox_read"]);
});

test("sandbox tools and a delegated edit use the actual parent workspace in both modes", {
  skip: process.env.PI_SANDBOX_LIVE_TEST !== "1",
}, async t => {
  const home = homedir();
  const { default: defaults } = JSON.parse(readFileSync(join(home, ".config/pi-sandbox/config.json"), "utf8"));
  assert.equal(defaults.profile, "offline", "Run this test only with a disposable offline sandbox");
  const parent = await setup(t);
  const id = parent.sessionManager.getSessionId();
  const ctl = (...args) => execFileSync(join(home, ".local/bin/pi-sandboxctl"), args, { encoding: "utf8" });
  const status = () => JSON.parse(ctl("status", id));
  const path = ".pi-sandbox-test-" + randomUUID();
  t.after(() => {
    if (status().state === "absent") return;
    try {
      ctl("exec", id, "/bin/rm", "-f", path);
    } finally {
      ctl("destroy", id);
    }
  });

  const shell = command => runCode(parent, `text(await tools.sandbox_shell({command: ${JSON.stringify(command)}}))`);
  assert.equal(status().state, "absent");
  await toggle(parent, "off");
  assert.equal(status().state, "absent", "Granting host access does not start the sandbox");
  assert.match(await shell(`set -e; pwd; test ! -e ${path}; printf '%s' before > ${path}`), /\/workspace/);
  assert.equal(status().profile, "offline");
  const child = async (code, handle) => (await invoke(parent, {
    prompt: "SANDBOX_CHILD_CODE:" + code, ...(handle === undefined ? {} : { handle }),
  }));
  const initial = await child(`text(await tools.sandbox_read({path:${JSON.stringify(path)}}))`);
  assert.match(initial.content[0].text, /before/);

  await toggle(parent, "on");
  const edited = await child(`text(await tools.sandbox_edit({
    path:${JSON.stringify(path)}, edits:[{oldText:"before",newText:"after"}]
  }))`, initial.details.handle);
  assert.doesNotMatch(edited.content[0].text, /Script failed/);
  assert.match(await shell(`cat ${path}`), /after/);
});
