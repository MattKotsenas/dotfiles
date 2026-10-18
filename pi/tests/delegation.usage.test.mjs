import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { answer, fixture, invoke } from "./delegation/fixture.mjs";
import { network, usage } from "./delegation/usage-provider.mjs";

const providerModule = fileURLToPath(new URL("./delegation/usage-provider.mjs", import.meta.url));
const setup = (t) => fixture(t, { providerModule });
const text = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const outer = (parent) => parent.messages.findLast((message) => message.role === "toolResult" && message.toolName === "codemode");
const call = (args) => `await tools.delegate(${JSON.stringify(args)})`;
const start = { prompt: "Remember violet", tools: [] };

function charged(parent, units) {
  assert.deepEqual(outer(parent).usage, usage(units), "outer codemode must carry the complete native delegate usage");
}

function stats(parent, units) {
  // Read actual parent assistant messages so their model costs cannot masquerade as delegate usage.
  const assistants = parent.messages.filter((message) => message.role === "assistant");
  assert(assistants.length > 0);
  const expected = usage(units);
  for (const message of assistants) {
    if (message.stopReason === "toolUse" || message.stopReason === "stop") {
      assert.deepEqual(message.usage, usage(message.stopReason === "toolUse" ? 1 : 2));
    } else {
      assert.equal(message.stopReason, "error", "SDK may synthesize an unbilled assistant error after abort");
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) assert.equal(message.usage[key], 0);
      for (const value of Object.values(message.usage.cost)) assert.equal(value, 0);
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) expected[key] += message.usage[key];
    for (const key of Object.keys(expected.cost)) expected.cost[key] += message.usage.cost[key];
  }
  const actual = parent.getSessionStats();
  assert.deepEqual(actual.tokens, {
    input: expected.input, output: expected.output, cacheRead: expected.cacheRead,
    cacheWrite: expected.cacheWrite, total: expected.totalTokens,
  }, "session token stats must include delegated work exactly once");
  assert.equal(actual.cost, expected.cost.total, "session cost must include delegated work exactly once");
  assert.equal(parent.sessionManager.getEntries().filter((entry) => entry.type === "usage").length, 0,
    "delegate usage belongs on the outer tool result, without manual parent appendUsage");
}

async function script(parent, code) {
  const before = parent.messages.length;
  await parent.prompt(`ACCEPTANCE_CODE:${code}`);
  const result = parent.messages.slice(before).find((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert(result, "real codemode must produce a native result even on failure");
  return result;
}

async function rejected(parent, args, pattern) {
  const result = await script(parent, `${call(args)}; text("UNEXPECTED_SUCCESS");`);
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), pattern);
  assert.doesNotMatch(text(result), /UNEXPECTED_SUCCESS/);
  return result;
}

