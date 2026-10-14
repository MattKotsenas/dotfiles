import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

// A reused PID gets a different filename, so scavenging never deletes its new owner's map.
const incarnation = randomUUID();

// Kept outside the factory so tests can use an isolated mapping directory.
export function createSessionMap(directory: string) {
  const file = join(directory, `${process.pid}-${incarnation}.json`);
  let published: string | undefined;

  const clear = () => {
    if (published === undefined) return;
    try {
      if (readFileSync(file, "utf8") === published) unlinkSync(file);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    published = undefined;
  };

  return {
    file,
    clear,
    publish(sessionId: string, sessionFile: string | undefined) {
      if (!sessionFile) { clear(); return; }
      mkdirSync(directory, { recursive: true });
      // Startup/session changes reclaim crashed processes, including interrupted writes.
      // EPERM means a process exists but we lack permission; retain its mapping.
      for (const name of readdirSync(directory)) {
        const match = /^(\d+)-[0-9a-f-]{36}\.json(?:\.tmp)?$/.exec(name);
        const pid = Number(match?.[1]);
        if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) continue;
        try {
          // See if process is alive
          process.kill(pid, 0);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EPERM") continue;
          if (code !== "ESRCH") throw error;
          try { unlinkSync(join(directory, name)); }
          catch (error) { if (!missing(error)) throw error; }
        }
      }
      const value = JSON.stringify({ sessionId, sessionFile });
      // Atomic replacement keeps a concurrent save from seeing partial JSON.
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, value, "utf8");
      renameSync(temporary, file);
      published = value;
    },
  };
}

export default function (pi: ExtensionAPI) {
  let mapping: ReturnType<typeof createSessionMap> | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !process.env.PSMUX_SESSION || !process.env.TMUX ||
        !/^%\d+$/.test(process.env.TMUX_PANE ?? "")) return;
    mapping = createSessionMap(join(process.env.USERPROFILE ?? homedir(), ".pi", "agent", "psmux-sessions"));
    mapping.publish(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
  });
  pi.on("session_shutdown", () => {
    mapping?.clear();
    mapping = undefined;
  });
}
