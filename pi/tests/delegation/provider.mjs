import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ai, sdk } from "./sdk.mjs";

export const providerId = "delegation-acceptance";
export const modelId = "scripted";
const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

// The model is the fake edge. Pi, codemode, delegation, tools and session storage stay real.
export default function acceptanceProvider(pi) {
  const fake = ai.fauxProvider({ provider: providerId, models: [{ id: modelId }], tokensPerSecond: 0 });
  pi.registerProvider({
    ...fake.provider,
    auth: {
      apiKey: {
        name: "Synthetic test credential",
        resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
      },
    },
    streamSimple(model, context, options) {
      const expectedKey = readFileSync(join(sdk.getAgentDir(), "expected-key"), "utf8");
      if (options.apiKey !== expectedKey) throw new Error("Test provider rejected an outdated or missing credential");
      const messages = context.messages;
      const userIndex = messages.findLastIndex((message) => message.role === "user");
      const prompt = text(messages[userIndex]);
      let response;
      if (prompt.startsWith("ACCEPTANCE_CODE:")) {
        const tools = ai.getCurrentTools(messages);
        if (tools.some((tool) => tool.name === "delegate" || tool.name === "delegates"))
          throw new Error("Delegation was directly declared to the parent model");
        const completed = messages.slice(userIndex + 1).some((message) => message.role === "toolResult");
        response = completed
          ? ai.fauxAssistantMessage("PARENT_DONE")
          : ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code: prompt.slice("ACCEPTANCE_CODE:".length) }), {
              stopReason: "toolUse",
            });
      } else if (prompt.startsWith("Read note.txt")) {
        const read = messages
          .slice(userIndex + 1)
          .findLast((message) => message.role === "toolResult" && message.toolName === "read");
        if (!read)
          response = ai.fauxAssistantMessage(ai.fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" });
        else {
          const system = ai.getCurrentSystemPrompt(messages);
          response = ai.fauxAssistantMessage(
            system.includes("Prefix file contents with CHILD:") ? `CHILD:${text(read)}` : "CHILD_SYSTEM_PROMPT_MISSING",
          );
        }
      } else if (prompt.startsWith("Remember this word:")) {
        response = ai.fauxAssistantMessage("REMEMBERED");
      } else if (prompt === "What word did I ask you to remember?") {
        const remembered = messages
          .filter((message) => message.role === "user")
          .map(text)
          .filter((value) => value.startsWith("Remember this word:"))
          .at(-1);
        const word = remembered?.slice("Remember this word:".length).trim() ?? "MEMORY_MISSING";
        const system = ai.getCurrentSystemPrompt(messages);
        response = ai.fauxAssistantMessage(
          ai.getCurrentTools(messages).length !== 0
            ? "UNEXPECTED_CHILD_TOOLS"
            : system.includes("Prefix recalled words with MEMORY:")
              ? `MEMORY:${word}`
              : "CHILD_SYSTEM_PROMPT_MISSING",
        );
      } else throw new Error(`Unexpected test prompt: ${prompt}`);
      fake.setResponses([response]);
      return fake.provider.streamSimple(model, context, options);
    },
  });
}
