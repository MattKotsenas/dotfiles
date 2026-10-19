import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ai, sdk } from "./sdk.mjs";
import { modelId, providerId } from "./provider.mjs";

export const network = new EventEmitter();
export const usage = (n) => ({
  input: 11 * n,
  output: 7 * n,
  cacheRead: 5 * n,
  cacheWrite: 3 * n,
  cacheWrite1h: n,
  reasoning: 2 * n,
  totalTokens: 26 * n,
  cost: { input: n / 32, output: n / 16, cacheRead: n / 64, cacheWrite: n / 128, total: (15 * n) / 128 },
});
const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

// Only the network edge is synthetic; credentials and all session/tool execution remain real.
export default function usageProvider(pi) {
  const fake = ai.fauxProvider({
    provider: providerId,
    models: [{ id: modelId, reasoning: true }, { id: "alternate" }],
    tokensPerSecond: 0,
  });
  pi.registerProvider({
    ...fake.provider,
    auth: {
      apiKey: {
        name: "Synthetic test credential",
        resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
      },
    },
    streamSimple(model, context, options) {
      if (options.apiKey !== readFileSync(join(sdk.getAgentDir(), "expected-key"), "utf8")) {
        throw new Error("Missing or outdated test credential");
      }
      const messages = context.messages;
      const userIndex = messages.findLastIndex((message) => message.role === "user");
      const prompt = text(messages[userIndex]);
      network.emit("request", prompt, { model: model.id, reasoning: options.reasoning });
      let response;
      let units;
      if (prompt.startsWith("ACCEPTANCE_CODE:")) {
        const completed = messages.slice(userIndex + 1).find((message) => message.role === "toolResult");
        if (completed) network.emit("codemode-result", completed);
        units = completed ? 2 : 1;
        response = completed
          ? ai.fauxAssistantMessage("PARENT_DONE")
          : ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code: prompt.slice("ACCEPTANCE_CODE:".length) }), {
              stopReason: "toolUse",
            });
      } else if (prompt === "Read note.txt") {
        const read = messages
          .slice(userIndex + 1)
          .find((message) => message.role === "toolResult" && message.toolName === "read");
        units = read ? 5 : 3;
        response = read
          ? ai.fauxAssistantMessage(text(read))
          : ai.fauxAssistantMessage(ai.fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" });
      } else if (prompt === "Probe directly" || prompt === "Probe through codemode") {
        const completed = messages.slice(userIndex + 1).find((message) => message.role === "toolResult");
        units = completed ? 5 : 3;
        response = completed
          ? ai.fauxAssistantMessage(text(completed))
          : ai.fauxAssistantMessage(
              prompt === "Probe directly"
                ? ai.fauxToolCall("probe", {})
                : ai.fauxToolCall("codemode", { code: "text(await tools.probe({}));" }),
              { stopReason: "toolUse" },
            );
      } else if (prompt.startsWith("Remember ")) {
        units = 7;
        response = ai.fauxAssistantMessage("REMEMBERED");
      } else if (prompt === "Recall" || prompt === "Recall again") {
        units = prompt === "Recall" ? 11 : 13;
        const remembered = messages
          .filter((message) => message.role === "user")
          .map(text)
          .find((value) => value.startsWith("Remember "));
        response = ai.fauxAssistantMessage(remembered ?? "HISTORY_MISSING");
      } else if (prompt === "Fail after work") {
        const read = messages
          .slice(userIndex + 1)
          .find((message) => message.role === "toolResult" && message.toolName === "read");
        if (read?.isError) throw new Error("Expected real read to succeed before provider failure");
        units = read ? 19 : 17;
        response = read
          ? ai.fauxAssistantMessage("partial provider output")
          : ai.fauxAssistantMessage(ai.fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" });
      } else if (prompt === "Wait for network") {
        const stream = ai.createAssistantMessageEventStream();
        const partial = {
          ...ai.fauxAssistantMessage("partial network output"),
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: usage(23),
        };
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "partial network output", partial });
        const abort = () => {
          const error = { ...partial, stopReason: "aborted", errorMessage: "Network cancelled with reported usage" };
          stream.push({ type: "error", reason: "aborted", error });
        };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
        network.emit("pending", { usage: partial.usage });
        return stream;
      } else throw new Error(`Unexpected usage test prompt: ${prompt}`);
      fake.setResponses([response]);
      const source = fake.provider.streamSimple(model, context, options);
      const stream = ai.createAssistantMessageEventStream();
      void (async () => {
        for await (const event of source) {
          if (event.type === "done" || event.type === "error") {
            const message = { ...(event.message ?? event.error), usage: usage(units) };
            if (prompt === "Fail after work" && units === 19) {
              stream.push({
                type: "error",
                reason: "error",
                error: { ...message, stopReason: "error", errorMessage: "Provider failed after billed work" },
              });
            } else stream.push(event.type === "done" ? { ...event, message } : { ...event, error: message });
          } else stream.push(event);
        }
      })().catch((error) => {
        stream.push({
          type: "error",
          reason: "error",
          error: {
            ...ai.fauxAssistantMessage(""),
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: usage(0),
            stopReason: "error",
            errorMessage: `Usage test stream failed: ${error.message}`,
          },
        });
      });
      return stream;
    },
  });
}
