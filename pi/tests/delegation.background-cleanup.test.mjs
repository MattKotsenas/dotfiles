import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { answer, fixture, invoke, runCode } from "./delegation/fixture.mjs";
import { lifecycle } from "./delegation/lifecycle-extension.mjs";
import { network } from "./delegation/usage-provider.mjs";

const providerModule = fileURLToPath(new URL("./delegation/usage-provider.mjs", import.meta.url));

async function holdCleanup(parent, authPath, fail = false) {
  const path = join(dirname(authPath), "extensions/held-shutdown.ts");
  await writeFile(
    path,
    `
    import { lifecycle } from ${JSON.stringify(new URL("./delegation/lifecycle-extension.mjs", import.meta.url).href)};
    export default function(pi) { pi.on("session_shutdown", async () => {
      await new Promise(resolve => lifecycle.emit("shutdown-held", resolve));
      pi.appendEntry("shutdown-finished", {});
      ${fail ? 'throw new Error("HELD_CLEANUP_FAILED");' : ""}
    }); }
  `,
  );
  const entered = once(lifecycle, "shutdown-held");
  const running = invoke(parent, { prompt: "Remember violet", tools: [] });
  const [release] = await entered;
  // Later runtimes must not inherit the gate; the first runtime already holds its callback.
  await rm(path);
  return { running, release };
}

async function withoutCleanup(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("The result waited for the held cleanup")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("background delegate cleanup", { concurrency: false }, () => {
  test("returns before cleanup, queues its follow-up, and admits another delegate", { timeout: 15000 }, async (t) => {
    const { parent, authPath } = await fixture(t, { providerModule });
    const { running, release } = await holdCleanup(parent, authPath);
    let continued;
    try {
      const first = await withoutCleanup(running);
      assert.equal(answer(first), "REMEMBERED");
      const requests = [];
      const collect = (prompt) => requests.push(prompt);
      network.on("request", collect);
      t.after(() => network.off("request", collect));
      const other = Promise.withResolvers();
      const unsubscribe = parent.subscribe((event) => {
        if (
          event.type === "tool_execution_end" &&
          event.toolName === "delegate" &&
          event.result?.details?.handle !== first.details.handle
        )
          other.resolve(event.result);
      });
      t.after(unsubscribe);
      continued = runCode(
        parent,
        `
        const waiting = Promise.allSettled([
          tools.delegate({ handle: ${JSON.stringify(first.details.handle)}, prompt: "History" }),
          tools.delegate({ handle: ${JSON.stringify(first.details.handle)}, prompt: "History" }),
        ]);
        await tools.delegate({ prompt: "Remember amber", tools: [] });
        text(JSON.stringify((await waiting).map(result => ({ status: result.status, answer: result.value?.content[0].text }))));
      `,
      );
      assert.equal(answer(await withoutCleanup(other.promise)), "REMEMBERED");
      assert(requests.includes("Remember amber"));
      assert.equal(requests.includes("History"), false, "same-handle work must wait for cleanup");
      release();
      const output = await continued;
      assert.match(output, /Remember violet/);
      assert.equal([...output.matchAll(/"status":"fulfilled"/g)].length, 1);
      assert.equal(
        [...output.matchAll(/"status":"rejected"/g)].length,
        1,
        "queued callers must not race into one conversation",
      );
    } finally {
      release();
      await running;
      await continued;
    }
  });

  for (const fail of [false, true]) {
    test(`cancelled cleanup waiter starts no work and preserves deferred failure=${fail}`, {
      timeout: 15000,
    }, async (t) => {
      const { parent, authPath } = await fixture(t, { providerModule });
      const { running, release } = await holdCleanup(parent, authPath, fail);
      let following;
      try {
        const first = await withoutCleanup(running);
        const started = Promise.withResolvers();
        const ended = Promise.withResolvers();
        let id;
        const unsubscribe = parent.subscribe((event) => {
          if (event.type === "tool_execution_start" && event.toolName === "delegate") {
            id = event.toolCallId;
            started.resolve();
          }
          if (event.type === "tool_execution_end" && event.toolCallId === id) ended.resolve();
        });
        t.after(unsubscribe);
        const requests = [];
        const collect = (prompt) => requests.push(prompt);
        network.on("request", collect);
        t.after(() => network.off("request", collect));
        following = parent.prompt(
          `ACCEPTANCE_CODE:await tools.delegate({ handle: ${JSON.stringify(first.details.handle)}, prompt: "History" });`,
        );
        await withoutCleanup(started.promise);
        // The start event precedes execute; let admission reach the cleanup wait.
        await nextTick();
        assert.equal(requests.includes("History"), false);
        await parent.abort();
        await following;
        release();
        await withoutCleanup(ended.promise);
        assert.equal(requests.includes("History"), false, "cancelled waiter must not resurrect the runtime");
        if (fail) {
          await assert.rejects(
            invoke(parent, { handle: first.details.handle, prompt: "History" }),
            /HELD_CLEANUP_FAILED/,
          );
          assert.equal(requests.includes("History"), false, "reporting cleanup failure must start no work");
          assert.equal(
            answer(await invoke(parent, { handle: first.details.handle, prompt: "History" })),
            "Remember violet",
          );
        }
      } finally {
        release();
        await running;
        await following;
      }
    });
  }

  test("parent shutdown waits for cleanup without changing a completed turn", { timeout: 15000 }, async (t) => {
    const { parent, authPath } = await fixture(t, { providerModule, persisted: true });
    const { running, release } = await holdCleanup(parent, authPath);
    let shutdown;
    try {
      const first = await withoutCleanup(running);
      let settled = false;
      shutdown = parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).then(() => {
        settled = true;
      });
      await nextTick();
      assert.equal(settled, false, "shutdown must retain ownership of the pending cleanup");
      release();
      await shutdown;
      const record = parent.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "delegation.child.v1")
        .at(-1).data;
      assert.equal(record.handle, first.details.handle);
      assert.equal(record.status, "completed");
      const ledger = (await readFile(record.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(ledger.at(-1).customType, "shutdown-finished");
      assert.equal(record.leafId, ledger.at(-1).id, "checkpoint must include shutdown entries");
    } finally {
      release();
      await running;
      await shutdown;
    }
  });
});
