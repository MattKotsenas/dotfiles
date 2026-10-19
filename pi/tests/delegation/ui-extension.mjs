import { ai } from "./sdk.mjs";

export const providerId = "delegation-ui";
export const modelId = "child-scripted";

export default function uiExtension(pi) {
  const fake = ai.fauxProvider({ provider: providerId, models: [{ id: modelId }], tokensPerSecond: 0 });
  pi.registerProvider({
    ...fake.provider,
    apiKey: "synthetic-ui-key",
    streamSimple(model, context, options) {
      fake.setResponses([ai.fauxAssistantMessage("CHILD_DONE")]);
      return fake.provider.streamSimple(model, context, options);
    },
  });
  const changeDisplay = (ctx) => {
    ctx.ui.setStatus("child-status", "child");
    ctx.ui.setWorkingMessage("child");
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setWorkingIndicator({ frames: [] });
    ctx.ui.setHiddenThinkingLabel("child");
    ctx.ui.setWidget("child", ["child"]);
    ctx.ui.setFooter(undefined);
    ctx.ui.setHeader(undefined);
    ctx.ui.setTitle("child");
    ctx.ui.pasteToEditor("child");
    ctx.ui.setEditorText("child");
    ctx.ui.addAutocompleteProvider((current) => current);
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setTheme("child");
    ctx.ui.setToolsExpanded(true);
    ctx.ui.onTerminalInput(() => undefined)();
  };
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model?.provider !== providerId) return;
    changeDisplay(ctx);
    const selected = await ctx.ui.select("Choose", ["allow", "deny"]);
    const confirmed = await ctx.ui.confirm("Confirm", "Continue?");
    const input = await ctx.ui.input("Input", "placeholder");
    const edited = await ctx.ui.editor("Edit", "prefill");
    const custom = await ctx.ui.custom((_tui, _theme, _keys, done) => {
      done("custom-result");
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.notify("Child notification", "info");
    pi.appendEntry("child-ui", {
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      selected: selected ?? null,
      confirmed,
      input: input ?? null,
      edited: edited ?? null,
      custom: custom ?? null,
      editorText: ctx.ui.getEditorText(),
    });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.model?.provider === providerId) changeDisplay(ctx);
  });
}
