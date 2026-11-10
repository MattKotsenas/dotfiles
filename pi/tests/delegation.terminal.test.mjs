import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { answer, fixture, invoke, runCode } from "./delegation/fixture.mjs";
import { modelId, providerId, quotaCode } from "./delegation/quota-provider.mjs";
import { sdk } from "./delegation/sdk.mjs";

const text = (message) =>
  message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

test("delegates leave the terminal parent's mapping intact across cwd changes, reload and follow-up", {
  timeout: 20000,
}, async (t) => {
  const { parent, authPath } = await fixture(t, { persisted: true });
  const root = dirname(authPath);
  const variables = ["USERPROFILE", "PSMUX_SESSION", "TMUX", "TMUX_PANE"];
  const previous = variables.map((key) => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.USERPROFILE = join(root, "home");
  process.env.PSMUX_SESSION = "synthetic-not-a-server";
  process.env.TMUX = "synthetic-not-a-socket,1,0";
  process.env.TMUX_PANE = "%987654";
  await writeFile(
    join(root, "extensions/session-map.ts"),
    `export { default } from ${JSON.stringify(new URL("../agent/extensions/psmux-session-map.ts", import.meta.url).href)};`,
  );
  await parent.reload();
  const maps = join(process.env.USERPROFILE, ".pi/agent/psmux-sessions");
  await assert.rejects(readdir(maps), { code: "ENOENT" }, "non-terminal startup must not publish a pane mapping");
  await parent.bindExtensions({ mode: "tui" });
  const expected = [{ sessionId: parent.sessionId, sessionFile: parent.sessionManager.getSessionFile() }];
  const check = async () => {
    const mappings = await Promise.all(
      (await readdir(maps)).map(async (name) => JSON.parse(await readFile(join(maps, name), "utf8"))),
    );
    assert.deepEqual(mappings, expected);
  };
  await check();
  const first = await invoke(parent, {
    prompt: "Remember this word: violet",
    systemPrompt: { replace: "Prefix recalled words with MEMORY:" },
    tools: [],
  });
  await check();
  const cwd = join(root, "another-workspace");
  await mkdir(cwd);
  await invoke(parent, { prompt: "Remember this word: amber", tools: [], cwd });
  await check();
  await runCode(parent, 'text("PARENT_CONTINUED");');
  await check();
  await parent.reload();
  await check();
  assert.equal(
    answer(await invoke(parent, { handle: first.details.handle, prompt: "What word did I ask you to remember?" })),
    "MEMORY:violet",
  );
  await check();
  await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(await readdir(maps), []);
});

test("delegate quota errors reach the parent without waiting and preserve the handle for an explicit retry", {
  timeout: 15000,
}, async (t) => {
  const { parent } = await fixture(t, {
    persisted: true,
    providerModule: fileURLToPath(new URL("./delegation/quota-provider.mjs", import.meta.url)),
  });
  const waiting = Promise.withResolvers();
  await parent.bindExtensions({
    mode: "tui",
    uiContext: {
      ...parent.extensionRunner.getUIContext(),
      notify: (message) => {
        if (message.includes("Waiting to retry automatically")) waiting.resolve("waiting");
      },
    },
  });
  assert.notEqual(
    parent.model.provider,
    providerId,
    "precondition: quota failure belongs to the child, not the parent",
  );
  const before = parent.messages.length;
  const operation = parent.prompt(
    `ACCEPTANCE_CODE:await tools.delegate(${JSON.stringify({ provider: providerId, model: modelId, prompt: "Review the change.", tools: [] })}); text("UNEXPECTED_SUCCESS");`,
  );
  assert.equal(
    await Promise.race([operation.then(() => "finished"), waiting.promise]),
    "finished",
    "quota must fail the call instead of hiding a wait in the child",
  );
  await operation;
  const result = parent.messages
    .slice(before)
    .find((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert(result);
  assert.equal(result.isError, true);
  assert.match(text(result), new RegExp(quotaCode));
  assert.doesNotMatch(text(result), /UNEXPECTED_SUCCESS/);
  const record = parent.sessionManager
    .getEntries()
    .findLast((entry) => entry.type === "custom" && entry.customType === "delegation.child.v1").data;
  assert.equal(record.status, "failed");
  const child = sdk.SessionManager.open(record.sessionFile);
  assert.deepEqual(
    child.getEntries().find((entry) => entry.type === "custom" && entry.customType === "quota-mode").data,
    { mode: "print", hasUI: true },
  );
  assert.equal(
    child.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "quota-request").length,
    1,
    "quota must not retry automatically",
  );
  assert.equal(
    answer(await invoke(parent, { handle: record.handle, prompt: "Retry the review." })),
    "REVIEW_COMPLETED",
  );
});
