import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { answer, fixture, invoke, runCode } from "./delegation/fixture.mjs";
import { ai } from "./delegation/sdk.mjs";
import { network } from "./delegation/usage-provider.mjs";

const providerModule = fileURLToPath(new URL("./delegation/usage-provider.mjs", import.meta.url));

const childPrompts = (t) => {
  const prompts = [];
  const collect = (prompt, _config, context) => {
    if (!prompt.startsWith("ACCEPTANCE_CODE:")) prompts.push(ai.getCurrentSystemPrompt(context.messages));
  };
  network.on("request", collect);
  t.after(() => network.off("request", collect));
  return prompts;
};

describe("delegation system prompts", { concurrency: false }, () => {
  for (const mode of ["discovered", "append", "replace"]) {
    test(`${mode} composes instructions and survives reload`, { timeout: 20000 }, async (t) => {
      const { parent, authPath } = await fixture(t, { providerModule, persisted: true });
      const agentDir = dirname(authPath);
      const cwd = parent.sessionManager.getCwd();
      await writeFile(join(agentDir, "SYSTEM.md"), "DISCOVERED_BASE");
      await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "DISCOVERED_ADDENDUM");
      await writeFile(join(cwd, "AGENTS.md"), "PROJECT_INSTRUCTIONS");
      const prompts = childPrompts(t);
      const first = await invoke(parent, {
        prompt: "Remember violet",
        tools: [],
        ...(mode === "discovered" ? {} : { systemPrompt: { [mode]: "CALLER_INSTRUCTIONS" } }),
      });
      assert.equal(answer(first), "REMEMBERED");
      assert.equal(prompts.length, 1);
      const discovered = await invoke(parent, { prompt: "Remember control", tools: [] });
      assert.equal(answer(discovered), "REMEMBERED");
      assert(prompts[1].includes("DISCOVERED_BASE"), "control: discovery supplies the base prompt");
      await parent.reload();
      assert.equal(answer(await invoke(parent, { handle: first.details.handle, prompt: "Recall" })), "Remember violet");
      assert.equal(prompts.length, 3);
      for (const prompt of [prompts[0], prompts[2]]) {
        assert.equal(prompt.includes("DISCOVERED_BASE"), mode !== "replace");
        assert.equal(prompt.includes("CALLER_INSTRUCTIONS"), mode !== "discovered");
        assert(prompt.includes("DISCOVERED_ADDENDUM"), "native addenda remain in every mode");
        assert(prompt.includes("PROJECT_INSTRUCTIONS"), "project instructions remain in every mode");
        if (mode === "append") assert(prompt.indexOf("DISCOVERED_ADDENDUM") < prompt.indexOf("CALLER_INSTRUCTIONS"));
      }
    });
  }

  for (const mode of ["append", "replace"]) {
    test(`${mode} treats existing file paths as literal text`, { timeout: 20000 }, async (t) => {
      const { parent } = await fixture(t, { providerModule });
      const path = join(parent.sessionManager.getCwd(), "instruction.txt");
      await writeFile(path, "FILE_CONTENT_MUST_NOT_REPLACE_TEXT");
      const prompts = childPrompts(t);
      await invoke(parent, { prompt: "Remember violet", tools: [], systemPrompt: { [mode]: path } });
      assert.equal(prompts.length, 1);
      assert(prompts[0].includes(path));
      assert(!prompts[0].includes("FILE_CONTENT_MUST_NOT_REPLACE_TEXT"));
    });
  }

  test("append preserves default Pi instructions and trusted project addenda", { timeout: 20000 }, async (t) => {
    const { parent } = await fixture(t, { providerModule });
    const cwd = parent.sessionManager.getCwd();
    parent.settingsManager.setProjectTrusted(true);
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/APPEND_SYSTEM.md"), "PROJECT_ADDENDUM");
    const prompts = childPrompts(t);
    await invoke(parent, { prompt: "Remember violet", tools: [] });
    assert(prompts[0].includes("You are an expert coding assistant"));
    await invoke(parent, { prompt: "Remember amber", tools: [], systemPrompt: { append: "REVIEWER_ROLE" } });
    assert.equal(prompts.length, 2);
    assert(prompts[1].includes("You are an expert coding assistant"));
    assert(prompts[1].includes("PROJECT_ADDENDUM"));
    assert(prompts[1].includes("REVIEWER_ROLE"));
  });

  test("invalid prompt shapes are rejected before child work; follow-ups cannot change modes", {
    timeout: 20000,
  }, async (t) => {
    const { parent } = await fixture(t, { providerModule });
    const prompts = childPrompts(t);
    for (const systemPrompt of [
      "legacy string",
      {},
      { append: "a", replace: "b" },
      { append: "a", extra: true },
      { replace: { text: "nested" } },
    ]) {
      const output = await runCode(
        parent,
        `try { await tools.delegate(${JSON.stringify({ prompt: "Remember unwanted", systemPrompt, tools: [] })}); text("UNEXPECTED_SUCCESS"); } catch (error) { text(error.message); }`,
      );
      assert.match(output, /Validation failed/, JSON.stringify(systemPrompt));
      assert.doesNotMatch(output, /UNEXPECTED_SUCCESS/);
    }
    assert.deepEqual(prompts, []);
    const first = await invoke(parent, { prompt: "Remember violet", tools: [], systemPrompt: { append: "ROLE" } });
    const output = await runCode(
      parent,
      `try { await tools.delegate(${JSON.stringify({ handle: first.details.handle, prompt: "Recall", systemPrompt: { replace: "OTHER" } })}); text("UNEXPECTED_SUCCESS"); } catch (error) { text(error.message); }`,
    );
    assert.match(output, /follow-up accepts only handle and prompt/);
    assert.doesNotMatch(output, /UNEXPECTED_SUCCESS/);
    assert.equal(prompts.length, 1);
  });
});
