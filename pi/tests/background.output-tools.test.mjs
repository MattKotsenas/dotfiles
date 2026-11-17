import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bounded,
  createFixture,
  createPeer,
  processAlive,
  quote,
  resultText,
  until,
  usingJob,
} from "./background/fixture.mjs";

const command = (source) =>
  `MSYS2_ARG_CONV_EXCL='*' ${quote(process.execPath.replaceAll("\\", "/"))} -e ${quote(source)}`;

test("invalid capture setting stops an already running automatic handoff", { timeout: 15000 }, async () => {
  const fixture = await createFixture({ output: "unsupported" });
  const peer = await createPeer();
  let running;
  try {
    running = fixture.call("bash", { command: peer.command, timeout: 0.5 });
    await bounded(peer.ready, 4000, "command starts before capture selection");
    assert(processAlive(peer.info.pid));
    const end = await bounded(running, 4000, "capture setting error returns");
    assert.equal(end.isError, true);
    assert.match(resultText(end), /background.output must be file or memory/);
    await until(() => !processAlive(peer.info.pid), 4000, "failed handoff stops the untracked execution");
  } finally {
    await fixture.session.abort();
    if (running) await running;
    await peer.dispose();
    await fixture.dispose();
  }
});

for (const output of [undefined, "memory"])
  test(`output defaults and overrides through Pi (${output ?? "default file"})`, { timeout: 60000 }, async (t) => {
    const fixture = await createFixture({ output });
    try {
      await t.test("default tail is 200 lines and explicit larger limits recover retained output", async () => {
        const source = 'process.stdout.write(Array.from({length:250},(_,i)=>"line "+i+"\\n").join(""))';
        const launch = fixture.structured(await fixture.call("bg_run", { command: command(source) }));
        assert.equal(launch.log === null, output === "memory");
        const waited = await fixture.invoke("bg_wait", { id: launch.id, timeout: 5 }, "codemode");
        const result = waited.value;
        assert.equal(result.exit_code, 0);
        assert.equal(result.output.split("\n").length, 200);
        assert.match(result.output, /^line 50\n/);
        assert.match(result.output, /line 249$/);
        assert.equal(result.output_truncated, true);
        assert.match(resultText(waited.end), /Earlier output omitted/);
        const status = (await fixture.invoke("bg_status", { id: launch.id, lines: 300 }, "codemode")).value.jobs[0];
        assert.equal(status.output.split("\n").length, 250);
        assert.match(status.output, /^line 0\n/);
        assert.equal(status.output_truncated, false);
        const short = fixture.structured(
          await fixture.call("bg_wait", { id: launch.id, lines: 300, max_bytes: 7 }),
        ).output;
        assert.equal(short, "ne 249");
        // Pi coerces optional integer parameters before the extension receives them.
        const coerced = fixture.structured(await fixture.call("bg_status", { id: launch.id, lines: 1.5 })).jobs[0];
        assert.equal(coerced.output, "line 249");
        assert.equal(coerced.output_truncated, true);
      });
      await t.test("default byte cap bounds a giant line and caller can request more", async () => {
        const size = 65537;
        assert(size > 65536, "precondition: one byte beyond the default byte cap");
        const launch = fixture.structured(
          await fixture.call("bg_run", { command: command(`process.stdout.write('x'.repeat(${size}))`) }),
        );
        const result = fixture.structured(await fixture.call("bg_wait", { id: launch.id, timeout: 5 }));
        assert.equal(Buffer.byteLength(result.output), 65536);
        assert.equal(result.output_truncated, true);
        const status = fixture.structured(await fixture.call("bg_status", { id: launch.id, max_bytes: size })).jobs[0];
        assert.equal(Buffer.byteLength(status.output), size);
        assert.equal(status.output_truncated, false);
      });
      await t.test("default byte cap bounds malformed output after UTF-8 decoding", async () => {
        const launch = fixture.structured(
          await fixture.call("bg_run", { command: command("process.stdout.write(Buffer.alloc(65536,255))") }),
        );
        const result = fixture.structured(await fixture.call("bg_wait", { id: launch.id, timeout: 5 }));
        assert.equal(result.exit_code, 0);
        assert.equal(Buffer.byteLength(result.output), 65535);
        assert.equal(result.output, "�".repeat(Math.floor(65536 / 3)));
        assert.equal(result.output_truncated, true);
      });
      await t.test("invalid tail limits reject without stopping a live job", async () => {
        await usingJob(fixture, "direct", "bg_run", async ({ id, peer }) => {
          for (const name of ["bg_wait", "bg_status"]) {
            for (const [field, value] of [
              ["lines", 0],
              ["lines", -1],
              ["lines", "many"],
              ["max_bytes", 0],
              ["max_bytes", -1],
              ["max_bytes", "many"],
            ]) {
              const end = await fixture.call(name, { id, timeout: 0, [field]: value });
              assert.equal(end.isError, true, `${name} ${field}=${value}: ${resultText(end)}`);
              assert.match(resultText(end), new RegExp(field));
              await peer.ping();
            }
          }
        });
      });
    } finally {
      await fixture.dispose();
    }
  });
