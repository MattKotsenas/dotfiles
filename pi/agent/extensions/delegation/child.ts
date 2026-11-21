import { join, resolve } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
  type ExtensionToolContext,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getParentCredentials, inheritParentAuth } from "./auth.ts";
import { trackModelRefreshes } from "./model-refresh.ts";
import type { ChildRecord } from "./storage.ts";

export type ChildExecutionPolicy = { tools: string[]; hostEnabled: boolean; ownerTool: string };

function inheritTools(ctx: ExtensionToolContext, policy: ChildExecutionPolicy, requested?: string[]): ToolDefinition[] {
  return ctx.tools
    .filter(tool => policy.tools.includes(tool.name) && (requested === undefined || requested.includes(tool.name)))
    .map(tool => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as ToolDefinition["parameters"],
      async execute(_id, args, signal, onUpdate) {
        const outcome = await ctx.executeTool(tool.name, args, { signal, onUpdate });
        if (outcome.isError) {
          const text = outcome.result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
          throw new Error(text || `${tool.name} failed`);
        }
        return outcome.result;
      },
    }));
}

export type ChildRuntime = { session: AgentSession; waitForRefreshes: (signal?: AbortSignal) => Promise<void> };

export async function closeChild(child: ChildRuntime): Promise<void> {
  await child.session.abort();
  const errors: string[] = [];
  const unsubscribe = child.session.extensionRunner.onError(({ event, error }) => {
    if (event === "session_shutdown") errors.push(error);
  });
  try {
    await child.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    unsubscribe();
    child.session.dispose();
  }
  if (errors.length) throw new Error(`Child shutdown failed: ${errors.join("; ")}`);
}

export async function startChild(
  ctx: ExtensionToolContext,
  params: ChildRecord,
  sessionManager: SessionManager,
  policy?: ChildExecutionPolicy,
): Promise<ChildRuntime> {
  const provider = params.provider;
  const modelId = params.model;
  const selectedModel = ctx.modelRegistry.find(provider, modelId);
  if (!selectedModel) throw new Error(`Unknown model: ${provider}/${modelId}`);
  const cwd = sessionManager.getCwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const trusted =
    resolve(cwd) === resolve(ctx.cwd)
      ? ctx.isProjectTrusted()
      : (new ProjectTrustStore(agentDir).get(cwd) ?? settingsManager.getDefaultProjectTrust() === "always");
  settingsManager.setProjectTrusted(trusted);
  const append = params.systemPrompt?.append;
  const replace = params.systemPrompt?.replace;
  const inherited = policy && inheritTools(ctx, policy, params.tools);
  const tools = inherited ? [
    ...(inherited.length ? ["codemode"] : []),
    ...inherited.map(tool => tool.name),
  ] : params.tools;
  const boundary = policy && [
    policy.hostEnabled ? "Host access is enabled for this child turn." : "Host access is blocked for this child turn.",
    "Use sandbox tools for project work. They start in /workspace in the parent's sandbox.",
    "Recheck paths and running services before relying on earlier tool results.",
  ].join(" ");
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    systemPromptOverride: replace === undefined ? undefined : () => replace,
    appendSystemPromptOverride: append === undefined && boundary === undefined
      ? undefined
      : (base) => [...base, ...[append, boundary].filter((text): text is string => text !== undefined)],
    extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()],
    // A projected child uses the parent's policy, not a second copy that owns a different sandbox.
    extensionsOverride: policy && (base => ({
      ...base,
      extensions: base.extensions.filter(extension => !extension.tools.has(policy.ownerTool)),
    })),
  });
  await resourceLoader.reload();
  const errors = resourceLoader.getExtensions().errors;
  if (errors.length)
    throw new Error(`Child extensions failed to load: ${errors.map((error) => error.error).join("; ")}`);
  const modelRuntime = await ModelRuntime.create({
    credentials: getParentCredentials(ctx.modelRegistry),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  await inheritParentAuth(modelRuntime, ctx.modelRegistry);
  const waitForRefreshes = trackModelRefreshes(modelRuntime);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager,
    model: selectedModel,
    thinkingLevel: params.thinkingLevel,
    tools,
    customTools: inherited,
    excludeTools: policy ? ["mcp__*"] : undefined,
  });
  if (policy && tools) session.setActiveToolsByName(tools);
  const child: ChildRuntime = { session, waitForRefreshes };
  try {
    const ui = ctx.ui;
    // Keep the unbound session's no-op display UI; forward only explicit user interactions.
    const uiContext = ctx.hasUI
      ? {
          ...session.extensionRunner.getUIContext(),
          select: ui.select.bind(ui),
          confirm: ui.confirm.bind(ui),
          input: ui.input.bind(ui),
          editor: ui.editor.bind(ui),
          custom: ui.custom.bind(ui),
          notify: ui.notify.bind(ui),
        }
      : undefined;
    await session.bindExtensions({ uiContext });
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Child model is unavailable: ${provider}/${modelId}`);
    return child;
  } catch (error) {
    await closeChild(child);
    throw error;
  }
}
