import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type BashOperations,
  createBashToolDefinition,
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { shortCommand } from "./command.ts";
import { type Job, JOB_STATES } from "./job.ts";
import { forwardAbort, JobSupervisor } from "./job-supervisor.ts";
import {
  DEFAULT_TAIL_LIMITS,
  FileJobOutput,
  MemoryJobOutput,
  lineCount,
  tailLimits,
  type OutputTail,
} from "./output-store.ts";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;

const UI_TAIL_LINES = 20;
const HANDOFF_BYTES = DEFAULT_TAIL_LIMITS.maxBytes;
// A bash command still running after this long moves to the background, so it no longer blocks the turn
const AUTO_BACKGROUND_SECS = 120;
const DEFAULT_WAIT_SECS = 30;
const MAX_WAIT_SECS = 120;
const WAKE_DEBOUNCE_MS = 1000;
const MAX_WAKES = 10;
const MAX_SHOWN_JOBS = 3;
// A running job silent this long shows how long it has been quiet, since it may be stuck
const SILENT_AFTER_MS = 10 * 60_000;
// Finished jobs listed by /bg; older ones stay reachable as /bg <id>
const MAX_LISTED_FINISHED = 10;
// How long a bash command runs before the jobs line offers ctrl+b, so quick commands don't flash it
const HINT_AFTER_MS = 3000;
// How long finished results wait for jobs started alongside them before Pi is woken anyway
const GROUP_HOLD_MS = 2 * 60_000;

const jobOutputSchema = Type.Object({
  id: Type.String(),
  command: Type.String(),
  log: Type.Union([Type.String(), Type.Null()], {
    description: "Captured output file path, or null for memory capture",
  }),
  status: StringEnum(JOB_STATES),
  exit_code: Type.Union([Type.Number(), Type.Null()], { description: "Exit code, or null when none is available" }),
  wall_time_seconds: Type.Number(),
  output: Type.String({ description: "Combined stdout/stderr included in this result" }),
  output_truncated: Type.Boolean({
    description:
      "Earlier output was excluded by tail limits, memory eviction, or handoff buffering; also true when capture is unavailable",
  }),
});

function shownOutput(output: OutputTail): string {
  return `${output.text || "(no output)"}${output.truncated ? "\n[Earlier output omitted or capture unavailable; increase lines/max_bytes or inspect the log when available.]" : ""}`;
}

