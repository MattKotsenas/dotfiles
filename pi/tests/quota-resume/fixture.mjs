import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ai, formatProgramStatus, openaiResponses, ProgramStatusReporter, sdk } from "./runtime.mjs";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const START = Date.UTC(2026, 9, 19, 12);
export const quota = (fields = {}, transport = "http") => ({
  error: {
    code: "subscription_sharing_usage_limit_exceeded",
    type: "rate_limit_error",
    message: "Usage limit reached.",
    ...fields,
  },
  transport,
});
export const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
export async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await nextTick();
  }
  assert.fail("The expected runtime transition did not occur.");
}

export async function fixture(t, { mode = "tui", provider = "openai", settings = {}, enabled = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-quota-acceptance-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const variables = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SESSION_FILE", "PI_SESSION_ID"];
  const previous = variables.map((key) => [key, process.env[key]]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  delete process.env.PI_SESSION_FILE;
  delete process.env.PI_SESSION_ID;
  let session;
  const errors = [];
  t.after(async () => {
    try {
      if (session) {
        await session.abort();
        session.dispose();
      }
      t.mock.timers.reset();
      await rm(root, { recursive: true, force: true });
      assert.deepEqual(errors, [], "extension errors must not be swallowed");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../../agent/extensions/openai-quota-resume/index.ts");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: enabled ? [entry] : [],
      compaction: { enabled: false },
      cacheWarming: "off",
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 2000 },
      ...settings,
    }),
  );
  const steps = [];
  const requests = [];
  const providers = [...new Set([provider, "manual-alternative"])].map((id) => {
    const fake = ai.fauxProvider({ provider: id, models: [{ id: "first" }, { id: "second" }], tokensPerSecond: 0 });
    const models = fake.models.map((model) => ({ ...model, api: id === "openai" ? "openai-responses" : model.api }));
    return {
      ...fake.provider,
      getModels: () => models,
      streamSimple(model, context, options) {
        const step = steps.shift();
        assert(step, "every provider request must have an explicit scripted response");
        requests.push({
          at: Date.now(),
          model: model.id,
          provider: model.provider,
          messages: structuredClone(context.messages),
        });
        if (step.error && id === "openai" && step.transport !== "normalized") {
          return openaiResponses(model, context, {
            ...options,
            apiKey: "sk-hermetic",
            maxRetries: 0,
            fetch: async () =>
              step.transport === "sse-error" || step.transport === "named-error"
                ? new Response(
                    `${step.transport === "named-error" ? "event: error\n" : ""}data: ${JSON.stringify({ ...step.error, type: "error" })}\n\n`,
                    {
                      headers: { "content-type": "text/event-stream" },
                    },
                  )
                : step.transport === "sse"
                  ? new Response(
                      `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", sequence_number: 0, response: { id: "hermetic", status: "failed", error: step.error } })}\n\n`,
                      { headers: { "content-type": "text/event-stream" } },
                    )
                  : new Response(JSON.stringify({ error: step.error }), {
                      status: 429,
                      headers: { "content-type": "application/json" },
                    }),
          });
        }
        fake.setResponses([
          step.error
            ? ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: step.error.message })
            : ai.fauxAssistantMessage(step),
        ]);
        return fake.provider.streamSimple(model, context, options);
      },
    };
  });
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const resources = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        for (const value of providers) pi.registerProvider(value);
      },
    ],
    systemPrompt: "Complete the user's task.",
  });
  await resources.reload();
  assert.deepEqual(resources.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  ({ session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: resources,
    modelRuntime,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    tools: [],
    thinkingLevel: "off",
  }));
  const ui = { message: undefined, indicator: undefined, notifications: [] };
  const uiContext = {
    notify: (message, type) => ui.notifications.push({ message, type }),
    setWorkingMessage: (message) => {
      ui.message = message;
    },
    setWorkingIndicator: (indicator) => {
      ui.indicator = indicator;
    },
  };
  await session.bindExtensions({ mode, uiContext, onError: (error) => errors.push(error) });
  await modelRuntime.refresh({ allowNetwork: false });
  await session.setModel(modelRuntime.getModel(provider, "first"));
  const osc = [];
  const reporter = new ProgramStatusReporter(
    () => ({ setProgramStatus: (status) => osc.push(formatProgramStatus(status)) }),
    () => "Quota acceptance",
  );
  session.subscribe((event) => reporter.handleEvent(event));
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  let finished = true;
  let run;
  const start = async (...responses) => {
    steps.push(...responses);
    finished = false;
    run = session.prompt("Finish the original task.").finally(() => {
      finished = true;
    });
    await until(() => finished || session.isRetrying || ui.message?.includes("Press escape to cancel."));
  };
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await nextTick();
    await nextTick();
  };
  return {
    session,
    ui,
    requests,
    osc,
    steps,
    start,
    tick,
    get finished() {
      return finished;
    },
    done: async () => {
      await until(() => finished);
      await run;
    },
    waiting: () => {
      assert.equal(finished, false, "the original task must remain active while waiting");
      assert.match(ui.message, /OpenAI usage limit.*Press escape to cancel\./);
      assert.equal(ui.indicator?.frames?.length, 1, "the waiting indicator must be static");
      assert.match(osc.at(-1), /state=working/);
    },
    select: async (id, nextProvider = provider) => session.setModel(modelRuntime.getModel(nextProvider, id)),
  };
}
