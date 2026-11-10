import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { answer, fixture, invoke, runCode } from "./delegation/fixture.mjs";
import { lifecycle } from "./delegation/lifecycle-extension.mjs";
import { network } from "./delegation/usage-provider.mjs";

const extension = new URL("./delegation/lifecycle-extension.mjs", import.meta.url).href;
const providerModule = fileURLToPath(new URL("./delegation/usage-provider.mjs", import.meta.url));

async function installLifecycle(t, authPath) {
  await writeFile(
    join(dirname(authPath), "extensions/lifecycle.ts"),
    `export { default } from ${JSON.stringify(extension)};\n`,
  );
  let closed = 0;
  const collect = () => closed++;
  lifecycle.on("closed", collect);
  t.after(() => lifecycle.off("closed", collect));
  return () => closed;
}

const listing = async (parent) => {
  const output = await runCode(parent, 'text("CHILDREN:" + JSON.stringify(await tools.delegates({})));');
  return JSON.parse(output.match(/^CHILDREN:(.+)$/m)[1]).details.children;
};

describe("delegate dehydration", { concurrency: false }, () => {
  for (const persisted of [false, true]) {
    test(`completed calls close the runtime and restore the conversation, persisted=${persisted}`, async (t) => {
      const { parent, authPath } = await fixture(t, { persisted });
      const closed = await installLifecycle(t, authPath);
      assert.equal(closed(), 0);
      const first = await invoke(parent, {
        prompt: "Remember this word: violet",
        tools: [],
        systemPrompt: { replace: "Prefix recalled words with MEMORY:" },
      });
      assert.equal(answer(first), "REMEMBERED");
      assert.equal(closed(), 1, "the runtime must begin shutdown");
      assert.equal((await listing(parent))[0].status, "completed");
      for (let turn = 0; turn < 2; turn++) {
        const recalled = await invoke(parent, {
          handle: first.details.handle,
          prompt: "What word did I ask you to remember?",
        });
        assert.equal(answer(recalled), "MEMORY:violet");
        assert.equal(closed(), turn + 2, "each follow-up must release its own runtime");
      }
      await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.equal(closed(), 3, "parent shutdown must not close already dehydrated children again");
    });
  }

  test("in-memory grandchildren survive their parent's dehydration", async (t) => {
    const { parent } = await fixture(t, { providerModule });
    const initial = await invoke(parent, {
      prompt: 'ACCEPTANCE_CODE:await tools.delegate({ prompt: "Remember violet", tools: [] });',
      tools: ["codemode", "delegate", "delegates"],
    });
    const inner = [];
    const collect = (result) => inner.push(result);
    network.on("codemode-result", collect);
    t.after(() => network.off("codemode-result", collect));
    for (let turn = 0; turn < 2; turn++) {
      inner.length = 0;
      await invoke(parent, {
        handle: initial.details.handle,
        prompt:
          'ACCEPTANCE_CODE:const [child] = (await tools.delegates({})).details.children; text((await tools.delegate({ handle: child.handle, prompt: "History" })).content[0].text);',
      });
      assert.equal(inner.length, 2);
      assert.notEqual(inner[0].isError, true);
      assert.match(inner[0].content.map((block) => block.text).join("\n"), /Remember violet/);
    }
  });

  test("cancellation during background cleanup preserves the completed checkpoint", async (t) => {
    const { parent, authPath } = await fixture(t);
    await writeFile(
      join(dirname(authPath), "extensions/cancel-dehydration.ts"),
      `import { lifecycle } from ${JSON.stringify(extension)};
       export default function(pi) { pi.on("session_shutdown", () => { lifecycle.emit("dehydrating"); }); }`,
    );
    const ended = Promise.withResolvers();
    const unsubscribe = parent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "delegate") ended.resolve();
    });
    t.after(unsubscribe);
    const stop = () => {
      void parent.abort();
    };
    lifecycle.once("dehydrating", stop);
    t.after(() => lifecycle.off("dehydrating", stop));
    await parent.prompt('ACCEPTANCE_CODE:await tools.delegate({ prompt: "Remember this word: violet", tools: [] });');
    await ended.promise;
    assert.equal((await listing(parent))[0].status, "completed");
  });

  test("failed calls close the runtime without losing the handle or conversation", async (t) => {
    const { parent, authPath } = await fixture(t, { persisted: true });
    const closed = await installLifecycle(t, authPath);
    const first = await invoke(parent, {
      prompt: "Remember this word: amber",
      tools: [],
      systemPrompt: { replace: "Prefix recalled words with MEMORY:" },
    });
    assert.equal(closed(), 1);
    await assert.rejects(
      invoke(parent, { handle: first.details.handle, prompt: "Unexpected failing prompt" }),
      /Unexpected test prompt/,
    );
    assert.equal(closed(), 2);
    assert.equal((await listing(parent))[0].status, "failed");
    const recalled = await invoke(parent, {
      handle: first.details.handle,
      prompt: "What word did I ask you to remember?",
    });
    assert.equal(answer(recalled), "MEMORY:amber");
    assert.equal(closed(), 3);
  });

  for (const [boundary, mode] of [
    ["follow-up", "tui"],
    ["follow-up", "rpc"],
    ["follow-up", "json"],
    ["parent shutdown", "print"],
    ["follow-up", "unavailable-ui"],
  ]) {
    test(`cleanup failure warns immediately in ${mode}, remains pending at ${boundary}, and resumes`, async (t) => {
      const { parent, authPath } = await fixture(t, { persisted: true });
      const notifications = [];
      const diagnostics = [];
      const warned = Promise.withResolvers();
      parent.extensionRunner.setUIContext(
        mode === "print" || mode === "json"
          ? undefined
          : {
              ...parent.extensionRunner.getUIContext(),
              notify(message, type) {
                notifications.push([message, type]);
                if (mode === "unavailable-ui") throw new Error("UI_UNAVAILABLE");
                warned.resolve(message);
              },
            },
        mode === "unavailable-ui" ? "tui" : mode,
      );
      t.mock.method(console, "error", (...args) => {
        diagnostics.push(args);
        warned.resolve(args[0]);
      });
      assert.deepEqual(notifications, []);
      assert.deepEqual(diagnostics, []);
      const path = join(dirname(authPath), "extensions/failing-shutdown.ts");
      await writeFile(
        path,
        'export default function(pi) { pi.on("session_shutdown", () => { throw new Error("DEHYDRATION_FAILED"); }); }',
      );
      const first = await invoke(parent, { prompt: "Remember this word: violet", tools: [] });
      assert.equal(answer(first), "REMEMBERED");
      let timer;
      t.after(() => clearTimeout(timer));
      const message = await Promise.race([
        warned.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("No immediate cleanup warning")), 2000);
        }),
      ]);
      assert.equal(
        message,
        `Delegate ${first.details.handle} cleanup failed: Child shutdown failed: DEHYDRATION_FAILED`,
      );
      const headless = mode === "print" || mode === "json";
      assert.deepEqual(notifications, headless ? [] : [[message, "warning"]]);
      assert.equal(diagnostics.length, headless || mode === "unavailable-ui" ? 1 : 0);
      if (mode === "unavailable-ui") assert.equal(diagnostics[0][1].message, "UI_UNAVAILABLE");
      assert.equal((await listing(parent))[0].status, "completed");
      await rm(path);
      if (boundary === "follow-up") {
        await assert.rejects(
          invoke(parent, { handle: first.details.handle, prompt: "Remember this word: forbidden" }),
          (error) => {
            assert(
              error.message.includes(
                `Delegate ${first.details.handle}: cleanup from the previous turn failed: Child shutdown failed: DEHYDRATION_FAILED`,
              ),
            );
            assert.match(error.message, /This prompt was not processed\. The previous turn's result is unchanged\./);
            assert.match(
              error.message,
              /Inspect the cause before deciding whether to retry this prompt with the same handle\./,
            );
            return true;
          },
        );
      } else {
        await assert.rejects(parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }), (error) => {
          assert.match(error.message, /DEHYDRATION_FAILED/);
          assert.equal(error.message.includes("This prompt was not processed"), false);
          return true;
        });
        await parent.reload();
      }
      const resumed = await invoke(parent, { handle: first.details.handle, prompt: "Remember this word: recovered" });
      assert.equal(answer(resumed), "REMEMBERED");
    });
  }
});
