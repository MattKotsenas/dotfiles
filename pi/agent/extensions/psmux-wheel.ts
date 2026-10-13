import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Work around Pi's Windows mouse-registration order until upstream #9656 is fixed.
  pi.on("session_start", async (_event, ctx) => {
    const pane = process.env.TMUX_PANE;
    if (ctx.mode !== "tui" || !process.env.PSMUX_SESSION || !process.env.TMUX || !pane || !/^%\d+$/.test(pane)) return;

    const { code, stderr, killed } = await pi.exec(
      "psmux", ["set-option", "-p", "-t", pane, "@mouse-force", "on"], { timeout: 5_000 },
    );
    if (code !== 0 || killed) {
      ctx.ui.notify(`psmux wheel workaround failed: ${stderr.trim() || (killed ? "command timed out" : `exit ${code}`)}`, "warning");
    }
  });
}
