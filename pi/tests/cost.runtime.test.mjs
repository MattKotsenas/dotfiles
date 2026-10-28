import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import cost from "../agent/extensions/cost/index.ts";
import { project } from "../agent/extensions/cost/ledger.ts";
import { COST_ENTRY, costRecord } from "../agent/extensions/cost/model.ts";
import { ai, sdk, version } from "./delegation/sdk.mjs";

const usage = (total, tokens = 100) => ({
  input: tokens,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: tokens + 1,
  cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ");
const records = (session, kind) =>
  session.sessionManager
    .getEntries()
    .map(costRecord)
    .filter((record) => record?.kind === kind);
const snapshot = (session, rangeId) =>
  project(
    session.sessionManager.getEntries(),
    new Set(session.sessionManager.getBranch().map((entry) => entry.id)),
    session.sessionManager.getSessionId(),
    rangeId,
  );
const custom = (session, content) =>
  session.sendCustomMessage({ customType: "cost-test", content, display: false }, { triggerTurn: true });

// Only the provider and terminal are fake. Pi owns preparation, retries, queues,
// compaction, session persistence, event dispatch, and turn settlement.
async function fixture(
  t,
  { mode = "print", settings = {}, controls = () => {}, manager, persisted = false, oauth = false } = {},
) {
  assert.equal(version, "1.2.0", "these lifecycle contracts are pinned to SDK 1.2.0");
  const root = await mkdtemp(join(tmpdir(), "pi-cost-runtime-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const previous = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SESSION_FILE", "PI_SESSION_ID"].map((key) => [
    key,
    process.env[key],
  ]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  delete process.env.PI_SESSION_FILE;
  delete process.env.PI_SESSION_ID;
  const network = [];
  const denied = (...args) => {
    network.push(args);
    throw new Error("Cost tests deny network access");
  };
  t.mock.method(globalThis, "fetch", denied);
  t.mock.method(Socket.prototype, "connect", denied);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const interval = t.mock.method(globalThis, "setInterval");
  const errors = [];
  const steps = [];
  const requests = [];
  const events = [];
  const statuses = [];
  const notifications = [];
  const overlays = [];
  let runtime;
  let disposed = false;
  let overlay;
  let redraws = 0;
  const providerId = "cost-runtime-test";
  const credentials = new ai.InMemoryCredentialStore();
  await credentials.modify(providerId, async () =>
    oauth
      ? { type: "oauth", access: "synthetic", refresh: "synthetic-refresh", expires: Date.now() + 3600000 }
      : { type: "api_key", key: "synthetic" },
  );
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
    ...settings,
  });
  const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const uiContext = {
    setStatus: (key, value) => statuses.push({ key, value }),
    notify: (message, type) => notifications.push({ message, type }),
    custom: async (factory, options) => {
      const closed = Promise.withResolvers();
      const component = await factory(
        {
          terminal: { rows: 44 },
          requestRender: () => {
            redraws++;
          },
        },
        { fg: (_color, value) => value, inverse: (value) => value },
        {},
        () => closed.resolve(),
      );
      overlay = { component, close: () => closed.resolve() };
      overlays.push(options);
      try {
        await closed.promise;
      } finally {
        component.dispose?.();
        overlay = undefined;
      }
    },
  };
  t.after(async () => {
    try {
      overlay?.close();
      if (runtime && !disposed) {
        await runtime.session.abort();
        await runtime.dispose();
      }
      assert.deepEqual(network, [], "no test may reach a real provider or network");
      assert.deepEqual(errors, [], "native extension errors must not be swallowed");
      assert.equal(steps.length, 0, "all scripted model requests must be consumed");
    } finally {
      t.mock.timers.reset();
      await rm(root, { recursive: true, force: true });
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  const factory = async ({ sessionManager, sessionStartEvent, cwd }) => {
    const fake = ai.fauxProvider({
      provider: providerId,
      models: [{ id: "scripted", contextWindow: 4096 }],
      tokensPerSecond: 0,
    });
    const provider = (pi) => {
      pi.registerProvider({
        ...fake.provider,
        auth: {
          apiKey: {
            name: "Synthetic",
            resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
          },
          oauth: {
            name: "Synthetic OAuth",
            isSubscription: true,
            login: async () => {
              throw new Error("Tests cannot log in");
            },
            refresh: async () => {
              throw new Error("Tests cannot refresh tokens");
            },
            toAuth: async (credential) => ({ apiKey: credential.access }),
          },
        },
        streamSimple(model, context, options) {
          const step = steps.shift();
          assert(step, "every native model request must have a scripted response");
          requests.push(structuredClone(context.messages));
          fake.setResponses([
            async () => {
              step.entered?.resolve();
              if (step.release) {
                await Promise.race([
                  step.release.promise,
                  new Promise((resolve) => {
                    if (options.signal.aborted) resolve();
                    else options.signal.addEventListener("abort", resolve, { once: true });
                  }),
                ]);
              }
              return ai.fauxAssistantMessage(step.content ?? "DONE", {
                stopReason: step.stopReason ?? "stop",
                errorMessage: step.errorMessage,
              });
            },
          ]);
          const source = fake.provider.streamSimple(model, context, options);
          const output = ai.createAssistantMessageEventStream();
          void (async () => {
            for await (const event of source) {
              // Faux has zero-priced estimated usage. Give terminal test responses
              // explicit charges, including charged errors and aborted requests.
              if (event.type === "done") event.message.usage = usage(step.cost ?? 1, step.tokens);
              if (event.type === "error") event.error.usage = usage(step.cost ?? 1, step.tokens);
              output.push(event);
            }
            output.end();
          })();
          return output;
        },
      });
    };
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [cost, provider, controls],
      systemPrompt: "Synthetic cost lifecycle test.",
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const result = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: fake.getModel(),
      settingsManager,
      resourceLoader,
      sessionManager,
      sessionStartEvent,
      noTools: true,
      thinkingLevel: "off",
    });
    const refreshed = await modelRuntime.refresh({ allowNetwork: false });
    assert.equal(refreshed.errors.size, 0);
    assert.equal(
      modelRuntime.isUsingOAuth(providerId),
      oauth,
      "the native auth snapshot must be ready before session_start",
    );
    await result.session.bindExtensions({ mode, uiContext, onError: (error) => errors.push(error) });
    await result.session.setModel(modelRuntime.getModel(providerId, "scripted"));
    result.session.subscribe((event) => events.push(event));
    return {
      ...result,
      services: { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] },
      diagnostics: [],
    };
  };
  runtime = await sdk.createAgentSessionRuntime(factory, {
    cwd: root,
    agentDir,
    sessionManager:
      manager ??
      (persisted ? sdk.SessionManager.create(root, join(root, "sessions")) : sdk.SessionManager.inMemory(root)),
  });
  return {
    runtime,
    settingsManager,
    modelRuntime,
    steps,
    requests,
    events,
    statuses,
    notifications,
    overlays,
    interval,
    async dispose() {
      await runtime.dispose();
      disposed = true;
    },
    get session() {
      return runtime.session;
    },
    get overlay() {
      return overlay?.component;
    },
    get redraws() {
      return redraws;
    },
    status: () => statuses.findLast((entry) => entry.key === "compact-cost")?.value,
    tick: () => t.mock.timers.tick(1000),
    async run(prompt, ...responses) {
      steps.push(...(responses.length ? responses : [{}]));
      await runtime.session.prompt(prompt);
    },
    async open() {
      assert.equal(overlay, undefined);
      const pending = runtime.session.prompt("/cost");
      for (let i = 0; i < 30 && !overlay; i++) await nextTick();
      assert(overlay, "the command must open without waiting for the active run to settle");
      return {
        component: overlay.component,
        close: async () => {
          overlay.close();
          await pending;
        },
      };
    },
    charge(total) {
      return runtime.session.sessionManager.appendUsage("cache_warm", providerId, "scripted", usage(total));
    },
  };
}

function oneTurn(session, excerpt, status = "settled") {
  const starts = records(session, "turn_start");
  const ends = records(session, "turn_end");
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(starts[0].excerpt, excerpt);
  assert.equal(ends[0].id, starts[0].id);
  assert.equal(ends[0].status, status);
  assert.equal(snapshot(session).activities.filter((item) => item.provenance === "observed").length, 1);
  return starts[0];
}

test("real run groups tools, steering, follow-up, and pre-settle continuation until agent_settled", {
  timeout: 20000,
}, async (t) => {
  let continued = false;
  const f = await fixture(t, {
    controls: (pi) => {
      pi.registerTool({
        name: "nested_charge",
        label: "Nested charge",
        description: "Synthetic nested charge",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: "tool failed after nested work" }],
          details: undefined,
          isError: true,
          usage: usage(3),
        }),
      });
      pi.on("agent_before_settle", () => {
        if (continued) return;
        continued = true;
        return {
          entries: [{ type: "custom_message", customType: "continuation", content: "Continue once", display: false }],
          continue: true,
        };
      });
    },
  });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  assert.deepEqual(records(f.session, "turn_start"), []);
  f.steps.push(
    { entered, release, content: ai.fauxToolCall("nested_charge", {}), stopReason: "toolUse", cost: 1 },
    { cost: 2 },
    { cost: 4 },
    { cost: 5 },
  );
  const run = f.session.prompt("First\u001b[31m request\nwith controls");
  await entered.promise;
  assert.equal(f.session.isStreaming, true);
  assert.equal(records(f.session, "turn_start").length, 1);
  assert.deepEqual(records(f.session, "turn_end"), []);
  assert.equal(await f.session.steer("Steer this request"), "queued");
  assert.equal(await f.session.followUp("Then follow up"), "queued");
  release.resolve();
  await run;
  oneTurn(f.session, "First request with controls");
  assert(
    f.events.filter((event) => event.type === "agent_end").length > 1,
    "continuation crosses native agent_end boundaries",
  );
  assert.equal(f.events.filter((event) => event.type === "agent_settled").length, 1);
  for (const prompt of ["Steer this request", "Then follow up"]) {
    assert(
      f.requests.some((messages) => messages.some((message) => message.role === "user" && text(message) === prompt)),
    );
  }
  assert.equal(snapshot(f.session).total, 15);
  const activity = snapshot(f.session).activities.find((item) => item.provenance === "observed");
  assert.equal(activity.tools, 3);
  assert.equal(activity.main, 12);
});

