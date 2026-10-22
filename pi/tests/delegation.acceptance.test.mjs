import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { answer, fixture, invoke, providerId, runCode } from "./delegation/fixture.mjs";

// Serial cases own and restore the agent-directory environment in this isolated test process.
describe("delegation acceptance", { concurrency: false }, () => {
  test("setup control: discovered provider and real codemode work without delegation", {
    timeout: 15000,
  }, async (t) => {
    const { parent } = await fixture(t);
    assert.match(await runCode(parent, 'text("HARNESS_READY");'), /HARNESS_READY/);
  });

  test("D1: start a tool-using child and receive its answer and follow-up handle", { timeout: 15000 }, async (t) => {
    const { parent, fileContents } = await fixture(t);
    const result = await invoke(parent, {
      prompt: "Read note.txt and return its exact contents.",
      systemPrompt: { replace: "Prefix file contents with CHILD:" },
      tools: ["read"],
    });
    assert.equal(answer(result), `CHILD:${fileContents}`);
  });

  test("D2: each follow-up handle continues its own child conversation", { timeout: 15000 }, async (t) => {
    const { parent } = await fixture(t);
    const words = [randomUUID(), randomUUID()];
    const children = [];
    for (const word of words) {
      const result = await invoke(parent, {
        prompt: `Remember this word: ${word}`,
        systemPrompt: { replace: "Prefix recalled words with MEMORY:" },
        tools: [],
      });
      assert.equal(answer(result), "REMEMBERED");
      children.push(result.details.handle);
    }
    for (const [index, handle] of children.entries()) {
      const result = await invoke(parent, { handle, prompt: "What word did I ask you to remember?" });
      assert.equal(answer(result), `MEMORY:${words[index]}`);
    }
  });

  test("D3: continuing a child uses the parent's changed temporary auth and retains its conversation", {
    timeout: 15000,
  }, async (t) => {
    const { parent, modelRuntime, authPath, expectedKeyPath } = await fixture(t);
    const word = randomUUID();
    const originalAuthFile = await readFile(authPath, "utf8");
    const first = await invoke(parent, {
      prompt: `Remember this word: ${word}`,
      systemPrompt: { replace: "Prefix recalled words with MEMORY:" },
      tools: [],
    });
    assert.equal(answer(first), "REMEMBERED");
    const changedKey = `synthetic-changed-${randomUUID()}`;
    await modelRuntime.setRuntimeApiKey(providerId, changedKey);
    // The fake service now rejects the old credential, including requests from an existing child.
    await writeFile(expectedKeyPath, changedKey);
    const result = await invoke(parent, {
      handle: first.details.handle,
      prompt: "What word did I ask you to remember?",
    });
    assert.equal(answer(result), `MEMORY:${word}`);
    assert.equal(
      await readFile(authPath, "utf8"),
      originalAuthFile,
      "temporary credentials must not replace saved auth",
    );
  });
});
