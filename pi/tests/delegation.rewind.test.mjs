import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { setImmediate as nextTick } from "node:timers/promises";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import { answer, fixture, invoke, runCode } from "./delegation/fixture.mjs";
import { network, usage } from "./delegation/usage-provider.mjs";
import { lifecycle } from "./delegation/lifecycle-extension.mjs";

const providerModule = fileURLToPath(new URL("./delegation/usage-provider.mjs", import.meta.url));
const worker = fileURLToPath(new URL("./delegation/resume-parent.mjs", import.meta.url));
const listing = async (parent) => {
  const output = await runCode(parent, 'text("CHILDREN:" + JSON.stringify(await tools.delegates({})));');
  return JSON.parse(output.match(/^CHILDREN:(.+)$/m)[1]).details.children;
};
const checkpoints = (parent) =>
  parent.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "delegation.child.v1");

async function navigate(parent, target) {
  const result = await parent.navigateTree(target);
  assert.equal(result.cancelled, false);
}

describe("delegation parent rewind", { concurrency: false }, () => {
  test("selects child history from the parent branch and never recharges abandoned work, including after reload", {
    timeout: 30000,
  }, async (t) => {
    const { parent, authPath } = await fixture(t, { providerModule, persisted: true });
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    const handle = first.details.handle;
    const earlier = parent.sessionManager.getLeafId();
    assert.deepEqual(first.usage, usage(7));
    await invoke(parent, { handle, prompt: "Remember amber" });
    assert.equal(answer(await invoke(parent, { handle, prompt: "History" })), "Remember violet; Remember amber");
    const later = parent.sessionManager.getLeafId();
    const requests = [];
    const collect = (prompt) => requests.push(prompt);
    network.on("request", collect);
    t.after(() => network.off("request", collect));
    await navigate(parent, earlier);
    assert.deepEqual(requests, [], "navigation must not call a provider or replay work");
    const recalled = await invoke(parent, { handle, prompt: "History" });
    assert.equal(answer(recalled), "Remember violet");
    assert.deepEqual(recalled.usage, usage(11), "the later branch was already billed in the full parent ledger");
    await invoke(parent, { handle, prompt: "Remember jade" });
    const alternate = parent.sessionManager.getLeafId();
    await navigate(parent, later);
    await parent.reload();
    const restored = await invoke(parent, { handle, prompt: "History" });
    assert.equal(answer(restored), "Remember violet; Remember amber");
    assert.deepEqual(restored.usage, usage(11));
    await navigate(parent, alternate);
    assert.equal(answer(await invoke(parent, { handle, prompt: "History" })), "Remember violet; Remember jade");
    await navigate(parent, earlier);
    assert.equal((await listing(parent))[0].handle, handle);
    await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        worker,
        parent.sessionManager.getSessionFile(),
        parent.sessionManager.getCwd(),
        dirname(authPath),
        JSON.stringify({ handle, prompt: "History" }),
      ],
      { env: process.env, timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    const resumed = JSON.parse(stdout.match(/^RESUMED:(.+)$/m)[1]);
    assert.equal(answer(resumed.result), "Remember violet", "fresh-process resume must use the selected checkpoint");
    assert.deepEqual(resumed.result.usage, usage(11), "cross-branch charges must stay reported after process resume");
  });

  test("rewinding also restores a retained grandchild and counts only its new work", { timeout: 20000 }, async (t) => {
    const { parent } = await fixture(t, { providerModule, persisted: true });
    const initial = await invoke(parent, {
      prompt: 'ACCEPTANCE_CODE:await tools.delegate({ prompt: "Remember violet", tools: [] });',
      tools: ["codemode", "delegate", "delegates"],
    });
    assert.deepEqual(initial.usage, usage(10));
    const earlier = parent.sessionManager.getLeafId();
    const inner = [];
    const collect = (result) => inner.push(result);
    network.on("codemode-result", collect);
    t.after(() => network.off("codemode-result", collect));
    const nested = async (prompt) => {
      inner.length = 0;
      const code = `const [child] = (await tools.delegates({})).details.children; text((await tools.delegate({handle: child.handle, prompt: ${JSON.stringify(prompt)}})).content[0].text);`;
      const result = await invoke(parent, { handle: initial.details.handle, prompt: `ACCEPTANCE_CODE:${code}` });
      assert.equal(inner.length, 2, "both child and parent must execute codemode");
      assert.notEqual(inner[0].isError, true);
      assert.deepEqual(result.usage, usage(prompt === "History" ? 14 : 10));
      return inner[0].content.map((block) => block.text).join("\n");
    };
    await nested("Remember amber");
    assert.match(await nested("History"), /Remember violet; Remember amber/);
    const later = parent.sessionManager.getLeafId();
    await navigate(parent, earlier);
    const past = await nested("History");
    assert.match(past, /Remember violet/);
    assert.doesNotMatch(past, /amber/);
    await navigate(parent, later);
    assert.match(await nested("History"), /Remember violet; Remember amber/);
  });

  test("children created after the target disappear and reappear only on their own branch", {
    timeout: 20000,
  }, async (t) => {
    const { parent } = await fixture(t, { providerModule, persisted: true });
    assert.deepEqual(await listing(parent), []);
    const before = parent.sessionManager.getLeafId();
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    const after = parent.sessionManager.getLeafId();
    assert.equal((await listing(parent))[0].handle, first.details.handle);
    await navigate(parent, before);
    assert.deepEqual(await listing(parent), []);
    const denied = await runCode(
      parent,
      `try { await tools.delegate(${JSON.stringify({ handle: first.details.handle, prompt: "History" })}); } catch (error) { text(error.message); }`,
    );
    assert.match(denied, /Unknown delegation handle/);
    await navigate(parent, after);
    assert.equal((await listing(parent))[0].handle, first.details.handle);
    const result = await invoke(parent, { handle: first.details.handle, prompt: "History" });
    assert.equal(answer(result), "Remember violet");
    assert.deepEqual(result.usage, usage(11));
  });

  test("a running checkpoint with a null child leaf restores an empty history without replay", {
    timeout: 20000,
  }, async (t) => {
    const { parent } = await fixture(t, { providerModule, persisted: true });
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    const initial = checkpoints(parent)[0];
    assert.equal(initial.data.leafId, null);
    assert.equal(initial.data.status, "running");
    const complete = parent.sessionManager.getLeafId();
    await navigate(parent, initial.id);
    assert.equal((await listing(parent))[0].status, "interrupted");
    const empty = await invoke(parent, { handle: first.details.handle, prompt: "History" });
    assert.equal(answer(empty), "HISTORY_MISSING");
    assert.deepEqual(empty.usage, usage(11));
    await navigate(parent, complete);
    assert.equal(answer(await invoke(parent, { handle: first.details.handle, prompt: "History" })), "Remember violet");
  });

  test("navigation canceled by another extension leaves child history and handles intact", {
    timeout: 20000,
  }, async (t) => {
    const { parent, authPath } = await fixture(t, { providerModule, persisted: true });
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    const target = parent.sessionManager.getLeafId();
    await invoke(parent, { handle: first.details.handle, prompt: "Remember amber" });
    await writeFile(
      join(dirname(authPath), "extensions/cancel-tree.ts"),
      `export default function(pi) { pi.on("session_before_tree", () => ({ cancel: true })); }`,
    );
    await parent.reload();
    const leaf = parent.sessionManager.getLeafId();
    assert.notEqual(target, leaf);
    assert.equal((await parent.navigateTree(target)).cancelled, true);
    assert.equal(parent.sessionManager.getLeafId(), leaf);
    assert.equal(
      answer(await invoke(parent, { handle: first.details.handle, prompt: "History" })),
      "Remember violet; Remember amber",
    );
  });

  test("canceled navigation preserves delegation for a custom-message-triggered turn", {
    timeout: 20000,
  }, async (t) => {
    const { parent, authPath } = await fixture(t, { providerModule, persisted: true });
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    const target = parent.sessionManager.getLeafId();
    await invoke(parent, { handle: first.details.handle, prompt: "Remember amber" });
    await writeFile(
      join(dirname(authPath), "extensions/cancel-tree.ts"),
      `export default function(pi) { pi.on("session_before_tree", () => ({ cancel: true })); }`,
    );
    await parent.reload();
    assert.equal((await parent.navigateTree(target)).cancelled, true);
    assert.equal(parent.isIdle, true, "navigation must have finished before the custom turn starts");
    const before = parent.messages.length;
    await parent.sendCustomMessage(
      {
        customType: "rewind-probe",
        display: false,
        content: `ACCEPTANCE_CODE:const result = await tools.delegate(${JSON.stringify({ handle: first.details.handle, prompt: "History" })}); text(result.content[0].text);`,
      },
      { triggerTurn: true },
    );
    const result = parent.messages
      .slice(before)
      .find((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert(result, "the custom turn must execute real codemode");
    assert.notEqual(result.isError, true, result.content.map((block) => block.text).join("\n"));
    assert.match(result.content.map((block) => block.text).join("\n"), /Remember violet; Remember amber/);
  });

  test("reload waits for every child cleanup before reporting a sibling shutdown failure", {
    timeout: 20000,
  }, async (t) => {
    const { parent, authPath } = await fixture(t, { providerModule, persisted: true });
    const extension = join(dirname(authPath), "extensions/child-shutdown.ts");
    await writeFile(
      extension,
      `
      import { lifecycle } from ${JSON.stringify(new URL("./delegation/lifecycle-extension.mjs", import.meta.url).href)};
      export default function(pi) { pi.on("session_shutdown", async (_event, ctx) => {
        if (ctx.getSystemPrompt().includes("FAIL_SHUTDOWN")) throw new Error("FAST_SHUTDOWN_FAILURE");
        await new Promise(resolve => lifecycle.emit("slow-close-entered", resolve));
        lifecycle.emit("slow-close-finished");
      }); }
    `,
    );
    await invoke(parent, { prompt: "Remember violet", tools: [], systemPrompt: { replace: "FAIL_SHUTDOWN" } });
    await invoke(parent, { prompt: "Remember amber", tools: [], systemPrompt: { replace: "SLOW_SHUTDOWN" } });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const entered = once(lifecycle, "slow-close-entered", { signal: controller.signal });
    let finished = false;
    const markFinished = () => {
      finished = true;
    };
    lifecycle.on("slow-close-finished", markFinished);
    t.after(() => lifecycle.off("slow-close-finished", markFinished));
    let settled = false;
    const reloading = parent.reload().then(
      () => {
        settled = true;
        return null;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    const [release] = await entered;
    let error;
    try {
      assert.equal(finished, false);
      await nextTick();
      assert.equal(settled, false, "reload must still own the blocked sibling cleanup after another child fails");
    } finally {
      release();
      error = await reloading;
      await rm(extension);
    }
    assert(error instanceof Error);
    assert.match(error.message, /FAST_SHUTDOWN_FAILURE/);
    assert.equal(finished, true, "every child cleanup must finish before reload reports failure");
  });

  test("a child shutdown failure blocks branch restoration and new work", { timeout: 20000 }, async (t) => {
    const { parent, authPath } = await fixture(t, { providerModule, persisted: true });
    await listing(parent);
    const target = parent.sessionManager.getLeafId();
    await writeFile(
      join(dirname(authPath), "extensions/failing-shutdown.ts"),
      `export default function(pi) { pi.on("session_shutdown", () => { throw new Error("SHUTDOWN_FAILED"); }); }`,
    );
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    assert.equal((await listing(parent))[0].handle, first.details.handle);
    await assert.rejects(parent.navigateTree(target), /SHUTDOWN_FAILED/);
    assert.equal(parent.sessionManager.getLeafId(), target, "Pi has already switched branches when teardown fails");
    const requests = [];
    const collect = (prompt) => {
      if (!prompt.startsWith("ACCEPTANCE_CODE:")) requests.push(prompt);
    };
    network.on("request", collect);
    t.after(() => network.off("request", collect));
    for (const code of [
      "await tools.delegates({});",
      'await tools.delegate({ prompt: "Remember forbidden", tools: [] });',
    ]) {
      const output = await runCode(
        parent,
        `try { ${code} text("UNEXPECTED_SUCCESS"); } catch(error) { text(error.message); }`,
      );
      assert.match(output, /restoring parent branch state/);
      assert.doesNotMatch(output, /UNEXPECTED_SUCCESS/);
    }
    assert.deepEqual(requests, [], "failed teardown must not admit a replacement runtime");
    await rm(join(dirname(authPath), "extensions/failing-shutdown.ts"));
    await parent.reload();
    assert.deepEqual(await listing(parent), [], "reload must recover without reusing the disposed child");
  });

  test("completed navigation invalidates ephemeral children and reload cannot recover them", {
    timeout: 20000,
  }, async (t) => {
    const { parent } = await fixture(t, { providerModule });
    await listing(parent);
    const before = parent.sessionManager.getLeafId();
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    const after = parent.sessionManager.getLeafId();
    assert.equal((await listing(parent)).length, 1);
    await navigate(parent, before);
    assert.deepEqual(await listing(parent), []);
    await navigate(parent, after);
    assert.deepEqual(await listing(parent), []);
    const output = await runCode(
      parent,
      `try { await tools.delegate(${JSON.stringify({ handle: first.details.handle, prompt: "History" })}); } catch (error) { text(error.message); }`,
    );
    assert.match(output, /Unknown delegation handle/);
    await parent.reload();
    assert.deepEqual(await listing(parent), []);
  });
});