test("native retry keeps charged failure and success in one turn", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 } } });
  await f.run("Retry this", { stopReason: "error", errorMessage: "503 service unavailable", cost: 2 }, { cost: 3 });
  oneTurn(f.session, "Retry this");
  assert.equal(f.requests.length, 2);
  assert.equal(f.events.filter((event) => event.type === "auto_retry_start").length, 1);
  assert.equal(snapshot(f.session).total, 5);
  assert.equal(snapshot(f.session).activities.find((item) => item.provenance === "observed").cost, 5);
});

test("native abort closes the active turn as aborted and counts its charge once", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.steps.push({ entered, release, cost: 2 });
  const run = f.session.prompt("Abort me");
  await entered.promise;
  assert.equal(f.session.isStreaming, true);
  assert.deepEqual(records(f.session, "turn_end"), []);
  await f.session.abort();
  await run;
  oneTurn(f.session, "Abort me", "aborted");
  assert.equal(snapshot(f.session).total, 2);
});

for (const interception of ["handled", "rejected"]) {
  test(`${interception} input cannot lend its cursor to idle usage or a later custom run`, {
    timeout: 20000,
  }, async (t) => {
    const f = await fixture(t, {
      controls: (pi) => {
        pi.on("input", (event) => (event.text === "Handled input" ? { action: "handled" } : undefined));
      },
    });
    if (interception === "handled") await f.session.prompt("Handled input");
    else {
      // Reject after input handlers, before preparation, through native auth validation.
      await f.modelRuntime.logout("cost-runtime-test");
      await assert.rejects(f.session.prompt("Rejected input"), /API key|Authentication/);
      await f.modelRuntime.setRuntimeApiKey("cost-runtime-test", "synthetic");
    }
    assert.deepEqual(records(f.session, "turn_start"), []);
    const idle = f.charge(7);
    f.steps.push({ cost: 2 });
    await custom(f.session, [{ type: "text", text: "Custom\nrequest" }]);
    const first = oneTurn(f.session, "Custom request");
    assert.equal(first.afterEntryId, idle.id);
    assert.equal(snapshot(f.session).activities.find((item) => item.provenance === "observed").cost, 2);
    await f.run("Subsequent user", { cost: 3 });
    assert.equal(records(f.session, "turn_start").length, 2);
    assert.equal(records(f.session, "turn_end").length, 2);
    assert.equal(records(f.session, "turn_start")[1].excerpt, "Subsequent user");
    assert.equal(snapshot(f.session).total, 12);
  });
}

