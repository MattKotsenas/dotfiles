export const JOB_STATES = ["running", "exited", "killed", "failed"] as const;

type Result =
  | { status: "exited"; exitCode: number | null }
  | { status: "failed"; exitCode?: number | null }
  | { status: "killed"; exitCode?: undefined };
type Execution = { phase: "running" } | { phase: "flushing" | "complete"; result: Result; ended: number };

interface JobOptions {
  id: string;
  command: string;
  log: string | null;
  started: number;
  group: number;
  watched: boolean;
  lastOutput?: number;
}

/** Execution settles before its output log finishes flushing. Only the latter completes a wait. */
export class Job {
  readonly id: string;
  readonly command: string;
  readonly log: string | null;
  readonly started: number;
  readonly group: number;
  readonly watched: boolean;
  private execution: Execution = { phase: "running" };
  private stopping = false;
  private latestOutput?: number;
  private latestLine?: string;

  constructor(options: JobOptions) {
    this.id = options.id;
    this.command = options.command;
    this.log = options.log;
    this.started = options.started;
    this.group = options.group;
    this.watched = options.watched;
    this.latestOutput = options.lastOutput;
  }

  get phase() {
    return this.execution.phase;
  }
  get status(): (typeof JOB_STATES)[number] {
    return this.execution.phase === "running" ? "running" : this.execution.result.status;
  }
  get exitCode() {
    return this.execution.phase === "running" ? undefined : this.execution.result.exitCode;
  }
  get ended() {
    return this.execution.phase === "complete" ? this.execution.ended : undefined;
  }
  get stopRequested() {
    return this.stopping;
  }
  get lastOutput() {
    return this.latestOutput;
  }
  get lastLine() {
    return this.latestLine;
  }

  requestStop(): boolean {
    if (this.execution.phase !== "running") return false;
    this.stopping = true;
    return true;
  }

  output(line: string | undefined, at: number): void {
    if (this.execution.phase !== "running") throw new Error("Cannot record output after execution settles");
    this.latestOutput = at;
    if (line) this.latestLine = line;
  }

  settle(outcome: { exitCode: number | null } | { error: true }, ended: number): void {
    if (this.execution.phase !== "running") throw new Error("Cannot settle execution twice");
    const result: Result =
      "exitCode" in outcome
        ? { status: "exited", exitCode: outcome.exitCode }
        : { status: this.stopping ? "killed" : "failed" };
    this.execution = { phase: "flushing", result, ended };
  }

  flushed(captured = true): void {
    if (this.execution.phase !== "flushing") throw new Error("Cannot flush before settlement or after completion");
    this.execution = {
      ...this.execution,
      phase: "complete",
      result: captured ? this.execution.result : { status: "failed", exitCode: this.execution.result.exitCode },
    };
  }

  snapshot(now: number, output = "", outputTruncated = false) {
    return {
      id: this.id,
      command: this.command,
      log: this.log,
      status: this.status,
      exit_code: this.exitCode ?? null,
      wall_time_seconds: Math.round(((this.ended ?? now) - this.started) / 100) / 10,
      output,
      output_truncated: outputTruncated,
    };
  }
}
