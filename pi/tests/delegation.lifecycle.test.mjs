import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { answer, fixture, invoke, runCode } from "./delegation/fixture.mjs";
import { lifecycle } from "./delegation/lifecycle-extension.mjs";
import { network, usage } from "./delegation/usage-provider.mjs";

const providerModule = fileURLToPath(new URL("./delegation/usage-provider.mjs", import.meta.url));
const extensionModule = new URL("./delegation/lifecycle-extension.mjs", import.meta.url).href;
const text = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const call = (args) => `await tools.delegate(${JSON.stringify(args)})`;

async function installChildExtension(authPath) {
  await writeFile(join(dirname(authPath), "extensions/lifecycle.ts"),
    `export { default } from ${JSON.stringify(extensionModule)};\n`);
}

async function script(parent, code) {
  const before = parent.messages.length;
  await parent.prompt(`ACCEPTANCE_CODE:${code}`);
  const result = parent.messages.slice(before).find((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert(result, "the real codemode call must settle with a native result");
  return result;
}

// Cancel event waits at teardown rather than leaving listeners behind after a failed assertion.
function nextEvent(t, emitter, name) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  return once(emitter, name, { signal: controller.signal });
}

function record(t, emitter, name) {
  const events = [];
  const collect = (...args) => events.push(args);
  emitter.on(name, collect);
  t.after(() => emitter.off(name, collect));
  return events;
}

async function enteredBeforeCompletion(event, running) {
  return Promise.race([event, running.then((result) => {
    throw new Error(`Delegation completed before reaching the gate: ${text(result)}`);
  })]);
}

function assertSessionTotals(parent, childUsage) {
  const assistants = parent.messages.filter((message) => message.role === "assistant");
  assert(assistants.length > 0);
  const parentCost = assistants.reduce((sum, message) => sum + message.usage.cost.total, 0);
  const stats = parent.getSessionStats();
  assert.equal(stats.cost, parentCost + childUsage.cost.total,
    "parent totals must include the child's recorded cost exactly once");
  for (const [field, token] of [["input", "input"], ["output", "output"], ["cacheRead", "cacheRead"], ["cacheWrite", "cacheWrite"], ["total", "totalTokens"]]) {
    assert.equal(stats.tokens[field], childUsage[token] + assistants.reduce((sum, message) => sum + message.usage[token], 0));
  }
}

describe("delegation policy and cooperative cancellation", { concurrency: false }, () => {
  for (const nested of [false, true]) {
    test(`child policy allows and denies side effects through ${nested ? "codemode" : "a direct tool call"}`, { timeout: 20000 }, async (t) => {
      const { parent, authPath } = await fixture(t, { providerModule });
      await installChildExtension(authPath);
      const cwd = parent.sessionManager.getCwd();
      const marker = join(cwd, "probe-effects");
      const args = { prompt: nested ? "Probe through codemode" : "Probe directly", tools: nested ? ["codemode", "probe"] : ["probe"] };
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const allowed = await invoke(parent, args);
      assert.match(answer(allowed), /PROBE_EXECUTED/);
      assert.equal(await readFile(marker, "utf8"), "entered\n", "positive control: the tool can produce a real effect");
      await writeFile(join(cwd, "deny-probe"), "deny");
      assert.equal(await readFile(marker, "utf8"), "entered\n");
      const denied = await invoke(parent, args);
      assert.match(answer(denied), /Child policy denied probe/);
      assert.equal(await readFile(marker, "utf8"), "entered\n", "denied execution must produce no further effect");
      const stillDenied = await invoke(parent, { handle: allowed.details.handle, prompt: args.prompt });
      assert.match(answer(stillDenied), /Child policy denied probe/);
      assert.equal(await readFile(marker, "utf8"), "entered\n", "policy must also run on an existing child");
    });
  }

  for (const nested of [false, true]) {
    test(`parent cancellation stops a child tool${nested ? " inside child codemode" : ""} and invalidates its handle`, { timeout: 20000 }, async (t) => {
      let releaseTool;
      t.after(() => releaseTool?.());
      const { parent, authPath } = await fixture(t, { providerModule });
      await installChildExtension(authPath);
      const first = await invoke(parent, { prompt: "Remember violet", tools: nested ? ["codemode", "probe"] : ["probe"] });
      const cwd = parent.sessionManager.getCwd();
      const marker = join(cwd, "probe-effects");
      await writeFile(join(cwd, "wait-in-probe"), "wait");
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      const entered = nextEvent(t, lifecycle, "tool-entered");
      const closed = record(t, lifecycle, "closed");
      const requests = record(t, network, "request");
      const prompt = nested ? "Probe through codemode" : "Probe directly";
      const running = script(parent, `${call({ handle: first.details.handle, prompt })}; text("UNEXPECTED_SUCCESS");`);
      [releaseTool] = await enteredBeforeCompletion(entered, running);
      assert.equal(await readFile(marker, "utf8"), "entered\n");
      assert.equal(closed.length, 0);
      assert.deepEqual(requests.map(([value]) => value).filter((value) => value === prompt), [prompt]);
      await parent.abort();
      const result = await running;
      assert.equal(result.isError, true, text(result));
      assert.doesNotMatch(text(result), /UNEXPECTED_SUCCESS/);
      assert.equal(await readFile(marker, "utf8"), "entered\ncancelled\n");
      assert.equal(closed.length, 1, "the child must receive shutdown before delegation settles");
      assert.deepEqual(requests.map(([value]) => value).filter((value) => value === prompt), [prompt],
        "the child must not ask the model to continue after cancellation");
      const rejected = await script(parent, `${call({ handle: first.details.handle, prompt: "Recall" })}; text("UNEXPECTED_SUCCESS");`);
      assert.equal(rejected.isError, true, text(rejected));
      assert.match(text(rejected), /Unknown delegation handle/);
      assert(rejected.usage === undefined || rejected.usage.totalTokens === 0);
      assert.equal(closed.length, 1);
      assert.equal(await readFile(marker, "utf8"), "entered\ncancelled\n");
      assert.match(await runCode(parent, 'text("PARENT_STILL_USABLE");'), /PARENT_STILL_USABLE/);
    });
  }

  test("late child usage reaches parent totals after codemode cancellation", {
    timeout: 20000,
    skip: "Pi 1.2.0/1.3.0 codemode accounting race: late nested usage is lost; requires an SDK fix (upstream report pending).",
  }, async (t) => {
    let releaseTool, releaseCleanup;
    t.after(() => { releaseTool?.(); releaseCleanup?.(); });
    const { parent, authPath } = await fixture(t, { providerModule });
    await installChildExtension(authPath);
    const first = await invoke(parent, { prompt: "Remember violet", tools: ["probe"] });
    assert.deepEqual(first.usage, usage(7));
    const cwd = parent.sessionManager.getCwd();
    await writeFile(join(cwd, "wait-in-probe"), "wait");
    await writeFile(join(cwd, "hold-cleanup"), "hold");
    const entered = nextEvent(t, lifecycle, "tool-entered");
    const cleaning = nextEvent(t, lifecycle, "cleanup-held");
    const finished = Promise.withResolvers();
    const unsubscribe = parent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "delegate") finished.resolve(event.result);
    });
    t.after(unsubscribe);
    const running = script(parent, `${call({ handle: first.details.handle, prompt: "Probe directly" })}; text("UNEXPECTED_SUCCESS");`);
    [releaseTool] = await enteredBeforeCompletion(entered, running);
    const cancelling = parent.abort();
    [releaseCleanup] = await cleaning;
    await cancelling;
    const result = await running;
    assert.equal(result.isError, true, text(result));
    assert.equal(await readFile(join(cwd, "probe-effects"), "utf8"), "entered\n");
    releaseCleanup();
    assert.deepEqual((await finished.promise).usage, usage(3), "the child returns its billed work after codemode finishes");
    assertSessionTotals(parent, usage(10));
  });

  test("cancellation during child startup prevents the first model request and closes the child", { timeout: 20000 }, async (t) => {
    const { parent, authPath } = await fixture(t, { providerModule });
    await installChildExtension(authPath);
    await writeFile(join(parent.sessionManager.getCwd(), "hold-startup"), "hold");
    const entered = nextEvent(t, lifecycle, "startup-held");
    const closed = record(t, lifecycle, "closed");
    const requests = record(t, network, "request");
    const running = script(parent, `${call({ prompt: "Remember never-started", tools: [] })}; text("UNEXPECTED_SUCCESS");`);
    const [release] = await enteredBeforeCompletion(entered, running);
    try {
      assert.equal(closed.length, 0);
      assert.equal(requests.length, 1, "only the parent's codemode request has reached the model");
      const cancelling = parent.abort();
      release();
      await cancelling;
      const result = await running;
      assert.equal(result.isError, true, text(result));
      assert.doesNotMatch(text(result), /UNEXPECTED_SUCCESS/);
      assert.equal(closed.length, 1);
      assert.equal(requests.filter(([value]) => value === "Remember never-started").length, 0);
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      assertSessionTotals(parent, zero);
      assert.match(await runCode(parent, 'text("PARENT_STILL_USABLE");'), /PARENT_STILL_USABLE/);
    } finally {
      release();
    }
  });
});
