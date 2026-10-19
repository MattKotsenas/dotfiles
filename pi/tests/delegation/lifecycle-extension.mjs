import { EventEmitter } from "node:events";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ai } from "./sdk.mjs";

export const lifecycle = new EventEmitter();

// Discovered only by children: tests install this extension after loading the parent.
export default function lifecycleExtension(pi) {
  pi.on("session_start", async (_event, ctx) => {
    if (existsSync(join(ctx.cwd, "hold-startup"))) {
      await new Promise((release) => lifecycle.emit("startup-held", release));
    }
  });
  pi.on("session_shutdown", () => {
    lifecycle.emit("closed");
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "probe" && existsSync(join(ctx.cwd, "deny-probe"))) {
      return { block: true, reason: "Child policy denied probe" };
    }
  });
  pi.registerTool({
    name: "probe",
    label: "Probe",
    description: "Write a marker and optionally wait for cancellation.",
    parameters: ai.Type.Object({}),
    async execute(_id, _args, signal, _onUpdate, ctx) {
      const marker = join(ctx.cwd, "probe-effects");
      appendFileSync(marker, "entered\n");
      if (existsSync(join(ctx.cwd, "wait-in-probe"))) {
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", resolve, { once: true });
          lifecycle.emit("tool-entered", resolve);
        });
        if (existsSync(join(ctx.cwd, "hold-cleanup"))) {
          await new Promise((release) => lifecycle.emit("cleanup-held", release));
        }
        appendFileSync(marker, "cancelled\n");
        throw new Error("Probe cancelled");
      }
      return { content: [{ type: "text", text: "PROBE_EXECUTED" }], details: {} };
    },
  });
}
