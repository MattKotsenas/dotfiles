import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { describeContext, moveConversation, samePath } from "./move.ts";
import { bindSelection, checkWorkspace, selectionType, snapshot } from "./selection.ts";

function destinationPath(args: string, cwd: string): string {
  let value = args.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.length < 2 || value.at(-1) !== quote) throw new Error("Unmatched path quote");
    value = value.slice(1, -1);
  }
  if (!value) throw new Error("A workspace path is required");
  if (value === "~") value = homedir();
  else if (/^~[\\/]/.test(value)) value = resolve(homedir(), value.slice(2));
  // Treat the argument as a path, not shell syntax. Windows separators stay intact.
  const destination = resolve(cwd, value);
  if (!statSync(destination).isDirectory()) throw new Error(`Not a directory: ${destination}`);
  return destination;
}

export default function (pi: ExtensionAPI) {
  bindSelection(pi);
  pi.registerCommand("cd", {
    description: "Move the current conversation to another workspace",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify(ctx.cwd, "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/cd requires an interactive terminal session", "error");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Wait for the current work and queued messages to finish", "error");
        return;
      }
      let destination: string;
      try {
        destination = destinationPath(args, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
        return;
      }
      if (samePath(destination, ctx.cwd)) return;
      const sourceFile = ctx.sessionManager.getSessionFile();
      const entries = ctx.sessionManager.getEntries();
      if (!sourceFile) {
        ctx.ui.notify("No persistent session path; workspace move was not started", "error");
        return;
      }
      if (existsSync(sourceFile)) {
        await moveConversation(ctx, destination);
        return;
      }
      if (entries.some((entry) => entry.type !== "model_change" && entry.type !== "thinking_level_change")) {
        ctx.ui.notify("Unwritten custom or conversation state cannot be moved conservatively", "error");
        return;
      }
      const candidate = SessionManager.create(destination);
      const candidateFile = candidate.getSessionFile();
      if (!candidateFile) throw new Error("Could not reserve a destination session path");
      // Initializing an explicitly empty file is supported by SessionManager.
      // Exclusive creation ensures we never overwrite another session.
      closeSync(openSync(candidateFile, "wx"));
      try {
        candidate.setSessionFile(candidateFile);
        candidate.appendCustomEntry(selectionType, snapshot(ctx));
      } catch (error) {
        unlinkSync(candidateFile);
        throw error;
      }

      const selected = snapshot(ctx);
      let phase = "empty-switch";
      let last: ExtensionContext = ctx;
      let identity = {
        id: ctx.sessionManager.getSessionId(),
        path: sourceFile,
        cwd: ctx.cwd,
      };
      let result: { cancelled: boolean };
      try {
        result = await ctx.switchSession(candidateFile, {
          withSession: async (fresh) => {
            last = fresh;
            identity = {
              id: fresh.sessionManager.getSessionId(),
              path: candidateFile,
              cwd: fresh.cwd,
            };
            phase = "empty-destination-validation";
            checkWorkspace(fresh, selected);
            fresh.ui.notify(`Workspace: ${fresh.cwd}`, "info");
          },
        });
      } catch (error) {
        // Replacement may have invalidated the old context or installed the new
        // one. Keep its file, propagate the failure, and never claim rollback.
        const state = {
          phase,
          source: sourceFile,
          sourceExists: existsSync(sourceFile),
          destination: candidateFile,
          destinationExists: existsSync(candidateFile),
          runtime: describeContext(last, identity),
        };
        throw new Error(
          `Workspace switch failed: ${String(error)}; candidate session retained\n${JSON.stringify(state)}`,
          { cause: error },
        );
      }
      if (result.cancelled) unlinkSync(candidateFile);
    },
  });
}
