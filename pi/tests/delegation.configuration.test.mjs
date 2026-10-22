import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { answer, fixture, invoke, runCode } from "./delegation/fixture.mjs";
import { ai, sdk } from "./delegation/sdk.mjs";
import { network } from "./delegation/usage-provider.mjs";

const providerModule = fileURLToPath(new URL("./delegation/usage-provider.mjs", import.meta.url));

const collectRequests = (t) => {
  const requests = [];
  const collect = (prompt, config, context) => {
    if (!prompt.startsWith("ACCEPTANCE_CODE:")) requests.push({ prompt, config, context });
  };
  network.on("request", collect);
  t.after(() => network.off("request", collect));
  return requests;
};

// Each case owns its configuration and files in an isolated agent directory.
describe("delegation configuration", { concurrency: false }, () => {
  for (const pathKind of ["inherited", "absolute", "relative"]) {
    test(`${pathKind} cwd controls tools and instruction discovery across reload`, { timeout: 20000 }, async (t) => {
      const { parent, fileContents } = await fixture(t, { persisted: true, providerModule });
      const processCwd = process.cwd();
      const parentCwd = parent.sessionManager.getCwd();
      const cwd = pathKind === "inherited" ? parentCwd : join(dirname(parentCwd), "other workspace");
      const expected = pathKind === "inherited" ? fileContents : "child workspace payload";
      if (cwd !== parentCwd) {
        await mkdir(cwd);
        await writeFile(join(cwd, "note.txt"), expected);
        assert.notEqual(expected, fileContents, "reading the parent's file must fail the test");
      }
      const instruction = `Instruction marker for ${pathKind} cwd`;
      await writeFile(join(cwd, "AGENTS.md"), instruction);
      const requests = collectRequests(t);
      const first = await invoke(parent, {
        prompt: "Read note.txt",
        tools: ["read"],
        ...(pathKind === "inherited" ? {} : { cwd: pathKind === "absolute" ? cwd : relative(parentCwd, cwd) }),
      });
      assert.equal(answer(first), expected);
      assert(requests.every(({ context }) => ai.getCurrentSystemPrompt(context.messages).includes(instruction)));
      const record = parent.sessionManager
        .getBranch()
        .find((entry) => entry.type === "custom" && entry.customType === "delegation.child.v1").data;
      assert.equal(sdk.SessionManager.open(record.sessionFile).getCwd(), cwd);
      await parent.reload();
      const updated = `${expected} after reload`;
      await writeFile(join(cwd, "note.txt"), updated);
      assert.equal(answer(await invoke(parent, { handle: first.details.handle, prompt: "Read note.txt" })), updated);
      assert.equal(parent.sessionManager.getCwd(), parentCwd);
      assert.equal(process.cwd(), processCwd, "child execution must not change the process cwd");
    });
  }

  for (const level of [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    test(`thinking level ${level ?? "inherited"} reaches the provider and survives reload`, {
      timeout: 20000,
    }, async (t) => {
      const { parent } = await fixture(t, { persisted: true, providerModule });
      parent.setThinkingLevel("high");
      assert.equal(parent.thinkingLevel, "high");
      const requests = collectRequests(t);
      const first = await invoke(parent, {
        prompt: "Remember violet",
        tools: [],
        ...(level === undefined ? {} : { thinkingLevel: level }),
      });
      const effective = ai.clampThinkingLevel(parent.model, level ?? "high");
      const reasoning = effective === "off" ? undefined : effective;
      assert.equal(answer(first), "REMEMBERED");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].config.reasoning, reasoning);
      await parent.reload();
      parent.setThinkingLevel("low");
      assert.equal(parent.thinkingLevel, "low");
      assert.equal(answer(await invoke(parent, { handle: first.details.handle, prompt: "Recall" })), "Remember violet");
      assert.equal(requests.length, 2);
      assert.equal(requests[1].config.reasoning, reasoning);
      assert.equal(parent.thinkingLevel, "low", "child configuration must not change the parent");
    });
  }

  for (const decision of [undefined, false, true]) {
    test(`another cwd uses its own saved trust=${decision}`, { timeout: 20000 }, async (t) => {
      const { parent, authPath } = await fixture(t, { providerModule });
      parent.settingsManager.setProjectTrusted(true);
      assert.equal(parent.settingsManager.isProjectTrusted(), true);
      const cwd = join(dirname(parent.sessionManager.getCwd()), "other workspace");
      const marker = join(cwd, "extension-loaded");
      await mkdir(join(cwd, ".pi/extensions"), { recursive: true });
      await writeFile(
        join(cwd, ".pi/extensions/marker.ts"),
        `import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`,
      );
      if (decision !== undefined) new sdk.ProjectTrustStore(dirname(authPath)).set(cwd, decision);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.equal(answer(await invoke(parent, { prompt: "Remember violet", cwd, tools: [] })), "REMEMBERED");
      if (decision) assert.equal(await readFile(marker, "utf8"), "loaded");
      else await assert.rejects(readFile(marker), { code: "ENOENT" });
    });
  }

  test("invalid launch configuration does no child work; follow-ups cannot reconfigure", {
    timeout: 20000,
  }, async (t) => {
    const { parent } = await fixture(t, { providerModule });
    const cwd = parent.sessionManager.getCwd();
    const requests = collectRequests(t);
    for (const [args, pattern] of [
      [{ cwd: "" }, /Validation failed/],
      [{ cwd: "missing-directory" }, /ENOENT/],
      [{ cwd: join(cwd, "note.txt") }, /directory/i],
      [{ thinkingLevel: "turbo" }, /Validation failed/],
    ]) {
      const output = await runCode(
        parent,
        `try { await tools.delegate(${JSON.stringify({ prompt: "Remember unwanted", ...args })}); text("UNEXPECTED_SUCCESS"); } catch (error) { text(error.message); }`,
      );
      assert.match(output, pattern);
      assert.doesNotMatch(output, /UNEXPECTED_SUCCESS/);
    }
    assert.deepEqual(requests, []);
    assert.match(await runCode(parent, "text(JSON.stringify((await tools.delegates({})).details.children));"), /\[\]/);
    const first = await invoke(parent, { prompt: "Remember violet", tools: [] });
    for (const args of [{ cwd }, { thinkingLevel: "high" }]) {
      const output = await runCode(
        parent,
        `try { await tools.delegate(${JSON.stringify({ handle: first.details.handle, prompt: "Recall", ...args })}); text("UNEXPECTED_SUCCESS"); } catch (error) { text(error.message); }`,
      );
      assert.match(output, /follow-up accepts only handle and prompt/);
      assert.doesNotMatch(output, /UNEXPECTED_SUCCESS/);
    }
    assert.equal(requests.length, 1, "rejected follow-ups must not reach the child provider");
  });
});
