import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeChild, startChild, type ChildRuntime } from "./child.ts";
import { createChildSession, entryType, openChild, restoreChildren, type ChildRecord } from "./storage.ts";
import { usageSince } from "../shared/usage.ts";

const parameters = Type.Object(
  {
    prompt: Type.String({ description: "Task for a new child, or the next prompt for an existing child." }),
    handle: Type.Optional(
      Type.String({
        description:
          "Opaque handle from an earlier result.details.handle. Omit to start a child. Follow-ups currently accept only handle and prompt.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Working directory for a new child. Relative paths resolve against the parent cwd; defaults to the parent cwd.",
      }),
    ),
    thinkingLevel: Type.Optional(
      StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
        description:
          "Thinking level for a new child. Defaults to the parent thinking level; Pi clamps to model support.",
      }),
    ),
    systemPrompt: Type.Optional(
      Type.Union(
        [
          Type.Object({ append: Type.String() }, { additionalProperties: false }),
          Type.Object({ replace: Type.String() }, { additionalProperties: false }),
        ],
        {
          description:
            "Append instruction text or replace the base system prompt for a new child. Omit for Pi discovery.",
        },
      ),
    ),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Active tool names for a new child. Omit to use Pi settings; [] starts with no active tools. Callable extension tools retain their exposure rules.",
      }),
    ),
    provider: Type.Optional(
      Type.String({ description: "Provider for a new child. Defaults to the parent's selected provider." }),
    ),
    model: Type.Optional(
      Type.String({
        description: "Model ID within the chosen provider for a new child. Defaults to the parent's selected model ID.",
      }),
    ),
  },
  { additionalProperties: false },
);
const childrenSchema = Type.Object({
  content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })),
  details: Type.Object({
    children: Type.Array(
      Type.Object({
        handle: Type.String(),
        prompt: Type.String(),
        status: Type.Union(
          ["running", "stopping", "interrupted", "completed", "failed"].map((value) => Type.Literal(value)),
        ),
      }),
    ),
  }),
});
const resultSchema = Type.Object({
  content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })),
  details: Type.Object({
    handle: Type.String({ description: "Opaque handle for follow-up prompts in this parent session." }),
  }),
  usage: Type.Object(
    {
      input: Type.Number({ description: "Input tokens excluding cache reads and writes." }),
      output: Type.Number({ description: "Output tokens, including reasoning tokens when reported." }),
      cacheRead: Type.Number({ description: "Input tokens read from the prompt cache." }),
      cacheWrite: Type.Number({ description: "Input tokens written to the prompt cache." }),
      cacheWrite1h: Type.Optional(
        Type.Number({ description: "Subset of cacheWrite with one-hour retention. Omitted when not reported." }),
      ),
      reasoning: Type.Optional(
        Type.Number({ description: "Subset of output used for reasoning. Omitted when not reported." }),
      ),
      totalTokens: Type.Number({ description: "Total tokens reported by Pi." }),
      cost: Type.Object({
        input: Type.Number({ description: "Estimated input cost in USD." }),
        output: Type.Number({ description: "Estimated output cost in USD." }),
        cacheRead: Type.Number({ description: "Estimated cache-read cost in USD." }),
        cacheWrite: Type.Number({ description: "Estimated cache-write cost in USD." }),
        total: Type.Number({ description: "Estimated total cost in USD." }),
      }),
    },
    {
      description:
        "Tokens and estimated USD cost newly recorded by the child, including tool and summary usage. Follow-ups exclude already reported entries; reasoning and cacheWrite1h are subsets, not extra tokens.",
    },
  ),
});

type Child = {
  record: ChildRecord;
  live?: ChildRuntime;
  operation?: { done: Promise<void>; stop: AbortController };
};

