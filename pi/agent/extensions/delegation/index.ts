import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { getParentCredentials, inheritParentAuth } from "./auth.ts";
import { trackModelRefreshes } from "./model-refresh.ts";
import { usageSince } from "./usage.ts";

const parameters = Type.Object({
  prompt: Type.String({ description: "Task for a new child, or the next prompt for an existing child." }),
  handle: Type.Optional(Type.String({ description: "Opaque handle from an earlier result.details.handle. Omit to start a child. Follow-ups currently accept only handle and prompt." })),
  systemPrompt: Type.Optional(Type.String({ description: "Initial system prompt for a new child. Omit to use Pi's discovered prompt and instructions." })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Active tool names for a new child. Omit to use Pi settings; [] starts with no active tools. Callable extension tools retain their exposure rules." })),
  provider: Type.Optional(Type.String({ description: "Provider for a new child. Defaults to the parent's selected provider." })),
  model: Type.Optional(Type.String({ description: "Model ID within the chosen provider for a new child. Defaults to the parent's selected model ID." })),
});
const resultSchema = Type.Object({
  content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })),
  details: Type.Object({ handle: Type.String({ description: "Opaque handle for follow-up prompts in this parent session." }) }),
  usage: Type.Object({
    input: Type.Number({ description: "Input tokens excluding cache reads and writes." }),
    output: Type.Number({ description: "Output tokens, including reasoning tokens when reported." }),
    cacheRead: Type.Number({ description: "Input tokens read from the prompt cache." }),
    cacheWrite: Type.Number({ description: "Input tokens written to the prompt cache." }),
    cacheWrite1h: Type.Optional(Type.Number({ description: "Subset of cacheWrite with one-hour retention. Omitted when not reported." })),
    reasoning: Type.Optional(Type.Number({ description: "Subset of output used for reasoning. Omitted when not reported." })),
    totalTokens: Type.Number({ description: "Total tokens reported by Pi." }),
    cost: Type.Object({
      input: Type.Number({ description: "Estimated input cost in USD." }),
      output: Type.Number({ description: "Estimated output cost in USD." }),
      cacheRead: Type.Number({ description: "Estimated cache-read cost in USD." }),
      cacheWrite: Type.Number({ description: "Estimated cache-write cost in USD." }),
      total: Type.Number({ description: "Estimated total cost in USD." }),
    }),
  }, { description: "Tokens and estimated USD cost newly recorded by the child, including tool and summary usage. Follow-ups exclude already reported entries; reasoning and cacheWrite1h are subsets, not extra tokens." }),
});

type Child = { session: AgentSession; waitForRefreshes: (signal?: AbortSignal) => Promise<void>; busy: boolean; reportedEntryCount: number };

function reportUsage(child: Child) {
  const usage = usageSince(child.session.sessionManager, child.reportedEntryCount);
  child.reportedEntryCount = child.session.sessionManager.getEntryCount();
  return usage;
}

async function close(child: Child): Promise<void> {
  await child.session.abort();
  try {
    await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    child.session.dispose();
  }
}

async function start(ctx: ExtensionContext, params: {
  systemPrompt?: string; tools?: string[]; provider?: string; model?: string;
}): Promise<Child> {
  if (!ctx.model) throw new Error("No parent model selected");
  const provider = params.provider ?? ctx.model.provider;
  const modelId = params.model ?? ctx.model.id;
  const selectedModel = ctx.modelRegistry.find(provider, modelId);
  if (!selectedModel) throw new Error(`Unknown model: ${provider}/${modelId}`);
  const cwd = ctx.cwd;
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, systemPrompt: params.systemPrompt,
    extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()],
  });
  await resourceLoader.reload();
  const errors = resourceLoader.getExtensions().errors;
  if (errors.length) throw new Error(`Child extensions failed to load: ${errors.map((error) => error.error).join("; ")}`);
  const modelRuntime = await ModelRuntime.create({
    credentials: getParentCredentials(ctx.modelRegistry), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false,
  });
  await inheritParentAuth(modelRuntime, ctx.modelRegistry);
  const waitForRefreshes = trackModelRefreshes(modelRuntime);
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader, modelRuntime,
    sessionManager: SessionManager.inMemory(cwd),
    model: selectedModel, thinkingLevel: ctx.thinkingLevel, tools: params.tools,
  });
  const child: Child = { session, waitForRefreshes, busy: false, reportedEntryCount: 0 };
  try {
    await session.bindExtensions({ mode: ctx.mode, ...(ctx.hasUI ? { uiContext: ctx.ui } : {}) });
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Child model is unavailable: ${provider}/${modelId}`);
    return child;
  } catch (error) {
    await close(child);
    throw error;
  }
}

export default function delegation(pi: ExtensionAPI): void {
  const children = new Map<string, Child>();
  pi.on("session_shutdown", async () => {
    const closing = [...children.values()];
    children.clear();
    await Promise.all(closing.map(close));
  });
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: "Run a task in a child session (subagent). Returns its answer and a handle for follow-up prompts. Continue with only handle and prompt.",
    exposure: "codemode",
    parameters,
    outputSchema: resultSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (params.handle !== undefined && [params.systemPrompt, params.tools, params.provider, params.model].some((value) => value !== undefined)) {
        throw new Error("A follow-up accepts only handle and prompt");
      }
      const handle = params.handle ?? randomUUID();
      const child = params.handle === undefined ? await start(ctx, params) : children.get(handle);
      if (!child) throw new Error("Unknown delegation handle for this session");
      if (child.busy) throw new Error("This child already has a call in progress");
      children.set(handle, child);
      child.busy = true;
      const abort = () => { void child.session.abort(); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted();
        const runtime = child.session.modelRuntime;
        const refreshed = await runtime.refresh({ allowNetwork: false, signal });
        if (refreshed.errors.size) throw new Error(`Child provider refresh failed: ${[...refreshed.errors.values()].join("; ")}`);
        await child.waitForRefreshes(signal);
        signal?.throwIfAborted();
        await child.session.prompt(params.prompt);
        const last = child.session.messages.findLast((message) => message.role === "assistant");
        signal?.throwIfAborted();
        if (last?.stopReason !== "stop") throw new Error(last?.errorMessage ?? "Child did not finish successfully");
        const result = {
          content: [{ type: "text" as const, text: child.session.getLastAssistantText() ?? "" }],
          details: { handle },
          usage: { ...reportUsage(child) },
        };
        return { ...result, structuredContent: result };
      } catch (error) {
        children.delete(handle);
        try { await close(child); }
        catch (closeError) { error = closeError; }
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          details: {}, isError: true,
          usage: reportUsage(child),
        };
      } finally {
        signal?.removeEventListener("abort", abort);
        child.busy = false;
      }
    },
  });
}
