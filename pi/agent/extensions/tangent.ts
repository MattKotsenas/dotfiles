import { rmSync } from "node:fs";
import { getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COST_ENTRY, checkpointRecord, footerRecord } from "./cost/model.ts";

export function launchCommand(args: string[], agentDir: string, platform = process.platform): string {
  if (platform === "win32") {
    // PowerShell also treats curly single quotes as string delimiters.
    const quote = (value: string) => `'${value.replace(/['\u2018-\u201b]/g, (mark) => mark + mark)}'`;
    const script = `$env:PI_CODING_AGENT_DIR = ${quote(agentDir)}; & pi ${args.map(quote).join(" ")}`;
    return `pwsh -NoLogo -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `PI_CODING_AGENT_DIR=${quote(agentDir)} pi ${args.map(quote).join(" ")}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tangent", {
    description: "Fork this conversation into a side-by-side tmux/psmux pane: /tangent [name]",
    handler: async (name, ctx) => {
      let fork: string | undefined;
      try {
        const pane = process.env.TMUX_PANE;
        const socket = /^(.*),[^,]+,[^,]+$/.exec(process.env.TMUX ?? "")?.[1];
        if (ctx.mode !== "tui" || !socket || !pane) {
          throw new Error("/tangent requires interactive Pi inside tmux or psmux.");
        }
        await ctx.waitForIdle();
        const source = ctx.sessionManager.getSessionFile();
        const leaf = ctx.sessionManager.getLeafId();
        if (!source || !leaf) throw new Error("There is no saved conversation to fork yet.");
        const directory = ctx.sessionManager.getSessionDir();
        // Use a separate manager so extracting the selected branch cannot move the parent runtime.
        const child = SessionManager.open(source, directory, ctx.cwd);
        fork = child.createBranchedSession(leaf);
        if (!fork) throw new Error("Could not save the tangent session.");
        const label = name.trim() || "tangent";
        const checkpoint = checkpointRecord(child.getSessionId(), label, child.getEntries().at(-1)?.id ?? null);
        child.appendCustomEntry(COST_ENTRY, checkpoint);
        child.appendCustomEntry(COST_ENTRY, footerRecord(child.getSessionId(), checkpoint.id));
        const args = ["--session", fork, "--session-dir", directory, "--name", label];
        if (ctx.model) args.push("--provider", ctx.model.provider, "--model", ctx.model.id);
        args.push("--thinking", pi.getThinkingLevel());
        const opened = await pi.exec(
          "tmux",
          ["-S", socket, "split-window", "-h", "-t", pane, "-c", ctx.cwd, launchCommand(args, getAgentDir())],
          { timeout: 10000 },
        );
        if (opened.code !== 0 || opened.killed) throw new Error(opened.stderr || "Could not open the tangent pane.");
        fork = undefined;
        ctx.ui.notify(`Opened tangent: ${label}`, "info");
      } catch (error) {
        if (fork) {
          try {
            rmSync(fork, { force: true });
          } catch (cleanup) {
            ctx.ui.notify(`Could not remove unused tangent ${fork}: ${String(cleanup)}`, "error");
          }
        }
        ctx.ui.notify(`Tangent failed: ${String(error)}`, "error");
      }
    },
  });
}
