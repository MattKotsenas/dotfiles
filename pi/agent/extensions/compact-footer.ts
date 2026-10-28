import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";

const providerIcons = new Map([
  ["openai", "\uEC81"],
  ["openai-codex", "\uEC81"],
  ["github-copilot", "\uF4B8"],
]);
const contextKeys = ["compact-context", "compact-context-warn", "compact-context-error"] as const;

function formatCapacity(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
  return String(tokens);
}

export default function (pi: ExtensionAPI) {
  const published = new Map<string, string | undefined>();

  function publish(ctx: ExtensionContext, key: string, value: string | undefined) {
    if (published.has(key) && published.get(key) === value) return;
    published.set(key, value);
    ctx.ui.setStatus(key, value);
  }

  function refreshModel(ctx: ExtensionContext) {
    const model = ctx.model;
    const provider = model?.provider ?? "";
    const providerLabel =
      process.env.POWERLINE_NERD_FONTS === "0" ? provider : (providerIcons.get(provider) ?? provider);
    const id = model?.id.startsWith(`${provider}/`) ? model.id.slice(provider.length + 1) : model?.id;
    const level = ctx.thinkingLevel ?? pi.getThinkingLevel();
    const thinking =
      model?.reasoning && level !== "off" ? ` ${level === "minimal" ? "min" : level === "medium" ? "med" : level}` : "";
    publish(ctx, "compact-model", `${providerLabel ? `${providerLabel} ` : ""}${id ?? "no-model"}${thinking}`);
  }

  function refreshContext(ctx: ExtensionContext, liveTokens?: number) {
    const usage = ctx.getContextUsage();
    const percent = liveTokens !== undefined && usage ? (liveTokens / usage.contextWindow) * 100 : usage?.percent;
    const text = usage
      ? `${percent == null ? "?" : Math.round(percent)}%/${formatCapacity(usage.contextWindow)}`
      : undefined;
    const activeKey =
      percent != null && percent > 90
        ? contextKeys[2]
        : percent != null && percent > 70
          ? contextKeys[1]
          : contextKeys[0];
    // Separate status keys let Powerline apply live theme colors without cached ANSI text.
    for (const key of contextKeys) publish(ctx, key, key === activeKey ? text : undefined);
  }

  function refresh(ctx: ExtensionContext, liveTokens?: number) {
    if (ctx.mode !== "tui") return;
    refreshModel(ctx);
    refreshContext(ctx, liveTokens);
  }

  const update = (_event: unknown, ctx: ExtensionContext) => refresh(ctx);
  const updateAssistant = (event: Pick<MessageEndEvent, "message">, ctx: ExtensionContext) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return;
    const { input, output, cacheRead, cacheWrite } = message.usage;
    const tokens = input + output + cacheRead + cacheWrite;
    if (tokens > 0) refresh(ctx, tokens);
  };
  pi.on("session_start", (_event, ctx) => {
    published.clear();
    refresh(ctx);
  });
  pi.on("model_select", update);
  pi.on("thinking_level_select", update);
  pi.on("session_tree", update);
  pi.on("session_compact", update);
  pi.on("before_agent_start", update);
  pi.on("message_end", (event, ctx) => {
    // Pi dispatches message_end before persisting the finalized message.
    if (event.message.role === "assistant") updateAssistant(event, ctx);
    else refresh(ctx);
  });
  pi.on("turn_end", update);
  pi.on("agent_end", update);
  pi.on("message_update", updateAssistant);
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") {
      for (const key of ["compact-model", ...contextKeys]) ctx.ui.setStatus(key, undefined);
    }
    published.clear();
  });
}