test("failed preparation leaves no completed empty turn and cannot taint a subsequent custom run", {
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t, {
    controls: (pi) => {
      pi.on("before_agent_start", (event) => {
        if (event.messageType === "user" && event.prompt === "Cannot prepare") {
          event.systemPromptOptions.sections["invalid section"] = "Native validation rejects this section name.";
        }
      });
    },
  });
  assert.deepEqual(records(f.session, "turn_start"), []);
  // Section validation runs after all before_agent_start callbacks, before agent_start.
  await assert.rejects(f.session.prompt("Cannot prepare"), /Invalid system prompt section name/);
  assert.deepEqual(records(f.session, "turn_start"), []);
  assert.deepEqual(records(f.session, "turn_end"), []);
  const idle = f.charge(4);
  f.steps.push({ cost: 2 });
  await custom(f.session, "Healthy custom");
  assert.equal(oneTurn(f.session, "Healthy custom").afterEntryId, idle.id);
  assert.equal(snapshot(f.session).total, 6);
});

for (const trigger of ["user", "custom"]) {
  test(`automatic preprompt compaction belongs to its ${trigger} turn, not idle overhead`, {
    timeout: 20000,
  }, async (t) => {
    const f = await fixture(t, {
      settings: { compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1 } },
      controls: (pi) => {
        pi.on("input", (event) => (event.text === "Handled before custom" ? { action: "handled" } : undefined));
        pi.on("session_before_compact", (event) => ({
          compaction: {
            summary: "Synthetic native summary",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            usage: usage(5),
          },
        }));
      },
    });
    await f.run("Seed context", { cost: 1, tokens: 4000 });
    const idle = f.charge(7);
    await f.session.prompt("Handled before custom");
    // Compaction is enabled only after a high-usage finalized response is stored.
    f.settingsManager.setCompactionEnabled(true);
    f.steps.push({ cost: 2 });
    if (trigger === "user") await f.session.prompt("User with preprompt compaction");
    else await custom(f.session, "Custom with preprompt compaction");
    const compactions = f.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1, "the native threshold must actually compact before the new prompt");
    const starts = records(f.session, "turn_start");
    assert.equal(starts.length, 2);
    assert.equal(starts[1].afterEntryId, idle.id);
    const observed = snapshot(f.session).activities.filter((item) => item.provenance === "observed");
    assert.equal(observed[1].cost, 7);
    assert.equal(snapshot(f.session).total, 15);
  });
}

