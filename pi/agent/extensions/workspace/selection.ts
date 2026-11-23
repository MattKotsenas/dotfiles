import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const selectionType = "workspace-empty-selection";
export type Selection = {
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
};
export const snapshot = (ctx: ExtensionContext): Selection => ({
  model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
  thinkingLevel: ctx.thinkingLevel,
});
function savedSelection(ctx: ExtensionContext): Selection | undefined {
  if (ctx.sessionManager.buildSessionProjection().messages.length > 0) return;
  const entry = ctx.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "custom" && entry.customType === selectionType);
  return entry?.type === "custom" ? (entry.data as Selection) : undefined;
}
export function bindSelection(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "tui") process.chdir(ctx.cwd);
    const selection = savedSelection(ctx);
    if (!selection) return;
    if (selection.model && (ctx.model?.provider !== selection.model.provider || ctx.model?.id !== selection.model.id)) {
      const model = ctx.modelRegistry.find(selection.model.provider, selection.model.id);
      if (!model || !(await pi.setModel(model))) throw new Error("Could not restore the selected workspace model");
    }
    if (selection.thinkingLevel !== undefined) pi.setThinkingLevel(selection.thinkingLevel);
  });
  const remember = (ctx: ExtensionContext) => {
    const previous = savedSelection(ctx);
    if (previous && JSON.stringify(previous) !== JSON.stringify(snapshot(ctx)))
      pi.appendEntry(selectionType, snapshot(ctx));
  };
  pi.on("model_select", (_event, ctx) => remember(ctx));
  pi.on("thinking_level_select", (_event, ctx) => remember(ctx));
}
export function checkWorkspace(ctx: ExtensionContext, selected: Selection) {
  if (process.cwd() !== ctx.cwd) throw new Error("Terminal process cwd did not follow the workspace");
  if (
    (selected.model && (ctx.model?.provider !== selected.model.provider || ctx.model?.id !== selected.model.id)) ||
    (selected.thinkingLevel !== undefined && ctx.thinkingLevel !== selected.thinkingLevel)
  ) {
    throw new Error("Workspace model or thinking selection was not restored");
  }
}
