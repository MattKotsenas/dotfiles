import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded, createFixture, processAlive, quote, resultText, until, usingJob } from "./background/fixture.mjs";

// Exercise one real session across launch, inspection, repeated waits, and stop.
// Each case owns its commands and loopback peers; model responses alone are scripted.
for (const output of ["file", "memory"])
  test(`background lifecycle through Pi tools and codemode (${output})`, { timeout: 90000 }, async (t) => {
    const fixture = await createFixture({ output });
    try {
      const empty = await fixture.call("bg_status", {});
      await t.test("empty status is structured without changing its text", () => {
        assert.match(resultText(empty), /No background jobs/);
        assert.deepEqual(fixture.structured(empty), { jobs: [] });
      });
      for (const exitCode of [0, 7, 42]) {
        await t.test(`foreground bash retains Pi's native result for exit ${exitCode}`, async () => {
          const output = `stdout ${exitCode} ü 雪`;
          const end = await fixture.call("bash", {
            command: `printf '%s' ${quote(output)}; printf '%s' 'stderr line' >&2; exit ${exitCode}`,
          });
          assert.equal(end.isError, exitCode !== 0);
          const result = fixture.structured(end);
          assert.equal(result.exit_code, exitCode);
          assert(result.output.includes(output));
          assert(result.output.includes("stderr line"));
          assert.equal(result.output.length, output.length + "stderr line".length);
          assert.equal(result.truncated, false);
        });
      }
      for (const mode of ["direct", "codemode"]) {
        for (const method of ["bash", "bg_run"]) {
          await t.test(`${mode} ${method} returns a structured live handle and status`, async () => {
            await usingJob(
              fixture,
              mode,
              method,
              async ({ peer, id, launch }) => {
                const result = fixture.structured(launch.end);
                assert.deepEqual(launch.value, result, "codemode must receive the structured result, not its text");
                assert.equal(result.id, id);
                assert.equal(result.status, "running");
                assert.equal(result.exit_code, null, "running must not claim a successful exit");
                assert.equal(result.log === null, output === "memory");
                assert.equal(peer.info.cwd, fixture.cwd);
                assert.equal(peer.info.prefix, "prefix ü 雪");
                assert.equal(peer.info.stdin, "stdin ü 雪");
                const status = await fixture.invoke("bg_status", { id }, mode);
                assert.deepEqual(status.value, fixture.structured(status.end));
                assert.equal(status.value.jobs.length, 1);
                assert.equal(status.value.jobs[0].id, id);
                assert.equal(status.value.jobs[0].status, "running");
                assert.equal(status.value.jobs[0].log, result.log);
              },
              { stdin: "stdin ü 雪" },
            );
          });
        }
        await t.test(`${mode} bounded waits expire repeatedly without killing or replaying the job`, async () => {
          assert(fixture.definition("bg_wait"), "precondition: bg_wait exists");
          await usingJob(fixture, mode, "bash", async ({ peer, id }) => {
            const pid = peer.info.pid;
            for (const timeout of [0, 0.02, 0.04]) {
              const waiting = await fixture.invoke("bg_wait", { id, timeout }, mode);
              assert.deepEqual(waiting.value, fixture.structured(waiting.end));
              assert.equal(waiting.value.wait_timed_out, true);
              assert.equal(waiting.value.id, id);
              assert.equal(waiting.value.status, "running");
              assert.equal(waiting.value.exit_code, null);
              assert.equal(peer.info.pid, pid);
              assert(processAlive(pid), "wait expiry must not kill execution");
              await peer.ping();
            }
            await peer.finish();
            for (const timeout of [5, 0, 120]) {
              const completed = await fixture.invoke("bg_wait", { id, timeout }, mode);
              assert.deepEqual(completed.value, fixture.structured(completed.end));
              assert.equal(completed.value.wait_timed_out, false);
              assert.equal(completed.value.status, "exited");
              assert.equal(completed.value.exit_code, 7);
              assert.match(completed.value.output, /DONE ü 雪/);
              assert.match(completed.value.output, /STDERR LINE/);
            }
          });
        });
      }
      await t.test("a pending wait returns completion with flushed output", async () => {
        assert(fixture.definition("bg_wait"), "precondition: bg_wait exists");
        await usingJob(fixture, "direct", "bg_run", async ({ peer, id }) => {
          const startedCount = fixture.starts.length;
          const waiting = fixture.call("bg_wait", { id, timeout: 5 });
          await until(
            () => fixture.starts.slice(startedCount).some((event) => event.toolName === "bg_wait"),
            5000,
            "wait starts before completion",
          );
          assert(processAlive(peer.info.pid), "precondition: command is live while waiting");
          await peer.finish();
          const result = fixture.structured(await bounded(waiting, 5000, "wait observes completion"));
          assert.equal(result.wait_timed_out, false);
          assert.equal(result.exit_code, 7);
          assert.match(result.output, /DONE ü 雪/);
          assert.match(result.output, /STDERR LINE/);
        });
      });
      await t.test("concurrent waits can expire and complete independently", async () => {
        assert(fixture.definition("bg_wait"), "precondition: bg_wait exists");
        await usingJob(fixture, "direct", "bg_run", async ({ peer, id }) => {
          const endCount = fixture.ends.length;
          const running = fixture.call("codemode", {
            code: `text({tag:"waits",values:await Promise.all([tools.bg_wait({id:${JSON.stringify(id)},timeout:0.05}),tools.bg_wait({id:${JSON.stringify(id)},timeout:5})])});`,
          });
          await until(
            () =>
              fixture.ends
                .slice(endCount)
                .some((end) => end.toolName === "bg_wait" && end.result.structuredContent?.wait_timed_out),
            5000,
            "short wait expires while long wait remains pending",
          );
          assert.equal(fixture.ends.slice(endCount).filter((end) => end.toolName === "bg_wait").length, 1);
          assert(processAlive(peer.info.pid));
          await peer.ping();
          await peer.finish();
          const parent = await bounded(running, 5000, "long wait observes completion");
          assert.equal(parent.isError, false, resultText(parent));
          const nested = fixture.ends.slice(endCount).filter((end) => end.toolName === "bg_wait");
          assert.equal(nested.length, 2);
          const results = nested.map((end) => fixture.structured(end));
          assert.equal(results[0].wait_timed_out, true);
          assert.equal(results[0].status, "running");
          assert.equal(results[1].wait_timed_out, false);
          assert.equal(results[1].exit_code, 7);
        });
      });
      await t.test("explicit stop is structured and terminal stop is idempotent", async () => {
        assert(fixture.definition("bg_wait"), "precondition: bg_wait exists");
        await usingJob(fixture, "codemode", "bg_run", async ({ peer, id }) => {
          const stopping = await fixture.invoke("bg_kill", { id }, "codemode");
          assert.deepEqual(stopping.value, fixture.structured(stopping.end));
          assert.equal(stopping.value.id, id);
          assert.equal(stopping.value.stop_requested, true);
          const result = fixture.structured(await fixture.call("bg_wait", { id, timeout: 5 }));
          assert.equal(result.status, "killed");
          assert.equal(result.exit_code, null);
          assert.equal(result.wait_timed_out, false);
          await until(() => !processAlive(peer.info.pid), 3000, "explicit stop kills controlled process");
          const again = await fixture.invoke("bg_kill", { id }, "codemode");
          assert.deepEqual(again.value, fixture.structured(again.end));
          assert.equal(again.value.stop_requested, false);
          assert.equal(again.value.status, "killed");
        });
      });
      await t.test("failed launch is distinguishable from a command exit", async () => {
        assert(fixture.definition("bg_wait"), "precondition: bg_wait exists");
        const launch = await fixture.call("bg_run", { command: "printf never", cwd: fixture.cwd + "/missing" });
        const job = fixture.structured(launch);
        const result = fixture.structured(await fixture.call("bg_wait", { id: job.id, timeout: 5 }));
        assert.equal(result.status, "failed");
        assert.equal(result.exit_code, null);
        assert.equal(result.wait_timed_out, false);
        assert.match(result.output, /Working directory does not exist/);
      });
      await t.test("aborting a wait releases observation without cancelling another run's job", async () => {
        assert(fixture.definition("bg_wait"), "precondition: bg_wait exists");
        await usingJob(fixture, "direct", "bg_run", async ({ peer, id }) => {
          const startedCount = fixture.starts.length;
          const waiting = fixture.call("bg_wait", { id, timeout: 30 });
          await until(
            () => fixture.starts.slice(startedCount).some((event) => event.toolName === "bg_wait"),
            5000,
            "wait starts before abort",
          );
          await fixture.session.abort();
          const end = await bounded(waiting, 3000, "wait cancellation");
          assert.equal(end.isError, true);
          assert(processAlive(peer.info.pid));
          await peer.ping();
        });
      });
      for (const timeout of [-1, 120.01, "soon"]) {
        await t.test(`invalid wait timeout ${JSON.stringify(timeout)} fails without stopping execution`, async () => {
          assert(fixture.definition("bg_wait"), "precondition: bg_wait exists");
          await usingJob(fixture, "direct", "bg_run", async ({ peer, id }) => {
            const end = await fixture.call("bg_wait", { id, timeout });
            assert.equal(end.isError, true);
            assert.match(resultText(end), /timeout/);
            assert(processAlive(peer.info.pid));
            await peer.ping();
          });
        });
      }
      await t.test("Pi's optional null timeout is accepted as omission", async () => {
        assert(fixture.definition("bg_wait"), "precondition: bg_wait exists");
        await usingJob(fixture, "direct", "bg_run", async ({ peer, id }) => {
          await peer.finish();
          const completed = fixture.structured(await fixture.call("bg_wait", { id, timeout: 5 }));
          assert.equal(completed.status, "exited");
          assert.equal(completed.exit_code, 7);
          for (const args of [{ id, timeout: null }, { id }]) {
            const end = await fixture.call("bg_wait", args);
            assert.equal(end.isError, false);
            const result = fixture.structured(end);
            assert.equal(result.wait_timed_out, false);
            assert.equal(result.exit_code, 7);
          }
        });
      });
      for (const name of ["bg_status", "bg_wait", "bg_kill"]) {
        await t.test(`${name} rejects an unknown handle`, async () => {
          assert(fixture.definition(name), "precondition: tested tool exists");
          const end = await fixture.call(name, { id: "not-a-known-job", timeout: 0 });
          assert.equal(end.isError, true);
          assert.match(resultText(end), /No background job not-a-known-job/);
        });
      }
    } finally {
      await fixture.dispose();
    }
  });
