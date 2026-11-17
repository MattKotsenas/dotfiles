import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  byteCount,
  DEFAULT_MEMORY_CAPACITY,
  DEFAULT_TAIL_LIMITS,
  FileJobOutput,
  lineCount,
  MemoryJobOutput,
  tailLimits,
} from "../agent/extensions/background/output-store.ts";

async function fixture(t, kind, capacity) {
  if (kind === "memory") {
    const store = new MemoryJobOutput(capacity);
    t.after(() => store.dispose());
    return store;
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-output-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileJobOutput(join(dir, "nested", "combined.log"));
  t.after(() => store.dispose());
  return store;
}

async function write(store, chunks) {
  for (const chunk of chunks) {
    await new Promise((resolve, reject) => store.writable.write(chunk, (error) => (error ? reject(error) : resolve())));
  }
}

for (const [name, construct] of [
  ["bytes", byteCount],
  ["lines", lineCount],
]) {
  for (const value of [0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    test(`${name} rejects ${value}`, () => assert.throws(() => construct(value), RangeError));
  }
  for (const value of [1, 200, 1024 * 1024 * 8, Number.MAX_SAFE_INTEGER]) {
    test(`${name} accepts positive safe integer ${value} without policy caps`, () =>
      assert.equal(construct(value), value));
  }
}

test("tail policy supplies independent defaults and validates overrides", () => {
  assert.equal(Object.isFrozen(DEFAULT_TAIL_LIMITS), true);
  assert.deepEqual(DEFAULT_TAIL_LIMITS, { maxBytes: 65536, maxLines: 200 });
  assert.equal(DEFAULT_MEMORY_CAPACITY, 1024 * 1024);
  assert.deepEqual(tailLimits(), DEFAULT_TAIL_LIMITS);
  assert.deepEqual(tailLimits({ maxBytes: 7 }), { maxBytes: 7, maxLines: 200 });
  assert.deepEqual(tailLimits({ maxLines: 3 }), { maxBytes: 65536, maxLines: 3 });
  assert.deepEqual(tailLimits({ maxBytes: Number.MAX_SAFE_INTEGER, maxLines: 999999 }), {
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxLines: 999999,
  });
  for (const field of ["maxBytes", "maxLines"]) {
    for (const value of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => tailLimits({ [field]: value }), RangeError);
  }
});

const cases = [
  { name: "empty", input: "", bytes: 8, lines: 2, text: "", truncated: false },
  { name: "only trailing whitespace", input: " \r\n\n\t", bytes: 20, lines: 1, text: "", truncated: false },
  { name: "exact byte threshold", input: "abcde", bytes: 5, lines: 1, text: "abcde", truncated: false },
  { name: "one byte over", input: "abcdef", bytes: 5, lines: 1, text: "bcdef", truncated: true },
  { name: "exact lines", input: "one\ntwo", bytes: 20, lines: 2, text: "one\ntwo", truncated: false },
  { name: "line exclusion", input: "one\ntwo\nthree", bytes: 100, lines: 2, text: "two\nthree", truncated: true },
  { name: "both limits", input: "first\nsecond\nthird", bytes: 10, lines: 1, text: "third", truncated: true },
  {
    name: "byte limit with many permitted lines",
    input: "first\nsecond\nthird",
    bytes: 8,
    lines: 99,
    text: "nd\nthird",
    truncated: true,
  },
  {
    name: "CRLF preserved internally",
    input: "one\r\ntwo\r\nthree\r\n",
    bytes: 100,
    lines: 2,
    text: "two\r\nthree",
    truncated: true,
  },
  {
    name: "trailing newlines do not consume line budget",
    input: "one\ntwo\n\n\n",
    bytes: 100,
    lines: 2,
    text: "one\ntwo",
    truncated: false,
  },
  {
    name: "trailing spaces follow trimEnd",
    input: "one \ntwo \t\r\n",
    bytes: 100,
    lines: 2,
    text: "one \ntwo",
    truncated: false,
  },
  { name: "interior blank line counts", input: "one\n\nthree", bytes: 100, lines: 2, text: "\nthree", truncated: true },
  { name: "leading newline counts", input: "\none", bytes: 100, lines: 1, text: "one", truncated: true },
  { name: "multibyte exact threshold", input: "雪🙂", bytes: 7, lines: 2, text: "雪🙂", truncated: false },
  { name: "multibyte aligned suffix", input: "x雪🙂", bytes: 7, lines: 2, text: "雪🙂", truncated: true },
  { name: "multibyte cut inside three-byte character", input: "雪🙂", bytes: 6, lines: 2, text: "🙂", truncated: true },
  { name: "multibyte cut inside four-byte character", input: "雪🙂x", bytes: 4, lines: 2, text: "x", truncated: true },
  { name: "budget smaller than newest codepoint", input: "🙂", bytes: 1, lines: 2, text: "", truncated: true },
  {
    name: "giant single line",
    input: "x".repeat(200000) + "latest",
    bytes: 17,
    lines: 1,
    text: "x".repeat(11) + "latest",
    truncated: true,
  },
  {
    name: "byte trimming precedes whitespace trimming",
    input: "old\n" + "\n".repeat(100),
    bytes: 10,
    lines: 2,
    text: "",
    truncated: true,
  },
  {
    name: "malformed byte replacement fits",
    input: Buffer.from([255]),
    bytes: 3,
    lines: 1,
    text: "�",
    truncated: false,
  },
  {
    name: "malformed byte replacement exceeds cap",
    input: Buffer.from([255]),
    bytes: 1,
    lines: 1,
    text: "",
    truncated: true,
  },
  {
    name: "malformed sequence expands beyond cap",
    input: Buffer.from([0xe2, 0x28, 0xa1]),
    bytes: 3,
    lines: 1,
    text: "�",
    truncated: true,
  },
  {
    name: "malformed output expands beyond default cap",
    input: Buffer.alloc(65536, 255),
    bytes: 65536,
    lines: 200,
    text: "�".repeat(Math.floor(65536 / 3)),
    truncated: true,
  },
  {
    name: "incomplete codepoint replacement exceeds cap",
    input: Buffer.from([0xe9]),
    bytes: 1,
    lines: 1,
    text: "",
    truncated: true,
  },
];

for (const kind of ["file", "memory"]) {
  for (const { name, input, bytes, lines, text, truncated } of cases) {
    test(`${kind}: ${name}`, async (t) => {
      const store = await fixture(t, kind);
      assert.ok(store.writable instanceof Writable);
      assert.deepEqual(await store.tail(), { text: "", truncated: false });
      await write(store, [input]);
      await store.finish();
      const result = await store.tail(tailLimits({ maxBytes: bytes, maxLines: lines }));
      assert.ok(
        Buffer.byteLength(result.text) <= bytes,
        "returned UTF-8 bytes must respect the cap, not only raw input",
      );
      assert.deepEqual(result, { text, truncated });
    });
  }

  test(`${kind}: a live snapshot inside a split codepoint respects the returned byte cap`, async (t) => {
    const store = await fixture(t, kind);
    const raw = Buffer.from("雪");
    assert.equal(raw.length, 3);
    await write(store, [raw.subarray(0, 1)]);
    assert.deepEqual(await store.tail({ maxBytes: byteCount(1) }), { text: "", truncated: true });
    await write(store, [raw.subarray(1)]);
    assert.deepEqual(await store.tail({ maxBytes: byteCount(3) }), { text: "雪", truncated: false });
  });

  test(`${kind}: raw combined chunks preserve UTF-8 across every byte boundary`, async (t) => {
    const store = await fixture(t, kind);
    const raw = Buffer.from("stdout 雪\nstderr 🙂\r\nnext é\n");
    await write(
      store,
      [...raw].map((byte) => Buffer.from([byte])),
    );
    assert.deepEqual(await store.tail(), { text: raw.toString().trimEnd(), truncated: false });
    await store.finish();
    assert.deepEqual(await store.tail(), { text: raw.toString().trimEnd(), truncated: false });
    if (store.log !== null) assert.deepEqual(await readFile(store.log), raw);
  });

  test(`${kind}: finish drains queued writes and is repeatable`, async (t) => {
    const store = await fixture(t, kind);
    assert.equal(store.writable.writableEnded, false);
    for (let i = 0; i < 500; i++) store.writable.write(`${i}\n`);
    await Promise.all([store.finish(), store.finish()]);
    assert.equal(store.writable.writableFinished, true);
    await store.finish();
    assert.deepEqual(await store.tail({ maxLines: lineCount(2) }), { text: "498\n499", truncated: true });
  });

  test(`${kind}: partial limits both apply, invalid runtime limits reject`, async (t) => {
    const store = await fixture(t, kind);
    await write(store, ["a\nb\nc"]);
    assert.deepEqual(await store.tail({ maxLines: lineCount(1) }), { text: "c", truncated: true });
    assert.deepEqual(await store.tail({ maxBytes: byteCount(3) }), { text: "b\nc", truncated: true });
    await assert.rejects(store.tail({ maxBytes: 0 }), RangeError);
    await assert.rejects(store.tail({ maxLines: -1 }), RangeError);
  });

  test(`${kind}: caller limits can exceed defaults without clamping`, async (t) => {
    const store = await fixture(t, kind);
    const input = Array.from({ length: 300 }, (_, i) => `${i}:` + "x".repeat(300)).join("\n");
    assert.ok(Buffer.byteLength(input) > DEFAULT_TAIL_LIMITS.maxBytes);
    await write(store, [input]);
    assert.deepEqual(await store.tail(tailLimits({ maxBytes: Buffer.byteLength(input), maxLines: 300 })), {
      text: input,
      truncated: false,
    });
    assert.equal((await store.tail()).truncated, true);
  });

  test(`${kind}: finish accepts an already ended writable and rejects later writes`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-output-ended-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = kind === "file" ? new FileJobOutput(join(dir, "output.log")) : new MemoryJobOutput();
    store.writable.end("final 雪");
    await store.finish();
    assert.deepEqual(await store.tail(), { text: "final 雪", truncated: false });
    await store.dispose();
    await assert.rejects(write(store, ["late"]), /write after end|destroyed/i);
  });

  test(`${kind}: disposed reads reject, writes fail, repeated cleanup is safe`, async (t) => {
    const store = await fixture(t, kind);
    await write(store, ["keep raw\r\n"]);
    await Promise.all([store.dispose(), store.dispose()]);
    await store.dispose();
    await store.finish();
    await assert.rejects(store.tail(), /disposed/i);
    await assert.rejects(write(store, ["late"]), /write after end|destroyed/i);
    if (store.log !== null) assert.equal(await readFile(store.log, "utf8"), "keep raw\r\n");
  });

  test(`${kind}: external writable destruction is observed by finish without unhandled errors`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-output-destroy-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = kind === "file" ? new FileJobOutput(join(dir, "output.log")) : new MemoryJobOutput();
    const failure = new Error("capture failed");
    store.writable.destroy(failure);
    await setImmediate();
    await assert.rejects(store.finish(), (error) => error === failure);
    await assert.rejects(store.finish(), (error) => error === failure);
    await assert.rejects(store.dispose(), (error) => error === failure);
    await assert.rejects(store.dispose(), (error) => error === failure);
  });
}

