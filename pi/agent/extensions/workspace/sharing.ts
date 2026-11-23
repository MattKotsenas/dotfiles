// Advisory check. This neither locks the file nor proves exclusive use.
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export async function inspectEntryIds(file: string, sessionId: string, knowsEntry: (id: string) => boolean) {
  const handle = await open(file, "r");
  let stream: ReturnType<typeof handle.createReadStream> | undefined,
    lines: ReturnType<typeof createInterface> | undefined;
  let headerSeen = false,
    entryCount = 0,
    unknownEntryCount = 0;
  try {
    // Bound the scan to the size observed when it starts; this is not a snapshot.
    const { size } = await handle.stat();
    if (!size) throw new Error("Session header missing; workspace move was not started");
    const lastByte = Buffer.allocUnsafe(1);
    const lastRead = await handle.read(lastByte, 0, 1, size - 1);
    if (lastRead.bytesRead !== 1 || lastByte[0] !== 10) {
      throw new Error("Session file has an unfinished final line; workspace move was not started");
    }
    stream = handle.createReadStream({
      start: 0,
      end: size - 1,
      autoClose: false,
      encoding: "utf8",
    });
    lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (!headerSeen) {
        if (entry.type !== "session" || entry.id !== sessionId) {
          throw new Error("Session identity changed; workspace move was not started");
        }
        headerSeen = true;
      } else {
        if (typeof entry.id !== "string") throw new Error("Session entry has no ID; workspace move was not started");
        entryCount++;
        if (!knowsEntry(entry.id)) unknownEntryCount++;
      }
    }
    if (!headerSeen || stream.bytesRead !== size) {
      throw new Error("Session file changed during inspection; workspace move was not started");
    }
    return { entryCount, unknownEntryCount, bytesRead: stream.bytesRead };
  } finally {
    lines?.close();
    stream?.destroy();
    await handle.close();
  }
}

export async function confirmMoveSharing(ctx: ExtensionCommandContext) {
  await ctx.waitForIdle();
  const inspection = await inspectEntryIds(
    ctx.sessionManager.getSessionFile() as string,
    ctx.sessionManager.getSessionId(),
    (id) => ctx.sessionManager.getEntry(id) !== undefined,
  );
  if (!inspection.unknownEntryCount) return { proceed: true, inspection, warned: false };
  const message =
    `${inspection.unknownEntryCount} session entries on disk are not loaded by this instance. ` +
    "Another instance may have written them. Moving the conversation can strand later writes from other open instances. " +
    "This check cannot detect an idle instance or prevent later writes. Move anyway?";
  const confirm = (text: string) => ctx.ui.select(text, ["Cancel", "Move anyway"]);
  const answer = await confirm(message);
  // Only an explicit affirmative proceeds; cancellation/dismissal/other responses stop here.
  return { proceed: answer === "Move anyway", inspection, warned: true };
}
