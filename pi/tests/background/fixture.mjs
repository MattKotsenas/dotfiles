import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

export const quote = (word) => "'" + word.replaceAll("'", "'\\''") + "'";
export const resultText = (end) =>
  end.result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
export async function until(predicate, budgetMs, label) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(`Observation deadline: ${label}`);
}
export async function bounded(promise, budgetMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Observation deadline: ${label}`)), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function createPeer() {
  const nonce = randomUUID();
  let socket, info, resolveReady, resolvePong;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const server = createServer((connected) => {
    assert.equal(socket, undefined, "command must execute only once");
    socket = connected;
    let buffer = "";
    connected.on("error", (error) => {
      if (error.code !== "ECONNRESET") throw error;
    });
    connected.on("data", (data) => {
      buffer += data.toString("utf8");
      for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        assert.equal(message.nonce, nonce);
        if (message.event === "ready") {
          info = message;
          resolveReady(message);
        }
        if (message.event === "pong") resolvePong?.();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const commandFile = fileURLToPath(new URL("./command.mjs", import.meta.url));
  return {
    ready,
    get info() {
      return info;
    },
    command:
      "MSYS2_ARG_CONV_EXCL='*' " +
      quote(process.execPath.replaceAll("\\", "/")) +
      " " +
      quote(commandFile.replaceAll("\\", "/")) +
      " " +
      server.address().port +
      " " +
      quote(nonce),
    async ping() {
      assert(socket && !socket.destroyed, "precondition: command connection is open");
      const pong = new Promise((resolve) => {
        resolvePong = resolve;
      });
      socket.write(JSON.stringify({ op: "ping" }) + "\n");
      await bounded(pong, 2000, "command pong");
      resolvePong = undefined;
    },
    async finish(exitCode = 7) {
      if (socket && !socket.destroyed) socket.write(JSON.stringify({ op: "finish", exitCode }) + "\n");
      if (info) await until(() => !processAlive(info.pid), 5000, "controlled process exit");
    },
    async dispose() {
      await this.finish();
      socket?.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function createFixture({ output } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-background ' 雪-"));
  const cwd = path.join(root, "workspace ' 雪");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const plugin = fileURLToPath(new URL("../../agent/extensions/background", import.meta.url));
  const shellPath =
    process.env.PI_BACKGROUND_TEST_SHELL ??
    (process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : undefined);
  if (shellPath) assert(existsSync(shellPath), "test shell must exist");
  const faux = fauxProvider({ provider: "background-test", models: [{ id: "offline" }], tokensPerSecond: 0 });
  let desiredCall,
    sequence = 0;
  const holds = new Set();
  faux.setResponses(
    Array.from({ length: 1000 }, () => () => {
      if (!desiredCall) return fauxAssistantMessage("Fixture idle.");
      const { id, name, args, next } = desiredCall;
      desiredCall = next;
      return fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({
        ...(output ? { background: { output } } : {}),
        shellPath,
        shellCommandPrefix: "export PI_BG_TEST='prefix ü 雪'",
        compaction: { enabled: false },
        retry: { enabled: false },
        cacheWarming: "off",
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        additionalExtensionPaths: [plugin],
        systemPrompt: "Run only the explicit offline test steps.",
        extensionFactories: [
          (pi) => {
            pi.registerProvider(faux.provider);
            pi.registerTool({
              name: "evaluation_hold",
              label: "Evaluation hold",
              description: "Hold this test run until it is cancelled.",
              parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
              async execute(_id, { key }, signal) {
                assert(signal && !signal.aborted, "precondition: hold starts before cancellation");
                return new Promise((_, reject) => {
                  signal.addEventListener("abort", () => reject(new Error("Evaluation hold cancelled")), {
                    once: true,
                  });
                  holds.add(key);
                });
              },
            });
          },
          createCodemodeExtension({ mode: "on" }),
        ],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, [], "extension must load");
    assert.deepEqual(services.diagnostics, []);
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: faux.getModel(),
        thinkingLevel: "off",
        tools: ["bash", "bg_run", "bg_status", "bg_wait", "bg_kill", "codemode", "evaluation_hold"],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
  });
  const session = runtime.session;
  const errors = [],
    ends = [],
    starts = [],
    logs = new Set();
  await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") starts.push(event);
    if (event.type !== "tool_execution_end") return;
    ends.push(event);
    const log =
      event.result.structuredContent?.log ??
      event.result.details?.log ??
      /log: ([^\r\n]+?\.log)(?:\.|$)/.exec(resultText(event))?.[1];
    if (log) {
      assert.equal(path.dirname(log), path.join(tmpdir(), "pi-bg"));
      assert.match(path.basename(log), new RegExp(`^${process.pid}-bg\\d+\\.log$`));
      logs.add(log);
    }
  });
  const fixture = {
    cwd,
    session,
    ends,
    starts,
    holds,
    definition(name) {
      return session.extensionRunner.getToolDefinition(name);
    },
    structured(end) {
      const schema = this.definition(end.toolName)?.outputSchema;
      assert(schema, `${end.toolName} must declare outputSchema`);
      assert(end.result.structuredContent, `${end.toolName} must return structuredContent`);
      assert(
        Check(schema, end.result.structuredContent),
        `${end.toolName} result must match its schema: ${JSON.stringify(end.result.structuredContent)}`,
      );
      return end.result.structuredContent;
    },
    async call(name, args, followUps = []) {
      await session.waitForIdle();
      assert.equal(desiredCall, undefined);
      const id = `test-${++sequence}`;
      const next = followUps.reduceRight((next, step) => ({ id: `test-${++sequence}`, ...step, next }), undefined);
      desiredCall = { id, name, args, next };
      await session.prompt(`Test step ${id}`);
      const end = ends.find((event) => event.toolCallId === id);
      assert(end, `authoritative tool result required: ${id}`);
      return end;
    },
    async invoke(name, args, mode = "direct") {
      if (mode === "direct") {
        const end = await this.call(name, args);
        return { end, value: end.result.structuredContent };
      }
      const parent = await this.call("codemode", {
        code: `text({tag:"result",value:await tools.${name}(${JSON.stringify(args)})});`,
      });
      assert.equal(parent.isError, false, resultText(parent));
      const end = ends.findLast((event) => event.parentToolCallId === parent.toolCallId && event.toolName === name);
      assert(end, "nested tool must execute");
      const block = parent.result.content.find(
        (part) => part.type === "text" && part.text.startsWith('{"tag":"result"'),
      );
      assert(block, resultText(parent));
      return { end, value: JSON.parse(block.text).value };
    },
    async dispose() {
      await session.abort();
      await runtime.dispose();
      unsubscribe();
      for (const log of logs) await rm(log, { force: true });
      await rm(root, { recursive: true, force: true });
      assert.deepEqual(errors, [], "no extension-runtime errors");
      assert(faux.state.callCount < 1000, "offline fixture responses must not be exhausted");
    },
  };
  return fixture;
}

export async function usingJob(fixture, mode, method, action, { stdin } = {}) {
  const peer = await createPeer();
  let id;
  try {
    const command = stdin === undefined ? peer.command : `printf '%s' ${quote(stdin)} | ${peer.command}`;
    const args = { command, ...(method === "bash" ? { timeout: 0.1 } : {}) };
    const launch = await fixture.invoke(method, args, mode);
    id =
      launch.end.result.structuredContent?.id ??
      launch.end.result.details?.id ??
      /\bbg\d+\b/.exec(resultText(launch.end))?.[0];
    assert(id, "accepted job must have a handle, including on the unchanged baseline");
    const info = await bounded(peer.ready, 5000, "controlled command ready");
    await peer.ping();
    assert(processAlive(info.pid), "precondition: accepted command is live");
    await action({ peer, id, launch });
  } finally {
    await fixture.session.abort();
    if (id) await fixture.call("bg_kill", { id });
    await peer.finish();
    if (id)
      await until(
        async () => !resultText(await fixture.call("bg_status", { id })).includes("[running,"),
        5000,
        "background terminal cleanup",
      );
    await peer.dispose();
  }
}