test("manual compaction and idle charges stay outside the next custom turn", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, {
    settings: { compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1 } },
    controls: (pi) => {
      pi.on("input", (event) => (event.text === "Handled" ? { action: "handled" } : undefined));
      pi.on("session_before_compact", (event) => ({
        compaction: {
          summary: "Manual summary",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: usage(5),
        },
      }));
    },
  });
  await f.run("Seed", { cost: 1 });
  await f.session.prompt("Handled");
  await f.session.compact();
  assert.equal(f.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  const idle = f.charge(7);
  f.steps.push({ cost: 2 });
  await custom(f.session, "Custom after manual summary");
  const starts = records(f.session, "turn_start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].afterEntryId, idle.id);
  assert.equal(snapshot(f.session).activities.find((item) => item.excerpt === "Custom after manual summary").cost, 2);
  assert.equal(snapshot(f.session).total, 15);
});

test("resume closes own unmatched starts as interrupted at the existing last entry", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { persisted: true });
  await f.run("Persist a session", { cost: 1 });
  const manager = f.session.sessionManager;
  const owner = manager.getSessionId();
  manager.appendCustomEntry(COST_ENTRY, {
    version: 1,
    owner,
    kind: "turn_start",
    id: "unfinished",
    afterEntryId: manager.getEntries().at(-1).id,
    excerpt: "Interrupted work",
  });
  const anchor = f.charge(2);
  const file = manager.getSessionFile();
  assert.equal(
    records(f.session, "turn_end").some((record) => record.id === "unfinished"),
    false,
  );
  assert.equal((await f.runtime.switchSession(file)).cancelled, false);
  const end = records(f.session, "turn_end").find((record) => record.id === "unfinished");
  assert.equal(end.status, "interrupted");
  assert.equal(end.afterEntryId, anchor.id);
  assert.equal(records(f.session, "turn_end").filter((record) => record.status === "settled").length, 1);
  assert.equal(snapshot(f.session).total, 3);
  await f.session.bindExtensions({ mode: "print" });
  assert.equal(records(f.session, "turn_end").filter((record) => record.id === "unfinished").length, 1);
});