/** 45s, 12m30s, or 1h20m once seconds no longer matter. */
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor(s / 60) % 60}m`;
}

function elapsed(job: Job): string {
  return duration((job.ended ?? Date.now()) - job.started);
}

function state(job: Job): string {
  return job.status === "exited" ? `exit ${job.exitCode}` : job.status;
}

function summary(job: Job, command = job.command): string {
  return `${job.id} [${state(job)}, ${elapsed(job)}] ${command}\n  ${job.log ? `log: ${job.log}` : "output: memory"}`;
}

/** An output line as a terminal would last have shown it: without escape codes or control characters, and a progress bar redrawn with \r in its latest state only. */
function cleanLine(line: string): string {
  const shown =
    stripTerminalSequences(line)
      .split("\r")
      .filter((part) => part.trim())
      .at(-1) ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove C0 controls and DEL from terminal output.
  const controls = /[\x00-\x08\x0b-\x1f\x7f]/g;
  return shown.replace(/\t/g, "  ").replace(controls, "").trimEnd();
}

/** The part of a command worth showing: its first line, without a leading cd, with a script path shortened to its name and at most 50 characters. */
function shownCommand(command: string): string {
  const shown = command
    .split("\n")[0]
    .replace(/^\s*(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, "")
    // Leading settings such as PYTHONPATH=/some/src, which the path shortening below would cut at their last /
    .replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, "")
    .replace(/^\S*\/(?=[^\s/]+(\s|$))/, "");
  return shown.length > 50 ? `${shown.slice(0, 49)}…` : shown;
}

/** Compiles wake_on, accepting Python's (?i) prefix that models often write but JavaScript only takes as a flag. */
function wakePattern(source: string): RegExp {
  const insensitive = source.startsWith("(?i)");
  return new RegExp(insensitive ? source.slice(4) : source, insensitive ? "i" : "");
}

/** Carries the managed job when the bash operations below hand off the same execution. */
class MovedToBackground extends Error {
  constructor(readonly job: Job) {
    super(`moved to background as ${job.id}`);
  }
}

class PiBackgroundExtension {
  private readonly supervisor: JobSupervisor;
  private turn = 0;
  private readonly hinted = new Map<string, () => void>();
  private redrawJobs = () => {};

  constructor(pi: ExtensionAPI) {
    const activeWaits = new Map<Job, number>();
    const handledCompletions = new WeakSet<Job>();
    const notifyCompletion = async (job: Job) => {
      if (activeWaits.has(job) || handledCompletions.has(job)) return;
      const output = await this.supervisor.tail(job);
      // A wait may start or return completion while the notification reads the tail.
      if (!this.supervisor.jobs.has(job.id) || activeWaits.has(job) || handledCompletions.has(job)) return;
      handledCompletions.add(job);
      report(
        job,
        `Background job finished: ${summary(job, shownCommand(job.command))}\nLast lines:\n${shownOutput(output)}`,
        {
          headline: `${job.id} ${job.status === "exited" ? `exited ${job.exitCode}` : job.status} · ${elapsed(job)}`,
          last: output.text.split("\n").at(-1) || "(no output)",
          error: job.status !== "exited" || job.exitCode !== 0,
        },
      );
    };
    this.supervisor = new JobSupervisor({
      displayLine: (data) =>
        data
          .toString("utf8")
          .split("\n")
          .map(cleanLine)
          .filter((line) => line.trim())
          .at(-1)
          ?.trim(),
      changed: () => showJobs(),
      output: (id) => {
        const mode = (pi.getSettings() as { background?: { output?: string } }).background?.output ?? "file";
        if (mode === "memory") return new MemoryJobOutput();
        if (mode === "file") return new FileJobOutput(join(tmpdir(), "pi-bg", `${process.pid}-${id}.log`));
        throw new Error("background.output must be file or memory");
      },
      completed: notifyCompletion,
    });
    const supervisor = this.supervisor;
    const jobs = supervisor.jobs;
    const thisTurn = () => this.turn;
    const handoff = this.handoff.bind(this);

    // While Pi is working, the message is steered in before its next step instead of following up after the whole run,
    // which for a long run left results hours late and woke Pi once per stale message when the run ended
    const wake = (content: string, details: { headline: string; last: string; error: boolean }, triggerTurn = true) =>
      pi.sendMessage(
        { customType: "background-job", content, display: true, details },
        { triggerTurn, deliverAs: "steer" },
      );

    // Jobs started in the same turn usually belong together, like several benchmarks to compare. While some of them
    // still run, a successful one's result is added to the conversation without waking Pi, so it answers once at the
    // end instead of after each job. A job that runs on too long doesn't hold the others back for more than GROUP_HOLD_MS.
    pi.on("turn_start", async () => {
      this.turn++;
    });
    const holds = new Map<number, NodeJS.Timeout>();
    const runningInGroup = (job: Job) =>
      [...jobs.values()].filter(
        (other) => other !== job && other.group === job.group && other.status === "running" && !other.watched,
      );
    const report = (job: Job, content: string, details: { headline: string; last: string; error: boolean }) => {
      const others = job.watched ? [] : runningInGroup(job);
      // Only Pi stops jobs, with bg_kill, so it already knows; the message is added without waking it again
      if (job.status === "killed") {
        if (others.length === 0) {
          clearTimeout(holds.get(job.group));
          holds.delete(job.group);
        }
        return wake(content, details, false);
      }
      // A failure wakes Pi straight away, so it can react before the rest of the group finishes
      if (others.length === 0 || details.error) {
        clearTimeout(holds.get(job.group));
        holds.delete(job.group);
        return wake(content, details);
      }
      wake(
        `${content}\n(Still running from the same turn: ${others.map((other) => other.id).join(", ")}; you'll be woken when they finish.)`,
        details,
        false,
      );
      if (holds.has(job.group)) return;
      holds.set(
        job.group,
        setTimeout(() => {
          holds.delete(job.group);
          const still = runningInGroup(job);
          if (still.length === 0) return;
          wake(
            `Background jobs from the same turn are still running after ${GROUP_HOLD_MS / 60_000} minutes: ${still.map((other) => other.id).join(", ")}. The results of the ones that finished are above; you'll get a message when each of these finishes.`,
            {
              headline: `${still.map((other) => other.id).join(", ")} still running`,
              last: "",
              error: false,
            },
          );
        }, GROUP_HOLD_MS),
      );
    };

    // Wakes the agent with output lines matching pattern, batched per second and capped per job
    const watcher = (job: Job, pattern: RegExp) => {
      let partial = "";
      let pending: string[] = [];
      let timer: NodeJS.Timeout | undefined;
      let wakes = 0;
      const flush = () => {
        timer = undefined;
        // Once the job has ended, its final message carries the log tail instead
        if (job.status !== "running") return;
        wakes++;
        const capped =
          wakes === MAX_WAKES
            ? `\n(Reached ${MAX_WAKES} wake-ups; further matches are ignored, use bg_status to check.)`
            : "";
        wake(
          `Background job ${job.id} output matched /${pattern.source}/ (still running):\n${pending.slice(-UI_TAIL_LINES).join("\n")}${capped}`,
          {
            headline: `${job.id} matched /${pattern.source}/`,
            last: pending[pending.length - 1] ?? "",
            error: false,
          },
        );
        pending = [];
      };
      return (data: Buffer) => {
        if (wakes >= MAX_WAKES) return;
        const lines = (partial + data.toString("utf8")).split(/\r?\n|\r/);
        partial = lines.pop() ?? "";
        const hits = lines.filter((line) => pattern.test(line));
        if (hits.length === 0) return;
        pending.push(...hits);
        if (timer === undefined) timer = setTimeout(flush, WAKE_DEBOUNCE_MS);
      };
    };

    // One line per running job above the input, with its elapsed time and latest output
    const running = () => [...jobs.values()].filter((job) => job.status === "running");
    // The job open in /bg, left out of the jobs line meanwhile so it isn't shown twice
    let viewing: Job | undefined;
    // "full" (the default), "compact" without the output, or "off", set with "background": { "jobs": ... } in pi's settings.json
    const jobsLine = () => (pi.getSettings() as { background?: { jobs?: string } }).background?.jobs ?? "full";
    // The widget is set once per session and redrawn in place: setting it again would move it below the widgets other
    // extensions added since, while running jobs belong at the top, next to what Pi is doing now

    let ticker: NodeJS.Timeout | undefined;
    const showJobs = () => {
      // A running job's elapsed time and latest output change every second
      if (running().length > 0) ticker ??= setInterval(() => this.redrawJobs(), 1000);
      else {
        clearInterval(ticker);
        ticker = undefined;
      }
      this.redrawJobs();
    };
    // Running bash commands that ctrl+b can move to the background now, by tool call id, once they have run for
    // HINT_AFTER_MS. Shared so pi-polish can show the hint under the command's row instead of in the jobs line.
    const hinted = this.hinted;
    globals[Symbol.for("pi-background.movable")] = hinted;
    let stopCtrlB = () => {};
    const jobsWidget = (theme: Theme) => ({
      invalidate() {},
      render(width: number) {
        if (jobsLine() === "off") return [];
        const live = running().filter((job) => job !== viewing);
        const silentFor = (job: Job) => Date.now() - (job.lastOutput ?? job.started);
        let lines: string[];
        if (live.length <= MAX_SHOWN_JOBS) {
          lines = live.map((job) => {
            const silent = silentFor(job);
            const detail =
              silent >= SILENT_AFTER_MS
                ? ` · no output for ${duration(silent)}`
                : jobsLine() === "full" && job.lastLine
                  ? ` · ${job.lastLine}`
                  : "";
            const text =
              theme.fg("accent", "⏵ ") +
              theme.fg("toolTitle", `${job.id} ${shownCommand(job.command)}`) +
              theme.fg("dim", ` · ${elapsed(job)}${detail}`);
            return truncateToWidth(text, width);
          });
        } else {
          // Past a few jobs, a line each crowds the input, so they share one with just the count, and a warning when
          // some have gone quiet, since they may be stuck; /bg has the rest
          const silent = live.filter((job) => silentFor(job) >= SILENT_AFTER_MS).length;
          const warning = silent ? theme.fg("warning", ` · ${silent} silent for ${SILENT_AFTER_MS / 60_000}m+`) : "";
          lines = [
            truncateToWidth(theme.fg("accent", "⏵ ") + theme.fg("toolTitle", `${live.length} jobs`) + warning, width),
          ];
        }
        if (hinted.size > 0 && !globals[Symbol.for("pi-polish.showsMoveHint")])
          lines.push(theme.fg("dim", "  ctrl+b to run in background"));
        return lines;
      },
    });

    const find = (id: string): Job => {
      const job = jobs.get(id);
      if (!job) throw new Error(`No background job ${id}; known: ${[...jobs.keys()].join(", ") || "none"}`);
      return job;
    };

    // Compact, Claude-Code-style rows instead of pi's default boxed tool and message rendering: quiet grey once done,
    // with a dot only while running or when something failed
    // "  └ text" in dim, with long and extra lines wrapped under the text instead of at the left edge
    const branch = (theme: Theme, text: string, head?: string) => ({
      invalidate() {},
      render: (width: number) => [
        ...(head ? [truncateToWidth(head, width)] : []),
        ...wrapTextWithAnsi(text, Math.max(10, width - 4)).map((line, i) =>
          theme.fg("dim", `${i === 0 ? "  └ " : "    "}${line}`),
        ),
      ],
    });
    pi.registerMessageRenderer("background-job", (message, { expanded }, theme) => {
      const d = (message.details ?? {}) as { headline?: string; last?: string; error?: boolean };
      const title = `Background ${d.headline ?? ""}`;
      const head = d.error ? theme.fg("error", "● ") + theme.fg("toolTitle", title) : `  ${theme.fg("dim", title)}`;
      return branch(theme, expanded ? String(message.content) : (d.last ?? ""), head);
    });
    // One line, like pi-polish's shell rows; expanded (ctrl+o) shows the whole text, wrapped under the row
    const row = (theme: Theme, text: string, context: RenderContext, full = text) => ({
      invalidate() {},
      render(width: number) {
        const color = context.isError ? "error" : context.executionStarted && context.isPartial ? "accent" : undefined;
        const mark = color ? theme.fg(color, "● ") : "  ";
        const paint = (line: string) => theme.fg(color ? "toolTitle" : "dim", line);
        if (!context.expanded) return [mark + paint(truncateToWidth(text, Math.max(10, width - 2)))];
        return wrapTextWithAnsi(full, Math.max(10, width - 2)).map((line, i) => (i === 0 ? mark : "  ") + paint(line));
      },
    });
    const note = (theme: Theme, result: AgentToolResult<unknown>, expanded: boolean) => {
      const text = result.content?.map((c) => (c.type === "text" ? c.text : "")).join("\n") ?? "";
      // Collapsed: first sentence only ("Started bg1"), without the log path
      const short = text.split("\n")[0].split(";")[0];
      return branch(theme, expanded ? text : short);
    };

    // Only Pi's own bash is wrapped; one that another extension replaced, such as a sandbox's, is left alone. By
    // session_start every extension has registered its tools, whichever order they loaded in.
    let wrapped = false;
    pi.on("session_start", async () => {
      if (
        wrapped ||
        !pi
          .getAllTools()
          .find((tool) => tool.name === "bash")
          ?.sourceInfo.path.startsWith("builtin:")
      )
        return;
      wrapped = true;
      const pisBash = createBashToolDefinition(process.cwd());
      pi.registerTool({
        ...pisBash,
        outputSchema: Type.Union([pisBash.outputSchema ?? Type.Unknown(), jobOutputSchema]),
        promptGuidelines: [
          ...(pisBash.promptGuidelines ?? []),
          `A bash command still running after ${AUTO_BACKGROUND_SECS} seconds, or after its timeout if that is shorter, moves to the background on its own, as if started with bg_run, and you get its job id instead of its output; it is not stopped. Still start a command you expect to take that long with bg_run, so you choose wake_on and the turn isn't held up first.`,
        ],
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          // Built per call from the same settings Pi builds its own bash from
          const { shellPath, shellCommandPrefix } = pi.getSettings();
          const bash = createBashToolDefinition(ctx.cwd, {
            commandPrefix: shellCommandPrefix,
            operations: handoff(createLocalBashOperations({ shellPath }), toolCallId, ctx.signal),
          });
          try {
            return await bash.execute(toolCallId, params, signal, onUpdate, ctx);
          } catch (err) {
            if (!(err instanceof MovedToBackground)) throw err;
            const { id, log, started } = err.job;
            const output = await supervisor.tail(err.job);
            const text = `Still running after ${duration(Date.now() - started)}, so it moved to the background as ${id}. You will be notified when it exits; check it with bg_status, or stop it with bg_kill if it shouldn't take this long.\nOutput so far:\n${shownOutput(output)}\n${log ? `log: ${log}` : "output: memory"}`;
            return {
              content: [{ type: "text", text }],
              details: undefined,
              structuredContent: err.job.snapshot(Date.now(), output.text, output.truncated),
            };
          }
        },
      });
    });

    pi.registerTool({
      name: "bg_run",
      label: "Background",
      outputSchema: jobOutputSchema,
      description:
        "Start a shell command in the background and return immediately with a job id. Combined stdout/stderr goes to the configured output store. " +
        "When the command exits you automatically receive a message with its exit code and the last log lines, so do not poll or sleep waiting for it.",
      promptSnippet: "Run long shell commands (downloads, builds, long test suites) in the background",
      promptGuidelines: [
        "Use bg_run instead of bash for any command that may take longer than about 30 seconds, in particular: downloading large files, datasets, dumps or model weights; " +
          "installing heavy packages (torch, tensorflow, CUDA libraries, transformers, large requirement sets) or creating environments with them; cloning large repositories; " +
          "builds, compiles and docker builds; full test suites of non-trivial projects; training, evaluation, benchmark and data-processing scripts; and anything that sleeps, waits or polls.",
        "Run quick checks, short scripts and test files that likely finish within a minute with bash, even when you're not sure: their result is needed now, and each bg_run job reports back as a separate message.",
        "After bg_run, continue with independent work or end your turn; a message with the exit code and log tail arrives automatically when the job exits, so never sleep, poll or tail the log to wait for it.",
        "Keep using bash for quick commands whose output you need right away, such as git, ls, cat, grep, find, file inspection and short checks.",
        "Pass wake_on only when you must act before a bg_run job ends, such as a server becoming ready to test against, or when the user asked to follow its progress. Make it a pattern for that one event, which matches once, not a line the job prints for every item, file, epoch or step. To report a job's result, leave wake_on out: the exit message already brings the exit code and last lines.",
        "Don't redirect a bg_run command's output (> file, 2>&1, nohup): capture already handles it, and redirecting hides progress from the user and wake_on. File capture retains a log; memory capture retains a bounded tail.",
        "bg_run starts only after the other tool calls in the same reply have finished, so editing a file and starting a job that uses it in one reply is safe.",
        "Use bg_status to check progress of a bg_run job and bg_kill to stop one.",
        "Unless the user explicitly asks for that bash command, never wait, poll or sleep in bash (while/until loops with sleep, watch, repeated status checks), not even as part of a larger command; start the wait with bg_run and pass wake_on to be woken when the awaited output appears.",
        "Unless the user explicitly asks otherwise, start long-running processes (training or evaluation runs, servers, watchers) with bg_run, not with & or nohup in bash followed by sleep.",
      ],
      // Runs after the edits in the same reply, so the job starts from the code pi just wrote
      executionMode: "sequential",
      renderShell: "self",
      renderCall: (args, theme, context) => {
        const command = String(args?.command ?? "");
        // Collapsed, without leading settings such as PYTHONPATH=/some/src, like the jobs line; ctrl+o shows them
        const short = shortCommand(command, args?.cwd ?? process.cwd()).replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, "");
        return row(theme, `Background $ ${short}`, context, `Background $ ${command.trim()}`);
      },
      renderResult: (result, { expanded }, theme) => note(theme, result, expanded),
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to run" }),
        cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the session cwd)" })),
        wake_on: Type.Optional(
          Type.String({
            description: `Regex; also wake you while the job runs whenever an output line matches, e.g. 'listening on|ready'. Matches within a second are batched; at most ${MAX_WAKES} wake-ups per job.`,
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const owner = ctx.signal;
        owner?.throwIfAborted();
        const pattern = params.wake_on ? wakePattern(params.wake_on) : undefined;
        const controller = new AbortController();
        // The same shell and command prefix as Pi's own bash, from settings.json; without shellPath, Windows can pick WSL's bash
        const { shellPath, shellCommandPrefix } = pi.getSettings();
        const ops = createLocalBashOperations({ shellPath });
        // Output goes to a pipe, where Python would buffer prints until it exits; unbuffered, the latest line and wake_on stay live
        const command = `export PYTHONUNBUFFERED=1; ${params.command}`;
        const job = supervisor.start({
          command: params.command,
          group: thisTurn(),
          watched: Boolean(pattern),
          controller,
          run: (onData) =>
            ops.exec(shellCommandPrefix ? `${shellCommandPrefix}\n${command}` : command, params.cwd ?? ctx.cwd, {
              onData,
              signal: controller.signal,
            }),
          observe: pattern ? (job) => watcher(job, pattern) : undefined,
        });
        const releaseOwner = forwardAbort(owner, controller);
        supervisor.onComplete(job, releaseOwner);
        const { id, log } = job;
        return {
          content: [
            {
              type: "text",
              text: `Started ${id}; ${log ? `log: ${log}` : "output captured in memory"}. You will be notified when it exits.`,
            },
          ],
          details: { id, log },
          structuredContent: job.snapshot(Date.now()),
        };
      },
    });

    pi.registerTool({
      name: "bg_status",
      label: "Background status",
      outputSchema: Type.Object({ jobs: Type.Array(jobOutputSchema) }),
      description:
        "List background jobs, or show one job's state and captured output. Omit lines and max_bytes for the default tail; output_truncated reports omitted output.",
      renderShell: "self",
      renderCall: (args, theme, context) => row(theme, `Background status ${args?.id ?? "(all)"}`, context),
      renderResult: (result, { expanded }, theme) => note(theme, result, expanded),
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Job id such as bg1; omit to list all jobs" })),
        lines: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: `Maximum output lines (default ${DEFAULT_TAIL_LIMITS.maxLines}); also bounded by max_bytes`,
          }),
        ),
        max_bytes: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: `Maximum output bytes (default ${DEFAULT_TAIL_LIMITS.maxBytes}); also bounded by lines`,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        if (!params.id) {
          const text = [...jobs.values()].map((job) => summary(job)).join("\n") || "No background jobs.";
          return {
            content: [{ type: "text", text }],
            details: {},
            structuredContent: { jobs: [...jobs.values()].map((job) => job.snapshot(Date.now())) },
          };
        }
        const job = find(params.id);
        const output = await supervisor.tail(job, tailLimits({ maxLines: params.lines, maxBytes: params.max_bytes }));
        return {
          content: [{ type: "text", text: `${summary(job)}\n${shownOutput(output)}` }],
          details: {},
          structuredContent: { jobs: [job.snapshot(Date.now(), output.text, output.truncated)] },
        };
      },
    });

    pi.registerTool({
      name: "bg_wait",
      label: "Background wait",
      description:
        "Wait for a background job to finish, up to timeout seconds. Wait expiry does not stop the command; use the same id to wait again or bg_kill to stop it.",
      outputSchema: Type.Object({ ...jobOutputSchema.properties, wait_timed_out: Type.Boolean() }),
      renderShell: "self",
      renderCall: (args, theme, context) => row(theme, `Background wait ${args?.id ?? ""}`, context),
      renderResult: (result, { expanded }, theme) => note(theme, result, expanded),
      parameters: Type.Object({
        id: Type.String({ description: "Job id such as bg1" }),
        timeout: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: MAX_WAIT_SECS,
            description: `Maximum wait in seconds (default ${DEFAULT_WAIT_SECS}, max ${MAX_WAIT_SECS}); zero checks immediately`,
          }),
        ),
        lines: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: `Maximum output lines (default ${DEFAULT_TAIL_LIMITS.maxLines}); also bounded by max_bytes`,
          }),
        ),
        max_bytes: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: `Maximum output bytes (default ${DEFAULT_TAIL_LIMITS.maxBytes}); also bounded by lines`,
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const job = find(params.id);
        activeWaits.set(job, (activeWaits.get(job) ?? 0) + 1);
        try {
          const completed = await supervisor.wait(job, params.timeout ?? DEFAULT_WAIT_SECS, signal);
          const output = await supervisor.tail(job, tailLimits({ maxLines: params.lines, maxBytes: params.max_bytes }));
          signal?.throwIfAborted();
          const text = `${summary(job)}\n${shownOutput(output)}${completed ? "" : "\nWait expired before completion was observed. Wait again with bg_wait or stop it with bg_kill."}`;
          if (completed) handledCompletions.add(job);
          return {
            content: [{ type: "text", text }],
            details: {},
            structuredContent: {
              ...job.snapshot(Date.now(), output.text, output.truncated),
              wait_timed_out: !completed,
            },
          };
        } finally {
          const remaining = (activeWaits.get(job) ?? 0) - 1;
          if (remaining > 0) activeWaits.set(job, remaining);
          else {
            activeWaits.delete(job);
            // Expired or cancelled observers must not consume an otherwise undelivered completion.
            if (job.phase === "complete") void notifyCompletion(job);
          }
        }
      },
    });

    pi.registerTool({
      name: "bg_kill",
      label: "Background kill",
      outputSchema: Type.Object({ ...jobOutputSchema.properties, stop_requested: Type.Boolean() }),
      description: "Stop a running background job and its child processes.",
      renderShell: "self",
      renderCall: (args, theme, context) => row(theme, `Background kill ${args?.id ?? ""}`, context),
      renderResult: (result, { expanded }, theme) => note(theme, result, expanded),
      parameters: Type.Object({ id: Type.String({ description: "Job id such as bg1" }) }),
      async execute(_toolCallId, params) {
        const job = find(params.id);
        if (job.status !== "running")
          return {
            content: [{ type: "text", text: `${job.id} already ${job.status}` }],
            details: {},
            structuredContent: { ...job.snapshot(Date.now()), stop_requested: false },
          };
        supervisor.stop(job);
        return {
          content: [{ type: "text", text: `Stopping ${job.id}` }],
          details: {},
          structuredContent: { ...job.snapshot(Date.now()), stop_requested: true },
        };
      },
    });

    // Shows a job's latest output in place of the input until esc, refreshed every second while it runs
    const showJob = async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      const all = [...jobs.values()].reverse();
      if (all.length === 0) return ctx.ui.notify("No background jobs yet", "info");
      // "/bg 2" works as well as "/bg bg2"
      const wanted = args
        .trim()
        .toLowerCase()
        .replace(/^(\d+)$/, "bg$1");
      let job = wanted ? jobs.get(wanted) : all.length === 1 ? all[0] : undefined;
      if (wanted && !job)
        return ctx.ui.notify(`No background job ${args.trim()}; there's ${[...jobs.keys()].join(", ")}`, "warning");
      if (!job) {
        // Running jobs first, then the latest finished ones
        const listed = [
          ...all.filter((other) => other.status === "running"),
          ...all.filter((other) => other.status !== "running").slice(0, MAX_LISTED_FINISHED),
        ];
        // Matched by position, since the elapsed time in a label changes while the list is open
        // Ids and commands padded to one width, so the states and times line up
        const idWidth = Math.max(...listed.map((other) => other.id.length));
        const commandWidth = Math.max(...listed.map((other) => shownCommand(other.command).length));
        const options = listed.map(
          (other) =>
            `${other.id.padEnd(idWidth)} ${shownCommand(other.command).padEnd(commandWidth)} · ${state(other)} · ${elapsed(other)}`,
        );
        job = listed[options.indexOf((await ctx.ui.select("Background jobs", options)) ?? "")];
        if (!job) return;
      }
      const shown = job;
      viewing = shown;
      const log = shown.log?.replace(homedir(), "~") ?? "memory capture";
      try {
        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
          let output = "(loading output)";
          let closed = false;
          let reading = false;
          const refresh = async () => {
            if (reading || closed) return;
            reading = true;
            try {
              const lines = Math.max(3, Math.min(UI_TAIL_LINES, Math.floor(tui.terminal.rows / 2)));
              const captured = await supervisor.tail(shown, { maxLines: lineCount(lines) });
              if (!closed) {
                output = shownOutput(captured);
                tui.requestRender();
              }
            } finally {
              reading = false;
            }
          };
          void refresh();
          const timer = setInterval(() => {
            void refresh();
          }, 1000);
          return {
            dispose: () => {
              closed = true;
              clearInterval(timer);
            },
            invalidate() {},
            handleInput: (data: string) => {
              if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") done();
            },
            render(width: number) {
              const color =
                shown.status === "running"
                  ? "accent"
                  : shown.status === "exited" && shown.exitCode === 0
                    ? "success"
                    : "error";
              const title =
                theme.fg(color, " ● ") + theme.fg("toolTitle", `${shown.id} ${shownCommand(shown.command)}`);
              const status = theme.fg("muted", `${state(shown)} · ${elapsed(shown)} `);
              const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(status));
              // At most half the terminal, so the conversation above stays in view
              const lines =
                output === "(no output)"
                  ? [theme.fg("dim", theme.italic("   no output yet"))]
                  : output.split("\n").map((line) => `   ${cleanLine(line)}`);
              return [
                theme.fg("borderMuted", "─".repeat(width)),
                title + " ".repeat(gap) + status,
                ...lines,
                theme.fg("dim", ` esc to close · ${log}`),
                theme.fg("borderMuted", "─".repeat(width)),
              ].map((line) => truncateToWidth(line, width));
            },
          };
        });
      } finally {
        viewing = undefined;
      }
    };
    pi.registerCommand("reap", {
      description: "Request a stop for all tracked running background jobs",
      handler: async (_args, ctx) => {
        const live = running();
        for (const job of live) this.supervisor.stop(job);
        if (ctx.hasUI)
          ctx.ui.notify(
            live.length ? `Stopping ${live.map((job) => job.id).join(", ")}` : "No running background jobs",
            "info",
          );
      },
    });

    pi.registerCommand("bg", {
      description: "Show a background job's latest output",
      getArgumentCompletions: (prefix) => {
        const matching = [...jobs.values()].filter((job) => job.id.startsWith(prefix.trim().toLowerCase()));
        return matching.length
          ? matching.map((job) => ({
              value: job.id,
              label: job.id,
              description: `${shownCommand(job.command)} · ${state(job)}`,
            }))
          : null;
      },
      handler: showJob,
    });
    // "/bg3" without the space isn't a command, so pi would send it to the model as a message; open the job instead
    pi.on("input", async (event, ctx) => {
      const id = event.text.trim().match(/^\/(bg\d+)$/i)?.[1];
      if (!id || !jobs.has(id.toLowerCase())) return { action: "continue" };
      await showJob(id, ctx);
      return { action: "handled" };
    });

    // After /reload or a resume, carry on after the ids already in the conversation so "bg3" keeps meaning one job
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.mode === "tui") {
        ctx.ui.setWidget("background-jobs", (tui, theme) => {
          this.redrawJobs = () => tui.requestRender();
          return jobsWidget(theme);
        });
        // ctrl+b moves running bash commands to the background; otherwise it stays the editor's cursor-left
        stopCtrlB();
        stopCtrlB = ctx.ui.onTerminalInput((data) => {
          if (hinted.size === 0 || !matchesKey(data, Key.ctrl("b"))) return undefined;
          for (const move of [...hinted.values()]) move();
          return { consume: true };
        });
      }
      for (const entry of ctx.sessionManager.getBranch()) {
        const msg = entry.type === "message" ? entry.message : undefined;
        const details =
          msg?.role === "toolResult" && msg.toolName === "bg_run"
            ? (msg.details as { id?: unknown } | undefined)
            : undefined;
        const n = Number(/^bg(\d+)$/.exec(String(details?.id))?.[1]);
        this.supervisor.reserveId(n);
      }
    });

    pi.on("session_shutdown", async () => {
      clearInterval(ticker);
      for (const timer of holds.values()) clearTimeout(timer);
      holds.clear();
      this.supervisor.shutdown();
    });
  }

  // Pi's bash, except that a command still running after AUTO_BACKGROUND_SECS becomes a background job
  // instead of blocking the turn until it ends or times out. The command keeps running in the same
  // process; its output so far goes to the job's capture store, and Pi gets the usual message when it exits.
  private handoff(local: BashOperations, toolCallId: string, owner?: AbortSignal): BashOperations {
    return {
      exec: (command, cwd, options) => {
        // Pi's own check, which its exec would otherwise have made
        if (options.timeout !== undefined && !(Number.isFinite(options.timeout) && options.timeout > 0)) {
          return Promise.reject(new Error("Invalid timeout: must be a finite number of seconds"));
        }
        const started = Date.now();
        const controller = new AbortController();
        // The captured run signal remains connected after the launch call returns.
        const releaseOwner = forwardAbort(owner, controller);
        const foreground = options.signal === owner ? undefined : options.signal;
        const forward = () => controller.abort();
        if (foreground?.aborted) controller.abort();
        foreground?.addEventListener("abort", forward, { once: true });
        // Keep a bounded prefix buffer until the same execution moves to a capture store.
        let earlier = Buffer.alloc(0);
        let earlierTruncated = false;
        let lastOutput: number | undefined;
        let sink = (d: Buffer) => {
          earlierTruncated ||= earlier.length + d.length > HANDOFF_BYTES;
          earlier = Buffer.from(Buffer.concat([earlier, d]).subarray(-HANDOFF_BYTES));
          while (earlierTruncated && earlier.length && (earlier[0] & 0xc0) === 0x80) earlier = earlier.subarray(1);
          lastOutput = Date.now();
          options.onData(d);
        };
        const env = { ...(options.env ?? process.env), PYTHONUNBUFFERED: "1" };
        // A timeout moves the command to the background sooner rather than stopping it, so its work isn't lost
        const after = Math.min(options.timeout ?? AUTO_BACKGROUND_SECS, AUTO_BACKGROUND_SECS);
        const running = local.exec(command, cwd, { onData: (d) => sink(d), signal: controller.signal, env });
        return new Promise((resolve, reject) => {
          let moved = false;
          let timer: NodeJS.Timeout | undefined;
          let hint: NodeJS.Timeout | undefined;
          const settle = () => {
            clearTimeout(timer);
            clearTimeout(hint);
            foreground?.removeEventListener("abort", forward);
            if (this.hinted.delete(toolCallId)) this.redrawJobs();
          };
          const move = () => {
            if (moved) return;
            moved = true;
            settle();
            const output = earlier;
            try {
              const job = this.supervisor.start({
                command,
                group: this.turn,
                watched: false,
                controller,
                run: (onData) => {
                  sink = onData;
                  return running;
                },
                earlier: { started, output, lastOutput, truncated: earlierTruncated },
              });
              reject(new MovedToBackground(job));
            } catch (error) {
              controller.abort();
              // No handle was returned; observe execution cleanup before reporting capture setup failure.
              void running.then(
                () => reject(error),
                () => reject(error),
              );
            }
          };
          timer = setTimeout(move, after * 1000);
          hint = setTimeout(() => {
            this.hinted.set(toolCallId, move);
            this.redrawJobs();
          }, HINT_AFTER_MS);
          running
            .then(
              (value) => {
                if (!moved) resolve(value);
              },
              (error) => {
                if (!moved) reject(error);
              },
            )
            .finally(() => {
              settle();
              releaseOwner();
            });
        });
      },
    };
  }
}

export default function (pi: ExtensionAPI) {
  new PiBackgroundExtension(pi);
}
