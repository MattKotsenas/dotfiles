import { existsSync } from "node:fs";
import { join } from "node:path";
import quotaResume from "../../agent/extensions/openai-quota-resume/index.ts";
import acceptanceProvider from "./provider.mjs";
import { ai, sdk } from "./sdk.mjs";

export const providerId = "openai";
export const modelId = "quota-scripted";
export const quotaCode = "subscription_sharing_usage_limit_exceeded";

export default function quotaProvider(pi) {
  acceptanceProvider(pi);
  quotaResume(pi);
  pi.on("session_start", (_event, ctx) => {
    if (ctx.model?.provider === providerId) pi.appendEntry("quota-mode", { mode: ctx.mode, hasUI: ctx.hasUI });
  });
  const fake = ai.fauxProvider({ provider: providerId, models: [{ id: modelId }], tokensPerSecond: 0 });
  let requests = 0;
  pi.registerProvider({
    ...fake.provider,
    apiKey: "synthetic-quota-key",
    streamSimple(model, context, options) {
      pi.appendEntry("quota-request", { attempt: ++requests });
      fake.setResponses([
        !existsSync(join(sdk.getAgentDir(), "quota-available"))
          ? ai.fauxAssistantMessage([], {
              stopReason: "error",
              errorMessage: `OpenAI API error (429): ${JSON.stringify({ code: quotaCode, resets_in_seconds: 3600 })}`,
            })
          : ai.fauxAssistantMessage("REVIEW_COMPLETED"),
      ]);
      return fake.provider.streamSimple(model, context, options);
    },
  });
}