for (const capacity of [1, 3, 7, 16]) {
  for (const chunkSize of [1, 2, 5, 50]) {
    test(`memory: capacity ${capacity}, chunks ${chunkSize} retain newest raw bytes`, async (t) => {
      const store = await fixture(t, "memory", byteCount(capacity));
      assert.equal(store.log, null);
      assert.deepEqual(await store.tail(), { text: "", truncated: false });
      const raw = Buffer.from("prefix 雪 alpha 🙂 newest");
      assert.ok(raw.length > capacity, "precondition: eviction is required");
      for (let offset = 0; offset < raw.length; offset += chunkSize)
        await write(store, [raw.subarray(offset, offset + chunkSize)]);
      let suffix = raw.subarray(-capacity);
      while (suffix.length && (suffix[0] & 0xc0) === 0x80) suffix = suffix.subarray(1);
      assert.deepEqual(await store.tail({ maxBytes: byteCount(100) }), {
        text: suffix.toString().trimEnd(),
        truncated: true,
      });
      assert.deepEqual(await store.tail({ maxBytes: byteCount(1) }), { text: "t", truncated: true });
    });
  }
}

for (const [input, truncated] of [
  ["abc", false],
  ["abcd", true],
  ["ab雪", true],
  ["🙂", true],
]) {
  test(`memory: exact capacity and Unicode eviction for ${JSON.stringify(input)}`, async (t) => {
    const store = await fixture(t, "memory", byteCount(3));
    await write(store, [input]);
    const text = input === "ab雪" ? "雪" : input === "🙂" ? "" : input.slice(-3);
    assert.deepEqual(await store.tail(), { text, truncated });
  });
}

