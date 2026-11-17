import { addAbortListener, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Job } from "./job.ts";
import type { JobOutputStore, OutputTail, TailLimits } from "./output-store.ts";

export function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal?.aborted) controller.abort();
  const binding = signal && !signal.aborted ? addAbortListener(signal, () => controller.abort()) : undefined;
  return () => binding?.[Symbol.dispose]();
}

interface Execution {
  controller: AbortController;
  completion: EventTarget;
  output: JobOutputStore;
  outputError?: Error;
  prefixTruncated: boolean;
}

interface StartOptions {
  command: string;
  group: number;
  watched: boolean;
  controller: AbortController;
  run: (onData: (data: Buffer) => void) => Promise<{ exitCode: number | null }>;
  earlier?: { started: number; output: Buffer; lastOutput?: number; truncated?: boolean };
  observe?: (job: Job) => (data: Buffer) => void;
}

/** Owns execution controls and wait observations. Job owns transitions; the output store owns capture. */
export class JobSupervisor {
  private readonly tracked = new Map<string, Job>();
  private readonly executions = new WeakMap<Job, Execution>();
  private next = 1;
  private readonly createOutput: (id: string) => JobOutputStore;
  private readonly displayLine: (data: Buffer) => string | undefined;
  private readonly changed: () => void;
  private readonly completed: (job: Job) => void | Promise<void>;

  constructor(callbacks: {
    output: (id: string) => JobOutputStore;
    displayLine: (data: Buffer) => string | undefined;
    changed: () => void;
    completed: (job: Job) => void | Promise<void>;
  }) {
    this.createOutput = callbacks.output;
    this.displayLine = callbacks.displayLine;
    this.changed = callbacks.changed;
    this.completed = callbacks.completed;
  }

  get jobs(): ReadonlyMap<string, Job> {
    return this.tracked;
  }

  reserveId(id: number): void {
    if (id >= this.next) this.next = id + 1;
  }

  start({ command, group, watched, controller, run, earlier, observe }: StartOptions): Job {
    const id = `bg${this.next++}`;
    const output = this.createOutput(id);
    const job = new Job({
      id,
      command,
      log: output.log,
      group,
      watched,
      started: earlier?.started ?? Date.now(),
      lastOutput: earlier?.lastOutput,
    });
    const execution: Execution = {
      controller,
      completion: new EventTarget(),
      output,
      prefixTruncated: earlier?.truncated ?? false,
    };
    this.tracked.set(id, job);
    this.executions.set(job, execution);
    const stop = () => {
      job.requestStop();
    };
    if (controller.signal.aborted) stop();
    const stopBinding = addAbortListener(controller.signal, stop);
    const watch = observe?.(job);
    const onData = (data: Buffer, at = Date.now()) => {
      // Pi's push-only onData callback cannot pause its source when a writable applies backpressure.
      output.writable.write(data);
      watch?.(data);
      job.output(this.displayLine(data), at);
    };
    if (earlier?.output.length) onData(earlier.output, earlier.lastOutput);

    void (async () => {
      try {
        const { exitCode } = await run(onData);
        job.settle({ exitCode }, Date.now());
      } catch (error) {
        job.settle({ error: true }, Date.now());
        output.writable.write(`\n[bg] ${error instanceof Error ? error.message : String(error)}\n`);
      }
      stopBinding[Symbol.dispose]();
      this.changed();
      try {
        await output.finish();
      } catch (error) {
        execution.outputError = error instanceof Error ? error : new Error(String(error));
      }
      job.flushed(!execution.outputError);
      execution.completion.dispatchEvent(new Event("complete"));
      if (this.tracked.has(id)) await this.completed(job);
      else await this.dispose(execution);
    })();
    this.changed();
    return job;
  }

  async tail(job: Job, limits?: Partial<TailLimits>): Promise<OutputTail> {
    const execution = this.execution(job);
    try {
      if (execution.outputError) throw execution.outputError;
      const result = await execution.output.tail(limits);
      return { ...result, truncated: result.truncated || execution.prefixTruncated };
    } catch (error) {
      return {
        text: `[bg] Output capture unavailable: ${error instanceof Error ? error.message : String(error)}`,
        truncated: true,
      };
    }
  }

  onComplete(job: Job, listener: () => void): void {
    if (job.phase === "complete") listener();
    else this.execution(job).completion.addEventListener("complete", listener, { once: true });
  }

  stop(job: Job): boolean {
    if (!job.requestStop()) return false;
    this.execution(job).controller.abort();
    return true;
  }

  async wait(job: Job, timeout: number, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (job.phase === "complete") return true;
    const cleanup = new AbortController();
    const observer = signal ? AbortSignal.any([signal, cleanup.signal]) : cleanup.signal;
    try {
      return await Promise.race([
        once(this.execution(job).completion, "complete", { signal: observer }).then(() => true),
        delay(timeout * 1000, false, { signal: observer }),
      ]);
    } finally {
      // Release the losing observation without stopping the execution.
      cleanup.abort();
    }
  }

  shutdown(): void {
    for (const job of this.tracked.values()) {
      this.stop(job);
      if (job.phase === "complete") void this.dispose(this.execution(job));
    }
    this.tracked.clear();
  }

  private async dispose(execution: Execution): Promise<void> {
    try {
      await execution.output.dispose();
    } catch (error) {
      execution.outputError ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  private execution(job: Job): Execution {
    const execution = this.executions.get(job);
    if (!execution) throw new Error(`Job ${job.id} does not belong to this supervisor`);
    return execution;
  }
}