test("TUI timer sees idle usage after returning to the same leaf, redraws the popup, and stops on shutdown", {
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t, { mode: "tui" });
  assert.equal(f.interval.mock.callCount(), 1);
  await f.run("Seed", { cost: 1 });
  assert.equal(f.status(), "$1.00");
  const manager = f.session.sessionManager;
  const leaf = manager.getLeafId();
  const popup = await f.open();
  const writes = manager.getEntryCount();
  const redraws = f.redraws;
  f.charge(2);
  manager.branch(leaf);
  assert.equal(manager.getLeafId(), leaf, "the leaf alone must not invalidate accounting");
  assert.equal(f.status(), "$1.00", "no extension event reports this idle usage");
  f.tick();
  assert.equal(f.status(), "$3.00");
  assert(f.redraws > redraws);
  assert.equal(manager.getEntryCount(), writes + 1, "the refresh tick cannot append metadata");
  assert(popup.component.render(100).join("\n").includes("$3.00"));
  await popup.close();
  await f.session.bindExtensions({ mode: "tui" });
  const reads = t.mock.method(manager, "getEntries");
  const before = reads.mock.callCount();
  f.tick();
  assert.equal(reads.mock.callCount() - before, 1, "session_start must replace, not duplicate, its timer");
  // Repeat shutdown before context invalidation to exercise idempotent cleanup.
  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  await f.dispose();
  const stopped = reads.mock.callCount();
  f.tick();
  assert.equal(reads.mock.callCount(), stopped);
});

for (const mode of ["print", "rpc"]) {
  test(`${mode} has no polling or popup but supports explicit checkpoint commands`, { timeout: 20000 }, async (t) => {
    const f = await fixture(t, { mode });
    assert.equal(f.interval.mock.callCount(), 0);
    const anchor = f.charge(3);
    await f.session.prompt("/cost mark Named checkpoint");
    const [checkpoint] = records(f.session, "checkpoint");
    assert.equal(checkpoint.afterEntryId, anchor.id);
    assert.equal(checkpoint.name, "Named checkpoint");
    assert.equal(snapshot(f.session).baseline, undefined);
    assert.deepEqual(records(f.session, "footer"), []);
    await f.session.prompt("/cost total");
    assert.deepEqual(
      records(f.session, "footer").map((record) => record.id),
      [null],
    );
    const entries = f.session.sessionManager.getEntryCount();
    await f.session.prompt("/cost");
    assert.equal(f.overlays.length, 0);
    assert.match(f.notifications.at(-1).message, /interactive Pi/);
    assert.equal(f.session.sessionManager.getEntryCount(), entries);
    assert.deepEqual(f.statuses, []);
    assert.deepEqual(f.requests, []);
  });
}

