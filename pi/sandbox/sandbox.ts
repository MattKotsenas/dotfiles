import { createEditToolDefinition, createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";

const exec = promisify(execFile);
const controller = join(homedir(), ".local/bin/pi-sandboxctl");
const manager = "sandbox_manage";
type Target = { id: string };

function dispatch(target: Target, args: string[]): [string, string[]] {
  return [controller, ["exec", target.id, ...args]];
}

async function manage(args: string[]) {
  try {
    const { stdout } = await exec(controller, args, { maxBuffer: 32 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const failure = error as { stderr?: string };
    throw new Error(failure.stderr?.trim() || "Sandbox controller could not complete the operation.");
  }
}
const tool = "sandbox_shell";
const sandboxTools = [tool, "sandbox_read", "sandbox_edit"];
const workspace = "/workspace";
const fileOptions = { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/bin:/bin" } };

function workspacePath(path: string) {
  const absolute = posix.resolve(workspace, path);
  if (!absolute.startsWith(workspace + "/")) throw new Error("Expected a file path under /workspace.");
  return absolute;
}

// Resolve symlinks and check file type inside the container before opening a file.
async function fileOperation(target: Target, operation: "read" | "write" | "check-read" | "check-edit", path: string, input?: string) {
  const pending = exec(...dispatch(target, ["/bin/sh", "-ec", `
    file=$(realpath "$2")
    case "$file" in /workspace/*) ;; *) echo "File resolves outside /workspace" >&2; exit 1;; esac
    test -f "$file" || { echo "Expected a regular file" >&2; exit 1; }
    case "$1" in
      read) exec head -c 4194305 -- "$file";;
      write) exec tee -- "$file" >/dev/null;;
      check-read) test -r "$file";;
      check-edit) test -r "$file" && test -w "$file";;
    esac
  `, "sandbox-file", operation, path]), { ...fileOptions, encoding: "buffer" });
  pending.child.stdin?.on("error", () => { /* Dispatcher errors are reported by execFile. */ });
  pending.child.stdin?.end(input);
  return (await pending).stdout;
}
const modeStatus = (target?: Target) => target ? "\x1b[32mSANDBOX\x1b[39m" : "\x1b[31mHOST\x1b[39m";

export default function (pi: ExtensionAPI) {
  let target: Target | undefined;
  let hostTools: string[] = [];
  const selected = () => {
    if (!target) throw new Error("Sandbox mode is off.");
    return target;
  };

  pi.on("session_start", (_event, ctx) => {
    if (target && target.id !== ctx.sessionManager.getSessionId()) {
      pi.setActiveTools(hostTools);
      target = undefined;
    }
    ctx.ui.setStatus("sandbox", modeStatus(target));
  });

  // Also gate inactive tools in case another feature attempts a nested tool call.
  pi.on("tool_call", (event) => {
    if (target && !sandboxTools.includes(event.toolName) && event.toolName !== "codemode" && event.toolName !== manager) {
      return { block: true, reason: "SANDBOX mode: use sandbox_shell, sandbox_read, or sandbox_edit in /workspace." };
    }
    if (!target && sandboxTools.includes(event.toolName)) {
      return { block: true, reason: "The sandbox is off. Only the user can enable it with /sandbox on." };
    }
  });

  pi.on("user_bash", () => {
    if (target) return { result: { output: "Host ! commands are disabled in SANDBOX mode. Use /sandbox off to run host commands.", exitCode: 1, cancelled: false, truncated: false } };
  });

  pi.registerTool({
    name: tool,
    label: "Sandbox shell",
    description: "Run a POSIX shell command inside the selected sandbox. Working directory: /workspace. Use this for shell commands, search, and creating files. Paths refer to the container, not the host.",
    promptGuidelines: ["Sandbox mode: use /workspace for project files. Do not assume the host working directory is accessible."],
    defaultActive: false,
    parameters: Type.Object({ command: Type.String({ description: "Shell command to execute inside the sandbox" }) }),
    async execute(_id, { command }, signal) {
      const { stdout, stderr } = await exec(...dispatch(selected(), ["/bin/sh", "-c", command]), {
        signal, timeout: 120_000, maxBuffer: 128 * 1024,
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      });
      return { content: [{ type: "text", text: [stdout, stderr].filter(Boolean).join("\n") || "(no output)" }], details: {} };
    },
  });

  const read = createReadToolDefinition(workspace, {
    operations: {
      access: async path => { await fileOperation(selected(), "check-read", path); },
      readFile: path => fileOperation(selected(), "read", path),
    },
  });
  pi.registerTool({
    ...read, name: "sandbox_read", label: "Sandbox read", defaultActive: false,
    description: "Read a workspace file inside the sandbox, optionally selecting a line range. Relative paths start at /workspace.",
    execute(id, args, signal, update, ctx) {
      return read.execute(id, { ...args, path: workspacePath(args.path) }, signal, update, ctx);
    },
  });

  const edit = createEditToolDefinition(workspace, {
    operations: {
      access: async path => { await fileOperation(selected(), "check-edit", path); },
      readFile: path => fileOperation(selected(), "read", path),
      writeFile: async (path, content) => { await fileOperation(selected(), "write", path, content); },
    },
  });
  pi.registerTool({
    ...edit, name: "sandbox_edit", label: "Sandbox edit", defaultActive: false,
    description: "Apply exact text replacements to an existing workspace file inside the sandbox. Relative paths start at /workspace.",
    execute(id, args, signal, update, ctx) {
      return edit.execute(id, { ...args, path: workspacePath(args.path) }, signal, update, ctx);
    },
  });

  pi.registerTool({
    name: manager,
    label: "Sandbox lifecycle",
    description: "Create, inspect, refresh, stop, or destroy this Pi session’s sandbox in either mode. Create requires an approved workspace and profile. Use /sandbox on to select it.",
    defaultActive: false,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"), Type.Literal("status"), Type.Literal("refresh_credentials"),
        Type.Literal("stop"), Type.Literal("destroy"),
      ]),
      workspace: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" })),
      profile: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" })),
    }),
    async execute(_id, { action, workspace, profile }, _signal, _update, ctx) {
      const id = ctx.sessionManager.getSessionId();
      let args: string[];
      if (action === "create" && workspace && profile) {
        args = [action, id, workspace, profile];
      } else if (action !== "create" && !workspace && !profile) {
        args = [action, id];
      } else {
        throw new Error("Create requires workspace and profile; all other actions take no additional arguments.");
      }
      const result = await manage(args);
      if (action === "create") result.select = "/sandbox on";
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });

  const usage = "Usage: /sandbox on | /sandbox off | /sandbox status";
  pi.registerCommand("sandbox", {
    description: "Switch between this session’s sandbox and host tools: /sandbox on | off | status",
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode && !["on", "off", "status"].includes(mode)) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      if (mode === "on" || mode === "off") await ctx.waitForIdle();
      if (mode === "on") {
        if (!target) hostTools = pi.getActiveTools().filter(name => !sandboxTools.includes(name));
        target = { id: ctx.sessionManager.getSessionId() };
        const shared = hostTools.filter(name => name === "codemode" || name === manager);
        pi.setActiveTools([...shared, ...sandboxTools]);
      } else if (mode === "off" && target) {
        pi.setActiveTools(hostTools);
        target = undefined;
      }
      ctx.ui.setStatus("sandbox", modeStatus(target));
      ctx.ui.notify(target ? "SANDBOX: shell and file tools start this session’s sandbox on demand. No host fallback." : "HOST: host tools are enabled.", "info");
    },
  });
}
