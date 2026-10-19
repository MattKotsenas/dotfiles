import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixture } from "./delegation/fixture.mjs";
import { sdk } from "./delegation/sdk.mjs";
import { modelId, providerId } from "./delegation/provider.mjs";

test("packaged CLI loads delegation and returns a real child file read", { timeout: 100000 }, async (t) => {
  const { parent, authPath, fileContents } = await fixture(t);
  const env = { ...process.env, PI_CODING_AGENT_DIR: dirname(authPath), PI_OFFLINE: "1" };
  delete env.NODE_TEST_CONTEXT;
  const code =
    'const result = await tools.delegate({ prompt: "Read note.txt and return its contents.", systemPrompt: "Prefix file contents with CHILD:", tools: ["read"] }); text("CLI_CHILD:" + JSON.stringify(result));';
  const result = spawnSync(
    process.execPath,
    [
      join(sdk.getPackageDir(), "dist/bundle/cli.js"),
      "--print",
      "--mode",
      "json",
      "--offline",
      "--no-session",
      "--no-mcp",
      "--thinking",
      "off",
      "--provider",
      providerId,
      "--model",
      modelId,
      `ACCEPTANCE_CODE:${code}`,
    ],
    {
      cwd: parent.sessionManager.getCwd(),
      env,
      input: "",
      encoding: "utf8",
      timeout: 90000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, (result.stdout ?? "") + (result.stderr ?? ""));
  const events = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const messages = events.filter((event) => event.type === "message_end").map((event) => event.message);
  const tool = messages.findLast((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert(tool, result.stdout);
  assert.notEqual(tool.isError, true, JSON.stringify(tool));
  const output = tool.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const child = JSON.parse(output.match(/^CLI_CHILD:(.+)$/m)?.[1] ?? "null");
  assert(child?.details?.handle, output);
  assert.equal(child.content[0].text, `CHILD:${fileContents}`);
  assert.equal(messages.findLast((message) => message.role === "assistant").stopReason, "stop");
});