test("popup inspection never selects a baseline; explicit footer and undo control it", {
  timeout: 20000,
}, async (t) => {
  const f = await fixture(t, { mode: "tui" });
  await f.run("First", { cost: 2 });
  await f.session.prompt("/cost mark First checkpoint");
  await f.run("Second", { cost: 3 });
  const popup = await f.open();
  assert.deepEqual(f.overlays[0], {
    overlay: true,
    overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center" },
  });
  const count = f.session.sessionManager.getEntryCount();
  popup.component.handleInput("c");
  popup.component.handleInput("\u001b[B");
  popup.component.handleInput("\r");
  popup.component.render(100);
  assert.equal(f.session.sessionManager.getEntryCount(), count, "inspection is read-only");
  assert.equal(snapshot(f.session).baseline, undefined);
  assert.equal(f.status(), "$5.00");
  popup.component.handleInput("c");
  popup.component.handleInput("\r");
  popup.component.handleInput("\u001b[H");
  popup.component.handleInput("m");
  const historical = records(f.session, "checkpoint").at(-1);
  const first = snapshot(f.session).activities.find((item) => item.excerpt === "First");
  assert.equal(historical.afterEntryId, first.afterEntryId);
  assert.notEqual(historical.afterEntryId, f.session.sessionManager.getEntries().at(-2).id);
  assert.equal(f.status(), "$5.00");
  popup.component.handleInput("u");
  assert.equal(records(f.session, "remove").at(-1).id, historical.id, "newest means append order, not anchor order");
  await popup.close();
  // A checkpoint at the last raw entry starts with an explicitly selected zero.
  await f.session.prompt("/cost mark Zero");
  const zero = records(f.session, "checkpoint").at(-1);
  const next = await f.open();
  next.component.handleInput("c");
  for (let i = 0; i < snapshot(f.session).checkpoints.length; i++) next.component.handleInput("\u001b[B");
  next.component.handleInput("f");
  assert.equal(snapshot(f.session).baseline.id, zero.id);
  assert.equal(f.status(), "$0.00");
  next.component.handleInput("\u001b");
  next.component.handleInput("u");
  assert.equal(records(f.session, "remove").at(-1).id, zero.id);
  assert.equal(snapshot(f.session).baseline, undefined);
  assert.equal(f.status(), "$5.00");
  await next.close();
});

for (const oauth of [false, true]) {
  test(`zero session cost keeps ${oauth ? "subscription" : "key"} footer behavior until explicit selection`, {
    timeout: 20000,
  }, async (t) => {
    const f = await fixture(t, { mode: "tui", oauth });
    assert.equal(f.status(), oauth ? "(sub)" : undefined);
    await f.run("Free response", { cost: 0 });
    assert.equal(f.status(), oauth ? "(sub)" : undefined);
    await f.session.prompt("/cost mark Zero");
    assert.equal(f.status(), oauth ? "(sub)" : undefined);
    const popup = await f.open();
    popup.component.handleInput("c");
    popup.component.handleInput("\u001b[B");
    popup.component.handleInput("f");
    assert.equal(f.status(), "$0.00");
    await popup.close();
    await f.session.prompt("/cost total");
    assert.equal(f.status(), oauth ? "(sub)" : undefined);
  });
}

test("cost commands execute while a real response remains active", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { mode: "tui" });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.steps.push({ entered, release });
  const run = f.session.prompt("Keep running");
  await entered.promise;
  const before = f.session.sessionManager.getEntries().at(-1).id;
  await f.session.prompt("/cost mark While busy");
  assert.equal(records(f.session, "checkpoint")[0].afterEntryId, before);
  assert.equal(f.session.isStreaming, true);
  const popup = await f.open();
  await popup.close();
  assert.equal(f.session.isStreaming, true);
  release.resolve();
  await run;
  oneTurn(f.session, "Keep running");
});