describe("delegation incremental usage", { concurrency: false }, () => {
  test("new tool-using child includes both responses; two continuations charge only new work and retain history", { timeout: 20000 }, async (t) => {
    const { parent, fileContents } = await setup(t);
    assert.equal(parent.messages.length, 0);
    const read = await invoke(parent, { prompt: "Read note.txt", tools: ["read"] });
    assert.equal(answer(read), fileContents);
    assert.deepEqual(read.usage, usage(8), "codemode callers receive native usage in the structured result");
    charged(parent, 8);
    stats(parent, 8);
    const first = await invoke(parent, start);
    assert.equal(answer(first), "REMEMBERED");
    assert.deepEqual(first.usage, usage(7));
    charged(parent, 7);
    for (const [prompt, units] of [["Recall", 11], ["Recall again", 13]]) {
      const next = await invoke(parent, { handle: first.details.handle, prompt });
      assert.equal(answer(next), "Remember violet");
      assert.equal(next.details.handle, first.details.handle);
      assert.deepEqual(next.usage, usage(units));
      charged(parent, units);
    }
    stats(parent, 39);
  });

  for (const throws of [false, true]) {
    test(`one codemode script aggregates multiple children once${throws ? " even when the script throws" : ""}`, { timeout: 20000 }, async (t) => {
      const { parent } = await setup(t);
      assert.equal(parent.messages.length, 0);
      const result = await script(parent, `${call(start)}; ${call({ prompt: "Read note.txt", tools: ["read"] })}; ${throws ? 'throw new Error("AFTER_DELEGATES");' : 'text("BOTH_DONE");'}`);
      assert.equal(Boolean(result.isError), throws, text(result));
      assert.match(text(result), throws ? /AFTER_DELEGATES/ : /BOTH_DONE/);
      charged(parent, 15);
      stats(parent, 15);
    });
  }

  for (const fails of [false, true]) {
    test(`a child counts its grandchild's usage once${fails ? " when the grandchild fails" : ""}`, { timeout: 20000 }, async (t) => {
      const { parent } = await setup(t);
      const innerResults = [];
      const record = (result) => innerResults.push(result);
      network.on("codemode-result", record);
      t.after(() => network.off("codemode-result", record));
      const grandchild = fails ? { prompt: "Fail after work", tools: ["read"] } : start;
      const result = await invoke(parent, {
        prompt: `ACCEPTANCE_CODE:const nested = ${call(grandchild)}; text(nested.content[0].text);`,
        tools: ["codemode", "delegate"],
      });
      assert.equal(innerResults.length, 2, "child and parent both execute codemode");
      assert.equal(Boolean(innerResults[0].isError), fails, text(innerResults[0]));
      const grandchildUnits = fails ? 36 : 7;
      assert.deepEqual(innerResults[0].usage, usage(grandchildUnits));
      assert.notEqual(innerResults[1].isError, true, text(innerResults[1]));
      assert.equal(answer(result), "PARENT_DONE");
      charged(parent, 3 + grandchildUnits); // Child's two model responses (1 + 2), plus the grandchild.
      stats(parent, 3 + grandchildUnits);
    });
  }

  test("partial provider error after tool work retains charges, rejects codemode, and invalidates the handle", { timeout: 20000 }, async (t) => {
    const { parent } = await setup(t);
    const first = await invoke(parent, { ...start, tools: ["read"] });
    charged(parent, 7);
    await rejected(parent, { handle: first.details.handle, prompt: "Fail after work" }, /Provider failed after billed work/);
    charged(parent, 36);
    stats(parent, 43);
    await rejected(parent, { handle: first.details.handle, prompt: "Recall" }, /Unknown delegation handle/);
    assert(outer(parent).usage === undefined || outer(parent).usage.totalTokens === 0);
    stats(parent, 43);
  });

  test("unknown handles, invalid follow-ups and unknown models do no work", { timeout: 20000 }, async (t) => {
    const { parent } = await setup(t);
    const first = await invoke(parent, start);
    for (const [args, pattern] of [
      [{ handle: "missing", prompt: "Recall" }, /Unknown delegation handle/],
      [{ handle: first.details.handle, prompt: "Recall", tools: [] }, /follow-up accepts only/],
      [{ prompt: "Remember violet", provider: "missing", model: "missing" }, /Unknown model/],
    ]) {
      await rejected(parent, args, pattern);
      assert(outer(parent).usage === undefined || outer(parent).usage.totalTokens === 0);
      stats(parent, 7);
    }
    assert.equal(answer(await invoke(parent, { handle: first.details.handle, prompt: "Recall" })), "Remember violet");
    charged(parent, 11);
    stats(parent, 18);
  });

  test("cancellation carries reported partial usage once and invalidates the child", { timeout: 20000 }, async (t) => {
    const { parent } = await setup(t);
    const first = await invoke(parent, start);
    const waiting = new AbortController();
    t.after(() => waiting.abort());
    const pending = once(network, "pending", { signal: waiting.signal });
    const running = script(parent, `${call({ handle: first.details.handle, prompt: "Wait for network" })}; text("UNEXPECTED_SUCCESS");`);
    const stage = await Promise.race([pending.then(([request]) => ({ request })), running.then((result) => ({ result }))]);
    assert(stage.request, `provider gate must precede completion: ${stage.result && text(stage.result)}`);
    assert.deepEqual(stage.request.usage, usage(23), "the provider has reported billed partial work before abort");
    await parent.abort();
    const result = await running;
    assert.equal(result.isError, true, text(result));
    charged(parent, 23);
    stats(parent, 30);
    await rejected(parent, { handle: first.details.handle, prompt: "Recall" }, /Unknown delegation handle/);
    assert(outer(parent).usage === undefined || outer(parent).usage.totalTokens === 0);
    stats(parent, 30);
  });

});
