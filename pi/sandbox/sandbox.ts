import { createEditToolDefinition, createReadToolDefinition, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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
const guidance = [
  ".pi/agent/skills",
  ".pi/agent/expectations",
  ".copilot/instructions",
  ".config/pi-sandbox/OPERATIONS.md",
].map(path => join(homedir(), path));
const readRoots = [workspace, ...guidance];
const editRoots = [workspace];
const fileOptions = { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/bin:/bin" } };

function filePath(path: string, roots: string[]) {
  const absolute = posix.resolve(workspace, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  const root = roots.find(dir => absolute === dir || absolute.startsWith(dir + "/"));
  if (!root || absolute === workspace) {
    throw new Error(roots === editRoots
      ? "Expected a file under /workspace."
      : "Expected a file under /workspace or in an allowed read-only guidance path.");
  }
  return { absolute, root };
}

// Resolve symlinks and check file type inside the container before opening a file.
async function fileOperation(target: Target, operation: "read" | "write" | "check-read" | "check-edit", path: string, input?: string) {
  const reading = operation === "read" || operation === "check-read";
  const { absolute, root } = filePath(path, reading ? readRoots : editRoots);
  const pending = exec(...dispatch(target, ["/bin/sh", "-ec", `
    file=$(realpath -e -- "$2")
    case "$file" in "$3"|"$3"/*) ;; *) echo "File resolves outside its allowed root" >&2; exit 1;; esac
    test -f "$file" || { echo "Expected a regular file" >&2; exit 1; }
    case "$1" in
      read) exec head -c 4194305 -- "$file";;
      write) exec tee -- "$file" >/dev/null;;
      check-read) test -r "$file";;
      check-edit) test -r "$file" && test -w "$file";;
    esac
  `, "sandbox-file", operation, absolute, root]), { ...fileOptions, encoding: "buffer" });
  pending.child.stdin?.on("error", () => { /* Dispatcher errors are reported by execFile. */ });
  pending.child.stdin?.end(input);
  return (await pending).stdout;
}
const sharedTools = ["codemode", manager, ...sandboxTools];
const sharedCallableTools = [...sharedTools, "delegate", "delegates"];
const hostLoadoutEntry = "sandbox.host-tools";

export default function (pi: ExtensionAPI) {
  let hostEnabled = false;
  let hostTools: string[] = [];
  let target: Target | undefined;
  const selected = () => {
    if (!target) throw new Error("Sandbox session is not ready.");
    return target;
  };
  const isHostTool = (name: string) => !sharedCallableTools.includes(name);
  const applyMode = () => pi.setActiveTools(hostEnabled ? [...sharedTools, ...hostTools] : sharedTools);
  const modeStatus = () => hostEnabled ? "\x1b[31mHOST ENABLED\x1b[39m" : "\x1b[32mSANDBOX ONLY\x1b[39m";

  function rememberHostTools(ctx: ExtensionContext) {
    const active = pi.getActiveTools();
    const previous = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === hostLoadoutEntry);
    const saved = previous?.type === "custom" && Array.isArray(previous.data)
      ? previous.data.filter((name): name is string => typeof name === "string" && isHostTool(name))
      : [];
    const current = active.filter(isHostTool);
    hostTools = !hostEnabled && active.some(name => sandboxTools.includes(name)) && current.length === 0 ? saved : current;
    if (JSON.stringify(hostTools) !== JSON.stringify(saved)) pi.appendEntry(hostLoadoutEntry, hostTools);
  }

  pi.on("session_start", (_event, ctx) => {
    target = { id: ctx.sessionManager.getSessionId() };
    hostEnabled = false;
    rememberHostTools(ctx);
    applyMode();
    ctx.ui.setStatus("sandbox", modeStatus());
  });

  pi.on("session_shutdown", event => {
    // Pi carries the active loadout into the new runtime before the new session_start.
    if (event.reason === "reload" && !hostEnabled) pi.setActiveTools([...sharedTools, ...hostTools]);
  });

  pi.on("tool_call", event => {
    if (!hostEnabled && isHostTool(event.toolName)) {
      return { block: true, reason: "Sandbox only: host tools are blocked. Use sandbox_shell, sandbox_read, or sandbox_edit." };
    }
  });

  pi.on("user_bash", () => {
    if (!hostEnabled) return { result: { output: "Host ! commands are disabled. Use /sandbox off to enable host access.", exitCode: 1, cancelled: false, truncated: false } };
  });

  // Child session runners request the current project-tool boundary when starting a turn.
  pi.events.on("child-execution:policy", request => {
    const { accept } = request as { accept: (policy: { tools: string[]; hostEnabled: boolean; ownerTool: string }) => void };
    if (typeof accept !== "function") return;
    const tools = hostEnabled ? [...sandboxTools, ...pi.getActiveTools().filter(isHostTool)] : sandboxTools;
    accept({ tools, hostEnabled, ownerTool: manager });
  });

  pi.registerTool({
    name: tool,
    label: "Sandbox shell",
    description: "Run a POSIX shell command inside the selected sandbox. Working directory: /workspace. Use this for shell commands, search, and creating files. Paths refer to the container, not the host.",
    promptGuidelines: ["Use sandbox tools for project commands and files under /workspace, even when host access is enabled. Unprefixed shell and file tools target the host."],
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
    description: "Read a workspace file or mounted read-only guidance inside the sandbox. Relative project paths start at /workspace. For user skills, instructions, expectations, or OPERATIONS.md, use their advertised host paths unchanged.",
    execute(id, args, signal, update, ctx) {
      return read.execute(id, { ...args, path: filePath(args.path, readRoots).absolute }, signal, update, ctx);
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
      return edit.execute(id, { ...args, path: filePath(args.path, editRoots).absolute }, signal, update, ctx);
    },
  });

  pi.registerTool({
    name: manager,
    label: "Sandbox lifecycle",
    description: "Create, inspect, refresh, stop, or destroy this Pi session’s sandbox. Create requires an approved workspace and profile. Sandbox tools always use this sandbox.",
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
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });

  const usage = "Usage: /sandbox on | /sandbox off | /sandbox status";
  pi.registerCommand("sandbox", {
    description: "Toggle sandbox-only access: /sandbox on | off | status",
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode && !["on", "off", "status"].includes(mode)) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      if (mode === "on" || mode === "off") {
        await ctx.waitForIdle();
        if (hostEnabled) rememberHostTools(ctx);
        hostEnabled = mode === "off";
        applyMode();
      }
      ctx.ui.setStatus("sandbox", modeStatus());
      ctx.ui.notify(hostEnabled
        ? "HOST ACCESS ENABLED. Use sandbox tools for project work."
        : "SANDBOX ONLY. Host tools are blocked.", "info");
    },
  });
}
