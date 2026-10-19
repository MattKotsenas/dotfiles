import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getParentCredentials, inheritParentAuth } from "./auth.ts";
import { trackModelRefreshes } from "./model-refresh.ts";
import type { ChildRecord } from "./storage.ts";

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
  ctx: ExtensionContext,
  params: ChildRecord,
  sessionManager: SessionManager,
): Promise<ChildRuntime> {
  const provider = params.provider;
  const modelId = params.model;
  const selectedModel = ctx.modelRegistry.find(provider, modelId);
  if (!selectedModel) throw new Error(`Unknown model: ${provider}/${modelId}`);
  const cwd = ctx.cwd;
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    systemPrompt: params.systemPrompt,
    extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()],
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
    tools: params.tools,
  });
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
    await session.bindExtensions({ mode: ctx.mode, uiContext });
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Child model is unavailable: ${provider}/${modelId}`);
    return child;
  } catch (error) {
    await closeChild(child);
    throw error;
  }
}