export default function delegation(pi: ExtensionAPI): void {
  const children = new Map<string, Child>();
  let ready = true;
  const assertReady = () => {
    if (!ready) throw new Error("Delegation is restoring parent branch state; reload if restoration failed");
  };
  const closeChildren = async () => {
    const closing = [...children.values()];
    children.clear();
    for (const child of closing) child.operation?.stop.abort();
    const closed = await Promise.allSettled(
      closing.map(async (child) => {
        await child.operation?.done;
        if (child.live) await closeChild(child.live);
      }),
    );
    const errors = closed.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
  };
  const save = (child: Child) => {
    if (child.live) {
      const session = child.live.session;
      child.record.leafId = session.sessionManager.getLeafId();
      child.record.thinkingLevel = session.thinkingLevel;
      if (session.model) {
        child.record.provider = session.model.provider;
        child.record.model = session.model.id;
      }
    }
    pi.appendEntry(entryType, { ...child.record });
  };
  pi.on("session_start", (_event, ctx) => {
    children.clear();
    for (const [handle, record] of restoreChildren(ctx)) children.set(handle, { record });
  });
  pi.on("session_before_tree", (_event, ctx) => {
    if (!ready || [...children.values()].some((child) => child.operation)) {
      if (ctx.hasUI) ctx.ui.notify("Wait for delegation calls and cancellation cleanup before navigating", "warning");
      return { cancel: true };
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    ready = false;
    await closeChildren();
    for (const [handle, record] of restoreChildren(ctx)) children.set(handle, { record });
    ready = true;
  });
  pi.on("session_shutdown", closeChildren);
  const namespace = { name: "delegation", description: "Run child Pi sessions and discover their conversations." };
  pi.registerTool({
    name: "delegates",
    label: "Delegates",
    description: "List this parent's child sessions without starting work.",
    exposure: "codemode",
    namespace,
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: childrenSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, _params, signal) {
      signal?.throwIfAborted();
      assertReady();
      const entries = [...children.values()].map(({ record: { handle, prompt, status } }) => ({
        handle,
        prompt,
        status,
      }));
      const result = {
        content: [{ type: "text" as const, text: JSON.stringify(entries) }],
        details: { children: entries },
      };
      return { ...result, structuredContent: result };
    },
  });
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Run a task in a child session (subagent). Returns its answer and a handle for follow-up prompts. Continue with only handle and prompt.",
    exposure: "codemode",
    namespace,
    parameters,
    outputSchema: resultSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      assertReady();
      if (
        params.handle !== undefined &&
        [params.systemPrompt, params.tools, params.provider, params.model, params.cwd, params.thinkingLevel].some(
          (value) => value !== undefined,
        )
      ) {
        throw new Error("A follow-up accepts only handle and prompt");
      }
      const handle = params.handle ?? randomUUID();
      let child = children.get(handle);
      let manager: SessionManager | undefined;
      if (params.handle === undefined) {
        if (!ctx.model) throw new Error("No parent model selected");
        const provider = params.provider ?? ctx.model.provider;
        const model = params.model ?? ctx.model.id;
        if (!ctx.modelRegistry.find(provider, model)) throw new Error(`Unknown model: ${provider}/${model}`);
        const cwd = resolve(ctx.cwd, params.cwd ?? ".");
        if (!statSync(cwd).isDirectory()) throw new Error(`Child cwd is not a directory: ${cwd}`);
        manager = createChildSession(ctx, cwd);
        child = {
          record: {
            version: 1,
            owner: ctx.sessionManager.getSessionId(),
            handle,
            prompt: params.prompt,
            status: "running",
            sessionFile: manager.getSessionFile(),
            sessionId: manager.getSessionId(),
            systemPrompt: params.systemPrompt,
            tools: params.tools,
            provider,
            model,
            thinkingLevel: params.thinkingLevel ?? ctx.thinkingLevel,
            reportedEntryCount: 0,
            leafId: null,
          },
        };
        children.set(handle, child);
      }
      if (!child) throw new Error("Unknown delegation handle for this session");
      if (child.operation) throw new Error("This child already has a call in progress or is stopping");
      const done = Promise.withResolvers<void>();
      const stop = new AbortController();
      child.operation = { done: done.promise, stop };
      child.record.status = "running";
      const active = child;
      const abort = () => {
        active.record.status = "stopping";
        void active.live?.session.abort();
      };
      stop.signal.addEventListener("abort", abort, { once: true });
      const forwardAbort = () => stop.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const reportUsage = () => {
        const ledger = active.live?.session.sessionManager ?? manager;
        const usage = usageSince(ledger ?? SessionManager.inMemory(ctx.cwd), active.record.reportedEntryCount);
        if (ledger) active.record.reportedEntryCount = ledger.getEntryCount();
        save(active);
        return usage;
      };
      try {
        save(child);
        if (!child.live) {
          if (!manager) {
            manager = openChild(child.record);
            const context = manager.buildSessionContext();
            if (context.model) {
              child.record.provider = context.model.provider;
              child.record.model = context.model.modelId;
            }
            child.record.thinkingLevel =
              (context.thinkingLevel as ChildRecord["thinkingLevel"]) ?? child.record.thinkingLevel;
          }
          child.live = await startChild(ctx, child.record, manager);
        }
        const { session, waitForRefreshes } = child.live;
        stop.signal.throwIfAborted();
        const runtime = session.modelRuntime;
        const refreshed = await runtime.refresh({ allowNetwork: false, signal: stop.signal });
        if (refreshed.errors.size)
          throw new Error(`Child provider refresh failed: ${[...refreshed.errors.values()].join("; ")}`);
        await waitForRefreshes(stop.signal);
        stop.signal.throwIfAborted();
        await session.prompt(params.prompt);
        const last = session.messages.findLast((message) => message.role === "assistant");
        stop.signal.throwIfAborted();
        if (last?.stopReason !== "stop") throw new Error(last?.errorMessage ?? "Child did not finish successfully");
        child.record.status = "completed";
        const result = {
          content: [{ type: "text" as const, text: session.getLastAssistantText() ?? "" }],
          details: { handle },
          usage: { ...reportUsage() },
        };
        return { ...result, structuredContent: result };
      } catch (error) {
        await child.live?.session.abort();
        child.record.status = stop.signal.aborted ? "interrupted" : "failed";
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          details: { handle },
          isError: true,
          usage: reportUsage(),
        };
      } finally {
        signal?.removeEventListener("abort", forwardAbort);
        child.operation = undefined;
        done.resolve();
      }
    },
  });
}
