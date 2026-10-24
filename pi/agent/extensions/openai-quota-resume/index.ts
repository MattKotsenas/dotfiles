import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const MINUTE = 60_000;
const GRACE_MS = 30_000;
const QUOTA_CODE = "subscription_sharing_usage_limit_exceeded";

function subscriptionFailure(error: unknown): { resetAt?: number } | undefined {
  if (error === null || typeof error !== "object") return;
  const code = "code" in error ? error.code : undefined;
  const type = "type" in error ? error.type : undefined;
  if ((code ?? type) !== QUOTA_CODE) return;

  if ("resets_at" in error) {
    const at = error.resets_at;
    if (typeof at === "number" && Number.isFinite(at) && at > 0) return { resetAt: at * 1000 };
  }
  if ("resets_in_seconds" in error) {
    const seconds = error.resets_in_seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0)
      return { resetAt: Date.now() + seconds * 1000 };
  }
  return {};
}

function quotaFailure(message: AssistantMessage): { resetAt?: number } | undefined {
  if (message.stopReason !== "error" || !["openai", "openai-codex"].includes(message.provider)) return;
  const text = message.errorMessage ?? "";
  // Pi appends its usage link after the first line of OpenAI errors.
  const line = text.split("\n", 1)[0];
  const body = line.match(/^OpenAI API error \((\d{3})\): (?:\1 )?(\{.*\})$/)?.[2];
  if (body !== undefined) {
    let error: unknown;
    try {
      error = JSON.parse(body);
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      return;
    }
    return subscriptionFailure(error);
  }
  // Replace this text fallback with structured quota detection when
  // https://github.com/earendil-works/pi/issues/11071 exposes provider
  // error codes to turn_end handlers.
  if (
    message.provider === "openai" &&
    line.startsWith("The ChatGPT user has reached their Subscription Sharing usage limit.")
  )
    return {};
  const code = line.split(":", 1)[0];
  if (code === QUOTA_CODE || code === `Error Code ${QUOTA_CODE}`) return {};
  if (message.provider === "openai-codex" && text.startsWith("You have hit your ChatGPT usage limit")) {
    const minutes = text.match(/Try again in ~(\d+) min\./)?.[1];
    return { resetAt: minutes === undefined ? undefined : Date.now() + Number(minutes) * MINUTE };
  }
  return undefined;
}

function waitUntil(at: number, signal: AbortSignal, ui: ExtensionUIContext, expires: boolean): Promise<void> {
  return new Promise((resolve) => {
    const update = () => {
      const seconds = Math.max(0, Math.ceil((at - Date.now()) / 1000));
      ui.setWorkingMessage(
        `OpenAI usage limit. ${expires ? "Recovery times out" : "Retrying"} in ${Math.floor(seconds / 60)}m ${seconds % 60}s. Press escape to cancel.`,
      );
    };
    const finish = () => {
      clearTimeout(timer);
      clearInterval(countdown);
      signal.removeEventListener("abort", finish);
      ui.setWorkingMessage();
      ui.setWorkingIndicator();
      resolve();
    };
    ui.setWorkingIndicator({ frames: ["○"] });
    update();
    const timer = setTimeout(finish, Math.max(0, at - Date.now()));
    const countdown = setInterval(update, 1000);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function enableRecovery(pi: ExtensionAPI): void {
  let deadline: number | undefined;
  let retry = false;
  let waiting = false;
  let streamReset: { provider: string; model: string; at: number } | undefined;
  const shutdown = new AbortController();

  pi.on("turn_start", () => {
    retry = false;
    streamReset = undefined;
  });

  pi.on("provider_stream_event", (event) => {
    if (event.provider !== "openai") return;
    const data = event.data;
    if (data === null || typeof data !== "object" || !("type" in data)) return;
    let failure: { resetAt?: number } | undefined;
    switch (data.type) {
      case "error":
        failure = subscriptionFailure(data);
        break;
      case "response.failed": {
        if (!("response" in data)) return;
        const response = data.response;
        if (response === null || typeof response !== "object" || !("error" in response)) return;
        failure = subscriptionFailure(response.error);
        break;
      }
      default:
        return;
    }
    if (failure?.resetAt !== undefined)
      streamReset = { provider: event.provider, model: event.model, at: failure.resetAt };
  });

  pi.on("turn_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const failure = quotaFailure(event.message);
    if (!failure) {
      if (deadline !== undefined && event.outcome === "completed")
        ctx.ui.notify("Quota recovery resumed the task.", "info");
      deadline = undefined;
      return;
    }
    const signal = ctx.signal;
    if (!signal || shutdown.signal.aborted) return;
    if (deadline === undefined) {
      const settings = pi.getSettings() as { openaiQuotaResume?: { maxWaitMs?: unknown } };
      const configured = settings.openaiQuotaResume?.maxWaitMs;
      const maxWaitMs = configured === undefined ? 5 * 60 * MINUTE : configured;
      if (
        typeof maxWaitMs !== "number" ||
        !Number.isSafeInteger(maxWaitMs) ||
        maxWaitMs <= 0 ||
        maxWaitMs > 2147483647
      ) {
        ctx.ui.notify(
          "openaiQuotaResume.maxWaitMs must be an integer from 1 to 2147483647. Automatic recovery is disabled.",
          "warning",
        );
        return;
      }
      deadline = Date.now() + maxWaitMs;
      ctx.ui.notify("OpenAI usage limit reached. Waiting to retry automatically.", "warning");
    }
    const resetAt =
      streamReset?.provider === event.message.provider && streamReset.model === event.message.model
        ? streamReset.at
        : failure.resetAt;
    const resetWithGrace = resetAt === undefined ? undefined : resetAt + GRACE_MS;
    const retryAt =
      resetWithGrace !== undefined && resetWithGrace > Date.now() ? resetWithGrace : Date.now() + 15 * MINUTE;
    waiting = true;
    const combined = AbortSignal.any([signal, shutdown.signal]);
    await waitUntil(Math.min(retryAt, deadline), combined, ctx.ui, retryAt >= deadline);
    waiting = false;
    if (combined.aborted) {
      deadline = undefined;
      return;
    }
    if (Date.now() >= deadline) {
      ctx.ui.notify("OpenAI quota recovery timed out. Continue manually when capacity returns.", "warning");
      deadline = undefined;
      return;
    }
    retry = true;
    // Error turns ignore turn_end continuation. Omit the failed response here so the
    // settlement boundary (or Pi's queued input) has runnable context for the retry.
    return { entries: [...event.entries, { type: "context_edit", targetId: event.messageEntryId, replacement: null }] };
  });

  pi.on("agent_before_settle", (event) => {
    if (!retry || event.outcome !== "error") return;
    retry = false;
    if (event.context.canContinue) return { continue: true };
    deadline = undefined;
  });

  pi.on("cache_warming_decision", () => (waiting ? { action: "stop" } : undefined));
  pi.on("agent_settled", () => {
    deadline = undefined;
    retry = false;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    shutdown.abort();
    if (waiting) ctx.abort();
    deadline = undefined;
    retry = false;
  });
}

export default function openaiQuotaResume(pi: ExtensionAPI): void {
  const unsubscribe = pi.on("session_start", (_event, ctx) => {
    unsubscribe();
    if (ctx.mode === "tui") enableRecovery(pi);
  });
}
