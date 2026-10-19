import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import { answer, fixture, invoke, runCode } from "./delegation/fixture.mjs";
import { lifecycle } from "./delegation/lifecycle-extension.mjs";
import { network, usage } from "./delegation/usage-provider.mjs";
import { sdk } from "./delegation/sdk.mjs";

const providerModule = fileURLToPath(new URL("./delegation/usage-provider.mjs", import.meta.url));
const worker = fileURLToPath(new URL("./delegation/resume-parent.mjs", import.meta.url));
const list = async (parent) => {
  const output = await runCode(parent, 'text("CHILDREN:" + JSON.stringify(await tools.delegates({})));');
  return JSON.parse(output.match(/^CHILDREN:(.+)$/m)[1]).details.children;
};

async function installLifecycle(authPath) {
  await writeFile(
    join(dirname(authPath), "extensions/lifecycle.ts"),
    `export { default } from ${JSON.stringify(new URL("./delegation/lifecycle-extension.mjs", import.meta.url).href)};\n`,
  );
}

async function nativeCall(parent, args) {
  const before = parent.messages.length;
  await parent.prompt(`ACCEPTANCE_CODE:await tools.delegate(${JSON.stringify(args)});`);
  return parent.messages.slice(before).find((m) => m.role === "toolResult" && m.toolName === "codemode");
}

