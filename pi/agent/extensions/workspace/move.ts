import { existsSync, lstatSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type ExtensionCommandContext, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { prepareContinuation } from "./continuation.ts";
import { relocateFile } from "./relocate-file.ts";
import { checkWorkspace, snapshot } from "./selection.ts";
import { confirmMoveSharing } from "./sharing.ts";
import { cleanupOwnedTemporary, type Identity } from "./temporary-cleanup.ts";

export const samePath = (a: string, b: string) =>
  process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

export function describeContext(ctx: ExtensionContext, identity: Identity) {
  try {
    return {
      context: "accessible",
      id: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
    };
  } catch (error) {
    return {
      context: "unavailable",
      currentRuntime: "unknown",
      lastKnown: identity,
      reason: String(error),
    };
  }
}
export async function moveConversation(ctx: ExtensionCommandContext, cwd: string) {
  const source = ctx.sessionManager.getSessionFile() as string;
  const id = ctx.sessionManager.getSessionId();
  const destination = join(SessionManager.create(cwd).getSessionDir(), basename(source));
  if (lstatSync(destination, { throwIfNoEntry: false }))
    throw new Error(`Destination session path already exists: ${destination}`);
  const sharing = await confirmMoveSharing(ctx);
  if (!sharing.proceed) return;
  if (!ctx.model || ctx.thinkingLevel === undefined)
    throw new Error("No selected model/thinking level; workspace move was not started");
  const selected = snapshot(ctx);
  const saved = {
    leaf: ctx.sessionManager.getLeafId(),
    persistedEntryCount: sharing.inspection.entryCount,
    model: { provider: ctx.model.provider, id: ctx.model.id },
    thinking: ctx.thinkingLevel,
  };
  let phase = "first-switch";
  let last = {
    ctx: ctx as ExtensionContext,
    identity: { id, path: source, cwd: ctx.cwd },
  };
  let owned: Omit<Identity, "cwd"> | undefined;
  try {
    await ctx.newSession({
      withSession: async (temporary) => {
        owned = {
          path: temporary.sessionManager.getSessionFile() as string,
          id: temporary.sessionManager.getSessionId(),
        };
        last = { ctx: temporary, identity: { ...owned, cwd: temporary.cwd } };
        phase = "checkpoint";
        // Reopen only after outgoing shutdown, including later extensions' writes.
        prepareContinuation(SessionManager.open(source), saved);
        phase = "relocation";
        relocateFile(source, destination, id, cwd);
        phase = "second-switch";
        const second = await temporary.switchSession(destination, {
          withSession: async (reopened) => {
            last = {
              ctx: reopened,
              identity: { id, path: destination, cwd: reopened.cwd },
            };
            phase = "destination-validation";
            checkWorkspace(reopened, selected);
            phase = "cleanup";
            const cleanup = cleanupOwnedTemporary(
              reopened,
              { path: destination, id, cwd },
              owned as Omit<Identity, "cwd">,
            );
            if (cleanup.warning) reopened.ui.notify(cleanup.warning, "warning");
            reopened.ui.notify(`Workspace: ${reopened.cwd}`, "info");
          },
        });
        if (second.cancelled) {
          temporary.ui.notify(
            `Workspace second switch cancelled; sourceExists=${existsSync(source)}; destination=${destination}; destinationExists=${existsSync(destination)}; active temporary=${owned.path}. No rollback performed.`,
            "warning",
          );
        }
      },
    });
  } catch (cause) {
    const candidate = cause instanceof Error && "candidatePath" in cause ? String(cause.candidatePath) : undefined;
    const state = {
      phase,
      source,
      destination,
      sourceExists: existsSync(source),
      destinationExists: existsSync(destination),
      candidate,
      candidateExists: candidate ? existsSync(candidate) : false,
      temporary: owned ? { ...owned, exists: existsSync(owned.path) } : undefined,
      runtime: describeContext(last.ctx, last.identity),
    };
    throw new Error(`Workspace move failed during ${phase}: ${String(cause)}\n${JSON.stringify(state)}`, { cause });
  }
}