test("memory: copies input instead of retaining a mutable large backing allocation", async (t) => {
  const store = await fixture(t, "memory", byteCount(4));
  const large = Buffer.alloc(2 * 1024 * 1024, 97);
  await write(store, [large.subarray(-4)]);
  large.fill(98);
  assert.deepEqual(await store.tail(), { text: "aaaa", truncated: false });
});

test("file: missing logs and read errors reject", async (t) => {
  const store = await fixture(t, "file");
  await write(store, ["evidence"]);
  await store.finish();
  await unlink(store.log);
  await assert.rejects(store.tail(), { code: "ENOENT" });
  await mkdir(store.log);
  await assert.rejects(store.tail(), /EISDIR|EPERM|EACCES|regular file/);
});

test("file: open failure is captured before finish is called", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-output-error-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileJobOutput(dir);
  await new Promise((resolve) => store.writable.once("close", resolve));
  await assert.rejects(store.finish(), /EISDIR|EPERM|EACCES/);
  await assert.rejects(store.dispose(), /EISDIR|EPERM|EACCES/);
});

test("file: large log tail stays asynchronous and retains the full log", async (t) => {
  const store = await fixture(t, "file");
  const raw = Buffer.concat([Buffer.alloc(8 * 1024 * 1024, 120), Buffer.from("\nnewest 雪🙂\n")]);
  await write(store, [raw]);
  await store.finish();
  assert.equal((await stat(store.log)).size, raw.length);
  const probe = await open(store.log, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  const reads = [];
  // Force short reads to verify the positional loop as well as the total I/O bound.
  t.mock.method(prototype, "read", async function (buffer, offset, length, position) {
    assert.equal(typeof position, "number");
    assert.ok(position >= raw.length - 32);
    assert.ok(length <= 32);
    const result = await originalRead.call(this, buffer, offset, Math.min(length, 5), position);
    reads.push(result.bytesRead);
    return result;
  });
  let completed = false;
  const result = store.tail(tailLimits({ maxBytes: 32, maxLines: 1 })).then((value) => {
    completed = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(completed, false, "file tail must yield for asynchronous I/O");
  assert.deepEqual(await result, { text: "newest 雪🙂", truncated: true });
  assert.ok(reads.length > 1, "tail must use bounded positional reads, including short reads");
  assert.equal(
    reads.reduce((sum, length) => sum + length, 0),
    32,
  );
  t.mock.restoreAll();
  assert.deepEqual(await readFile(store.log), raw);
});

test("file: positional read failures propagate", async (t) => {
  const store = await fixture(t, "file");
  await write(store, ["retained"]);
  await store.finish();
  const probe = await open(store.log, "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const failure = new Error("injected read I/O failure");
  t.mock.method(prototype, "read", async () => {
    throw failure;
  });
  await assert.rejects(store.tail(), (error) => error === failure);
});
