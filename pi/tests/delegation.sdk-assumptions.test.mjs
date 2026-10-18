import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { fixture } from "./delegation/fixture.mjs";

// The scripted provider relies on Pi's public transcript replay helpers. If SDK upgrades
// change the instructions/tools it receives, fix the fake edge rather than weakening D1-D3.
describe("SDK assumptions used by the acceptance provider", { concurrency: false }, () => {
  test("SDK1: configured instructions and a real read reach the scripted model", { timeout: 15000 }, async (t) => {
    const { parent: session, fileContents } = await fixture(t, {
      systemPrompt: "Prefix file contents with CHILD:", tools: ["read"],
    });
    assert(session.systemPrompt.includes("Prefix file contents with CHILD:"));
    assert.deepEqual(session.getActiveToolNames(), ["read"]);
    await session.prompt("Read note.txt and return its exact contents.");
    assert.equal(session.getLastAssistantText(), `CHILD:${fileContents}`);
  });

  test("SDK2: replayed prompt/tools and supplied history determine recall, including negative cases", { timeout: 15000 }, async (t) => {
    const { parent: session, modelRuntime } = await fixture(t);
    const word = randomUUID();
    const remember = { role: "user", content: `Remember this word: ${word}`, timestamp: Date.now() };
    const recall = { role: "user", content: "What word did I ask you to remember?", timestamp: Date.now() };
    const systemPrompt = "Prefix recalled words with MEMORY:";
    const read = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
    const cases = [
      { systemPrompt, tools: [], messages: [remember, recall], expected: `MEMORY:${word}` },
      { systemPrompt: "WRONG CONFIGURATION", tools: [], messages: [remember, recall], expected: "CHILD_SYSTEM_PROMPT_MISSING" },
      { systemPrompt, tools: [read], messages: [remember, recall], expected: "UNEXPECTED_CHILD_TOOLS" },
      { systemPrompt, tools: [], messages: [recall], expected: "MEMORY:MEMORY_MISSING" },
    ];
    for (const { expected, ...context } of cases) {
      const result = await modelRuntime.completeSimple(session.model, context);
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), expected);
    }
  });
});
