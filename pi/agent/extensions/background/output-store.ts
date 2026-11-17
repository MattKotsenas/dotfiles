import { createWriteStream, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";

declare const bytes: unique symbol;
declare const lines: unique symbol;
export type ByteCount = number & { readonly [bytes]: true };
export type LineCount = number & { readonly [lines]: true };

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

export function byteCount(value: number): ByteCount {
  return positiveInteger(value, "Byte count") as ByteCount;
}

export function lineCount(value: number): LineCount {
  return positiveInteger(value, "Line count") as LineCount;
}

export interface TailLimits {
  maxBytes: ByteCount;
  maxLines: LineCount;
}

export const DEFAULT_TAIL_LIMITS: Readonly<TailLimits> = Object.freeze({
  maxBytes: byteCount(64 * 1024),
  maxLines: lineCount(200),
});
export const DEFAULT_MEMORY_CAPACITY = byteCount(1024 * 1024);

export function tailLimits(options?: { maxBytes?: number; maxLines?: number }): TailLimits {
  return {
    maxBytes: byteCount(options?.maxBytes ?? DEFAULT_TAIL_LIMITS.maxBytes),
    maxLines: lineCount(options?.maxLines ?? DEFAULT_TAIL_LIMITS.maxLines),
  };
}

export interface OutputTail {
  text: string;
  truncated: boolean;
}

export interface JobOutputStore {
  readonly writable: Writable;
  readonly log: string | null;
  tail(limits?: Partial<TailLimits>): Promise<OutputTail>;
  finish(): Promise<void>;
  dispose(): Promise<void>;
}

function codepointStart(buffer: Buffer, offset: number): number {
  while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset++;
  return offset;
}

function formatTail(buffer: Buffer, prefixExcluded: boolean, limits: TailLimits): OutputTail {
  let start = Math.max(0, buffer.length - limits.maxBytes);
  let truncated = prefixExcluded || start > 0;
  // The retained suffix may start inside a UTF-8 codepoint. Raw write chunks are never decoded separately.
  if (truncated) start = codepointStart(buffer, start);
  let text = buffer.toString("utf8", start).trimEnd();
  // Malformed or incomplete UTF-8 can expand into three-byte replacement characters.
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length > limits.maxBytes) {
    text = encoded.toString("utf8", codepointStart(encoded, encoded.length - limits.maxBytes));
    truncated = true;
  }
  const outputLines = text.split("\n");
  if (outputLines.length > limits.maxLines) truncated = true;
  return { text: outputLines.slice(-limits.maxLines).join("\n"), truncated };
}

function outputFinisher(writable: Writable): () => Promise<void> {
  // Keep finished()'s error listener for errors before finish and writes attempted after disposal.
  const completion = finished(writable);
  // Capture can fail before its owner calls finish. That call still observes the original rejection.
  void completion.catch(() => {});
  return () => {
    if (!writable.writableEnded && !writable.destroyed) writable.end();
    return completion;
  };
}

export class FileJobOutput implements JobOutputStore {
  readonly writable: Writable;
  readonly log: string;
  private readonly complete: () => Promise<void>;
  private disposed = false;
  private disposal?: Promise<void>;

  constructor(log: string) {
    this.log = log;
    mkdirSync(dirname(log), { recursive: true });
    this.writable = createWriteStream(log);
    this.complete = outputFinisher(this.writable);
  }

  async tail(options?: Partial<TailLimits>): Promise<OutputTail> {
    if (this.disposed) throw new Error("Output store is disposed");
    const limits = tailLimits(options);
    // A zero-byte write is a flush barrier for all bytes already accepted by the writable.
    if (this.writable.writableEnded || this.writable.destroyed) await this.finish();
    else
      await new Promise<void>((resolve, reject) =>
        this.writable.write(Buffer.alloc(0), (error) => (error ? reject(error) : resolve())),
      );
    const file = await open(this.log, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("Output log is not a regular file");
      const length = Math.min(info.size, limits.maxBytes);
      const position = info.size - length;
      const buffer = Buffer.allocUnsafeSlow(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await file.read(buffer, read, length - read, position + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return formatTail(buffer.subarray(0, read), position > 0, limits);
    } finally {
      await file.close();
    }
  }

  finish(): Promise<void> {
    return this.complete();
  }

  /** Closes capture resources, retaining the log. Subsequent reads reject. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.disposal ??= this.finish();
    return this.disposal;
  }
}

export class MemoryJobOutput implements JobOutputStore {
  readonly writable: Writable;
  readonly log = null;
  private buffer: Buffer;
  private start = 0;
  private length = 0;
  private evicted = false;
  private disposed = false;
  private disposal?: Promise<void>;
  private readonly complete: () => Promise<void>;

  constructor(capacity: ByteCount = DEFAULT_MEMORY_CAPACITY) {
    // An unpooled allocation prevents a tiny capacity from retaining a larger Buffer pool.
    this.buffer = Buffer.allocUnsafeSlow(byteCount(capacity));
    this.writable = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.append(chunk);
        callback();
      },
    });
    this.complete = outputFinisher(this.writable);
  }

  private append(chunk: Buffer): void {
    const capacity = this.buffer.length;
    if (chunk.length >= capacity) {
      this.evicted ||= this.length > 0 || chunk.length > capacity;
      chunk.copy(this.buffer, 0, chunk.length - capacity);
      this.start = 0;
      this.length = capacity;
      return;
    }
    const overflow = Math.max(0, this.length + chunk.length - capacity);
    this.evicted ||= overflow > 0;
    this.start = (this.start + overflow) % capacity;
    this.length -= overflow;
    const end = (this.start + this.length) % capacity;
    const first = Math.min(chunk.length, capacity - end);
    chunk.copy(this.buffer, end, 0, first);
    chunk.copy(this.buffer, 0, first);
    this.length += chunk.length;
  }

  async tail(options?: Partial<TailLimits>): Promise<OutputTail> {
    if (this.disposed) throw new Error("Output store is disposed");
    const limits = tailLimits(options);
    const length = Math.min(this.length, limits.maxBytes);
    const buffer = Buffer.allocUnsafeSlow(length);
    const start = (this.start + this.length - length) % this.buffer.length;
    const first = Math.min(length, this.buffer.length - start);
    this.buffer.copy(buffer, 0, start, start + first);
    this.buffer.copy(buffer, first, 0, length - first);
    return formatTail(buffer, this.evicted || this.length > length, limits);
  }

  finish(): Promise<void> {
    return this.complete();
  }

  /** Flushes capture, then releases retained bytes. Subsequent reads reject. */
  dispose(): Promise<void> {
    this.disposed = true;
    this.disposal ??= this.finish().finally(() => {
      this.buffer = Buffer.alloc(0);
      this.length = 0;
      this.start = 0;
    });
    return this.disposal;
  }
}