describe("delegation conversation restoration", { concurrency: false }, () => {
  test("separate discovery rejects execution arguments and creates no child work", { timeout: 20000 }, async (t) => {
    const { parent } = await fixture(t, { providerModule });
    assert.deepEqual(await list(parent), []);
    const requests = [];
    const collect = (prompt) => {
      if (!prompt.startsWith("ACCEPTANCE_CODE:")) requests.push(prompt);
    };
    network.on("request", collect);
    t.after(() => network.off("request", collect));
    for (const code of [
      "await tools.delegate({ list: true });",
      'await tools.delegates({ prompt: "Remember unwanted" });',
    ]) {
      const output = await runCode(
        parent,
        `try { ${code} text("UNEXPECTED_SUCCESS"); } catch (error) { text(error.message); }`,
      );
      assert.match(output, /Validation failed/);
      assert.doesNotMatch(output, /UNEXPECTED_SUCCESS/);
    }
    assert.deepEqual(await list(parent), []);
    assert.deepEqual(requests, [], "invalid arguments and listing must never reach a child provider");
  });

  test("reload retains isolated conversations, explicit prompt/tools and handles", { timeout: 20000 }, async (t) => {
    const { parent } = await fixture(t, { persisted: true });
    assert.deepEqual(await list(parent), []);
    const handles = [];
    for (const word of ["violet", "amber"]) {
      handles.push(
        (
          await invoke(parent, {
            prompt: `Remember this word: ${word}`,
            systemPrompt: "Prefix recalled words with MEMORY:",
            tools: [],
          })
        ).details.handle,
      );
    }
    const file = parent.sessionManager.getSessionFile();
    assert(file);
    const childDir = file.replace(/\.jsonl$/, "");
    const files = await readdir(childDir);
    assert.equal(files.length, 2);
    for (const child of files) {
      const [header] = (await readFile(join(childDir, child), "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(header.parentSession, file);
    }
    assert.equal(
      (await readdir(dirname(file))).filter((name) => name.endsWith(".jsonl")).length,
      1,
      "child files must not become candidates for pi --continue",
    );
    await parent.reload();
    const beforeList = await Promise.all(files.map((child) => readFile(join(childDir, child), "utf8")));
    const children = await list(parent);
    assert.deepEqual(
      await Promise.all(files.map((child) => readFile(join(childDir, child), "utf8"))),
      beforeList,
      "listing must leave child files untouched",
    );
    assert.deepEqual(
      children.map((child) => child.handle),
      handles,
    );
    assert(children.every((child) => child.status === "completed"));
    for (const [i, handle] of handles.entries()) {
      assert.equal(
        answer(await invoke(parent, { handle, prompt: "What word did I ask you to remember?" })),
        `MEMORY:${["violet", "amber"][i]}`,
      );
    }
  });

  test("fresh-process resume restores usage cursor and uses current parent credentials", {
    timeout: 30000,
  }, async (t) => {
    const { parent, authPath, expectedKeyPath } = await fixture(t, { persisted: true, providerModule });
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    assert.deepEqual(first.usage, usage(7));
    const file = parent.sessionManager.getSessionFile();
    await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const key = "synthetic-restored-new-key";
    await writeFile(authPath, JSON.stringify({ "delegation-acceptance": { type: "api_key", key } }));
    await writeFile(expectedKeyPath, key);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        worker,
        file,
        parent.sessionManager.getCwd(),
        dirname(authPath),
        JSON.stringify({ handle: first.details.handle, prompt: "Recall" }),
      ],
      { env: process.env, timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    const restored = JSON.parse(stdout.match(/^RESUMED:(.+)$/m)[1]);
    assert.match(restored.listing, new RegExp(first.details.handle));
    assert.equal(answer(restored.result), "Remember violet");
    assert.deepEqual(restored.result.usage, usage(11), "resume must exclude previously reported entries");
  });

  test("restored requests keep the child model and saved thinking level when the parent changes model", {
    timeout: 20000,
  }, async (t) => {
    const { parent, modelRuntime } = await fixture(t, { persisted: true, providerModule });
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    const record = parent.sessionManager
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === "delegation.child.v1").data;
    await parent.reload();
    sdk.SessionManager.open(record.sessionFile).appendThinkingLevelChange("high");
    const alternate = modelRuntime.getModel("delegation-acceptance", "alternate");
    assert(alternate);
    await parent.setModel(alternate);
    assert.equal(parent.model.id, "alternate");
    const requests = [];
    const collect = (prompt, config) => {
      if (prompt === "Recall") requests.push(config);
    };
    network.on("request", collect);
    t.after(() => network.off("request", collect));
    const recalled = await invoke(parent, { handle: first.details.handle, prompt: "Recall" });
    assert.equal(answer(recalled), "Remember violet");
    assert.deepEqual(requests, [{ model: "scripted", reasoning: "high" }]);
  });

  test("a forked parent cannot discover or continue the original parent's handles", { timeout: 30000 }, async (t) => {
    const { parent, authPath } = await fixture(t, { persisted: true, providerModule });
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    const file = parent.sessionManager.getSessionFile();
    const branched = sdk.SessionManager.open(file);
    const forkFile = branched.createBranchedSession(branched.getLeafId());
    assert(forkFile);
    assert.notEqual(sdk.SessionManager.open(forkFile).getSessionId(), parent.sessionId);
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          worker,
          forkFile,
          parent.sessionManager.getCwd(),
          dirname(authPath),
          JSON.stringify({ handle: first.details.handle, prompt: "Recall" }),
        ],
        { env: process.env, timeout: 20000, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        assert.match(error.stdout, /"children":\[\]/);
        assert.match(error.stderr, /Unknown delegation handle for this session/);
        return true;
      },
    );
    assert.equal(answer(await invoke(parent, { handle: first.details.handle, prompt: "Recall" })), "Remember violet");
  });

  test("first-call interruption can be discovered and continued after reload without replay", {
    timeout: 20000,
  }, async (t) => {
    let release;
    t.after(() => release?.());
    const { parent, authPath } = await fixture(t, { persisted: true, providerModule });
    await installLifecycle(authPath);
    const cwd = parent.sessionManager.getCwd();
    await writeFile(join(cwd, "wait-in-probe"), "wait");
    const controller = new AbortController();
    t.after(() => controller.abort());
    const entered = once(lifecycle, "tool-entered", { signal: controller.signal });
    const running = nativeCall(parent, { prompt: "Probe directly", tools: ["probe"] });
    [release] = await Promise.race([
      entered,
      running.then(() => {
        throw new Error("Tool gate was not reached");
      }),
    ]);
    await parent.abort();
    assert.equal((await running).isError, true);
    assert.equal(await readFile(join(cwd, "probe-effects"), "utf8"), "entered\ncancelled\n");
    await parent.reload();
    const children = await list(parent);
    assert.equal(children.length, 1);
    assert.equal(children[0].prompt, "Probe directly");
    assert.equal(children[0].status, "interrupted");
    await invoke(parent, { handle: children[0].handle, prompt: "Remember recovered" });
    assert.equal(
      await readFile(join(cwd, "probe-effects"), "utf8"),
      "entered\ncancelled\n",
      "restoration must not replay the interrupted tool",
    );
  });

  test("a stopping child stays discoverable and rejects follow-ups until cleanup settles", {
    timeout: 20000,
  }, async (t) => {
    let release, releaseCleanup;
    t.after(() => {
      release?.();
      releaseCleanup?.();
    });
    const { parent, authPath } = await fixture(t, { providerModule });
    await installLifecycle(authPath);
    const first = await invoke(parent, { prompt: "Remember violet", tools: ["probe"] });
    const cwd = parent.sessionManager.getCwd();
    await writeFile(join(cwd, "wait-in-probe"), "wait");
    await writeFile(join(cwd, "hold-cleanup"), "hold");
    const controller = new AbortController();
    t.after(() => controller.abort());
    const entered = once(lifecycle, "tool-entered", { signal: controller.signal });
    const cleaning = once(lifecycle, "cleanup-held", { signal: controller.signal });
    const finished = Promise.withResolvers();
    const unsubscribe = parent.subscribe((event) => {
      if (
        event.type === "tool_execution_end" &&
        event.toolName === "delegate" &&
        event.result.details?.handle === first.details.handle
      )
        finished.resolve();
    });
    t.after(unsubscribe);
    const running = nativeCall(parent, { handle: first.details.handle, prompt: "Probe directly" });
    [release] = await entered;
    const cancelling = parent.abort();
    [releaseCleanup] = await cleaning;
    await cancelling;
    assert.equal((await running).isError, true);
    const stopping = await list(parent);
    assert.equal(stopping[0].status, "stopping");
    const rejected = await nativeCall(parent, { handle: first.details.handle, prompt: "Recall" });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content.map((b) => b.text).join("\n"), /call in progress or is stopping/);
    releaseCleanup();
    await finished.promise;
    assert.equal((await list(parent))[0].status, "interrupted");
    assert.equal(answer(await invoke(parent, { handle: first.details.handle, prompt: "Recall" })), "Remember violet");
  });

  test("startup interruption persists an identity before any child prompt exists", { timeout: 20000 }, async (t) => {
    let release;
    t.after(() => release?.());
    const { parent, authPath } = await fixture(t, { persisted: true, providerModule });
    await installLifecycle(authPath);
    const cwd = parent.sessionManager.getCwd();
    await writeFile(join(cwd, "hold-startup"), "hold");
    const controller = new AbortController();
    t.after(() => controller.abort());
    const entered = once(lifecycle, "startup-held", { signal: controller.signal });
    const running = nativeCall(parent, { prompt: "Remember never-started", tools: [] });
    [release] = await entered;
    const cancelling = parent.abort();
    release();
    await cancelling;
    assert.equal((await running).isError, true);
    await rm(join(cwd, "hold-startup"));
    await parent.reload();
    const [child] = await list(parent);
    assert.equal(child.status, "interrupted");
    assert.equal(child.prompt, "Remember never-started");
    const recalled = await invoke(parent, { handle: child.handle, prompt: "Recall" });
    assert.equal(answer(recalled), "HISTORY_MISSING", "the canceled first prompt must not have been submitted");
    assert.deepEqual(recalled.usage, usage(11));
  });

  test("restoration fails closed for a missing conversation or unavailable saved model", {
    timeout: 20000,
  }, async (t) => {
    const { parent } = await fixture(t, { persisted: true, providerModule });
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    const second = await invoke(parent, { prompt: "Remember amber", tools: [] });
    const third = await invoke(parent, { prompt: "Remember teal", tools: [] });
    const records = parent.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "delegation.child.v1");
    const firstFile = records.find((entry) => entry.data.handle === first.details.handle).data.sessionFile;
    const secondFile = records.find((entry) => entry.data.handle === second.details.handle).data.sessionFile;
    const thirdFile = records.find((entry) => entry.data.handle === third.details.handle).data.sessionFile;
    await parent.reload();
    await rm(firstFile);
    await writeFile(thirdFile, "");
    sdk.SessionManager.open(secondFile).appendModelChange("missing-provider", "missing-model");
    for (const [handle, pattern] of [
      [first.details.handle, /conversation file is missing/],
      [second.details.handle, /Unknown model: missing-provider\/missing-model/],
      [third.details.handle, /conversation file is missing or empty/],
    ]) {
      const failed = await nativeCall(parent, { handle, prompt: "Recall" });
      assert.equal(failed.isError, true);
      assert.match(failed.content.map((b) => b.text).join("\n"), pattern);
      assert(
        failed.usage === undefined || failed.usage.totalTokens === 0,
        "old usage must not be charged again when restoration fails",
      );
    }
    assert((await list(parent)).every((child) => child.status === "failed"));
    assert.equal(await readFile(thirdFile, "utf8"), "", "restoration must not overwrite a damaged child file");
  });

  test("damaged JSONL and truncated checkpoints fail before a child request and leave files untouched", {
    timeout: 20000,
  }, async (t) => {
    const { parent } = await fixture(t, { persisted: true, providerModule });
    const cases = [];
    for (const damage of ["header-only", "malformed-message", "malformed-tail", "broken-parent"]) {
      const first = await invoke(parent, { prompt: `Remember ${damage}`, tools: [] });
      const record = parent.sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "delegation.child.v1" &&
            entry.data.handle === first.details.handle,
        ).data;
      const lines = (await readFile(record.sessionFile, "utf8")).trim().split("\n");
      if (damage === "header-only") lines.splice(1);
      else if (damage === "malformed-tail") lines.push("{broken trailing entry");
      else {
        const index = lines.findIndex((line) => JSON.parse(line).message?.role === "user");
        assert(index > 0);
        if (damage === "malformed-message") lines[index] = "{broken user message";
        else lines[index] = JSON.stringify({ ...JSON.parse(lines[index]), parentId: "missing-parent" });
      }
      cases.push({ handle: first.details.handle, file: record.sessionFile, contents: `${lines.join("\n")}\n` });
    }
    await parent.reload();
    const requests = [];
    const collect = (prompt) => {
      if (prompt === "Recall") requests.push(prompt);
    };
    network.on("request", collect);
    t.after(() => network.off("request", collect));
    for (const entry of cases) {
      await writeFile(entry.file, entry.contents);
      assert.equal(await readFile(entry.file, "utf8"), entry.contents);
      const failed = await nativeCall(parent, { handle: entry.handle, prompt: "Recall" });
      assert.equal(failed.isError, true, "damaged history must not be resumed");
      assert.match(failed.content.map((block) => block.text).join("\n"), /damaged|checkpoint/);
      assert(failed.usage === undefined || failed.usage.totalTokens === 0);
      assert.deepEqual(requests, [], "rejected recovery must not reach the child provider");
      assert.equal(await readFile(entry.file, "utf8"), entry.contents, "recovery must not rewrite the damaged file");
    }
  });

  test("an ephemeral parent creates no native child files and loses handles on reload", {
    timeout: 20000,
  }, async (t) => {
    const { parent, authPath } = await fixture(t, { providerModule });
    assert.equal(parent.sessionManager.getSessionFile(), undefined);
    await invoke(parent, { prompt: "Remember violet", tools: [] });
    assert.equal((await list(parent)).length, 1);
    assert(!(await readdir(dirname(authPath))).includes("sessions"));
    await parent.reload();
    assert.deepEqual(await list(parent), []);
  });

  test("shutdown aborts an active child before waiting for it to settle", { timeout: 20000 }, async (t) => {
    let release;
    t.after(() => release?.());
    const { parent, authPath } = await fixture(t, { providerModule });
    await installLifecycle(authPath);
    const cwd = parent.sessionManager.getCwd();
    await writeFile(join(cwd, "wait-in-probe"), "wait");
    const controller = new AbortController();
    t.after(() => controller.abort());
    const entered = once(lifecycle, "tool-entered", { signal: controller.signal });
    const running = nativeCall(parent, { prompt: "Probe directly", tools: ["probe"] });
    [release] = await entered;
    await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal((await running).isError, true);
    assert.equal(await readFile(join(cwd, "probe-effects"), "utf8"), "entered\ncancelled\n");
  });
});
