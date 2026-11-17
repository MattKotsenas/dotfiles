import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  bounded,
  createFixture,
  createPeer,
  processAlive,
  resultText,
  until,
  usingJob,
} from "./background/fixture.mjs";

async function stopped(peer) {
  const deadline = Date.now() + 3000;
  while (processAlive(peer.info.pid) && Date.now() < deadline) await delay(10);
  const alive = processAlive(peer.info.pid);
  if (alive) await peer.ping();
  console.log(JSON.stringify({ controlledPid: peer.info.pid, aliveAfterCancellation: alive, responsive: alive }));
  assert.equal(alive, false, "cancelled owner's command must stop");
}
async function cleanup(fixture, peer, id) {
  if (id) await fixture.call("bg_kill", { id });
  await peer.finish();
  if (id) {
    const result = fixture.structured(await fixture.call("bg_wait", { id, timeout: 5 }));
    assert.equal(result.wait_timed_out, false, "cleanup must observe job completion");
  }
  await peer.dispose();
}

for (const output of ["file", "memory"])
  test(`cancellation follows the owning active run (${output})`, { timeout: 90000 }, async (t) => {
    const fixture = await createFixture({ output });
    try {
      for (const mode of ["direct", "codemode"]) {
        await t.test(`${mode} foreground cancellation still stops execution`, async () => {
          const peer = await createPeer();
          let running;
          try {
            const args = { command: peer.command, timeout: 20 };
            running =
              mode === "direct"
                ? fixture.call("bash", args)
                : fixture.call("codemode", { code: `text(await tools.bash(${JSON.stringify(args)}));` });
            await bounded(peer.ready, 5000, "foreground command ready");
            await peer.ping();
            assert(processAlive(peer.info.pid));
            const owner = fixture.session.agent.signal;
            assert(owner && !owner.aborted);
            await fixture.session.abort();
            assert.equal(owner.aborted, true);
            assert.equal((await running).isError, true);
            await stopped(peer);
          } finally {
            await fixture.session.abort();
            await peer.finish();
            if (running) await running;
            await peer.dispose();
          }
        });
      }
      for (const [mode, method] of [
        ["direct", "bash"],
        ["codemode", "bash"],
        ["codemode", "bg_run"],
      ]) {
        await t.test(`${mode} ${method} stays owned after backgrounding`, async () => {
          const peer = await createPeer(),
            key = randomUUID();
          let running, id;
          try {
            const args = { command: peer.command, ...(method === "bash" ? { timeout: 0.1 } : {}) };
            const endCount = fixture.ends.length;
            running =
              mode === "direct"
                ? fixture.call(method, args, [{ name: "evaluation_hold", args: { key } }])
                : fixture.call("codemode", {
                    code: `text(await tools.${method}(${JSON.stringify(args)}));await tools.evaluation_hold({key:${JSON.stringify(key)}});`,
                  });
            await bounded(peer.ready, 5000, "background command ready");
            await until(() => fixture.holds.has(key), 5000, "owning run remains active after handoff");
            const launch = fixture.ends
              .slice(endCount)
              .find(
                (end) =>
                  end.toolName === method &&
                  end.result.structuredContent?.id &&
                  (mode !== "direct" || !end.parentToolCallId),
              );
            assert(launch && !launch.isError);
            id = fixture.structured(launch).id;
            await peer.ping();
            assert(processAlive(peer.info.pid));
            const owner = fixture.session.agent.signal;
            assert(owner && !owner.aborted);
            await fixture.session.abort();
            assert.equal(owner.aborted, true);
            const end = await running;
            if (mode === "codemode") assert.equal(end.isError, true, resultText(end));
            await stopped(peer);
            const result = fixture.structured(await fixture.call("bg_wait", { id, timeout: 5 }));
            assert.equal(result.status, "killed");
            assert.equal(result.wait_timed_out, false);
          } finally {
            await fixture.session.abort();
            if (running) await running;
            await cleanup(fixture, peer, id);
          }
        });
      }
      await t.test("abort stops multiple owned jobs but not a previous run's job", async () => {
        await usingJob(fixture, "direct", "bg_run", async ({ peer: unrelated }) => {
          const a = await createPeer(),
            b = await createPeer(),
            key = randomUUID();
          let running;
          const ids = [];
          try {
            const endCount = fixture.ends.length;
            running = fixture.call("bg_run", { command: a.command }, [
              { name: "bg_run", args: { command: b.command } },
              { name: "evaluation_hold", args: { key } },
            ]);
            await bounded(Promise.all([a.ready, b.ready]), 5000, "both owned commands ready");
            await until(() => fixture.holds.has(key), 5000, "same run owns both accepted jobs");
            ids.push(
              ...fixture.ends
                .slice(endCount)
                .filter((end) => end.toolName === "bg_run")
                .map((end) => fixture.structured(end).id),
            );
            assert.equal(ids.length, 2);
            await a.ping();
            await b.ping();
            await unrelated.ping();
            assert(processAlive(a.info.pid));
            assert(processAlive(b.info.pid));
            assert(processAlive(unrelated.info.pid));
            await fixture.session.abort();
            await running;
            await stopped(a);
            await stopped(b);
            assert(processAlive(unrelated.info.pid));
            await unrelated.ping();
          } finally {
            await fixture.session.abort();
            if (running) await running;
            await cleanup(fixture, a, ids[0]);
            await cleanup(fixture, b, ids[1]);
          }
        });
      });
      await t.test("normal codemode completion does not cancel its job", async () => {
        await usingJob(fixture, "codemode", "bg_run", async ({ peer, id }) => {
          assert.equal(fixture.session.agent.signal, undefined, "precondition: launching run completed normally");
          await fixture.call("codemode", { code: 'text("independent work");' });
          assert(processAlive(peer.info.pid));
          await peer.ping();
          const result = fixture.structured(await fixture.call("bg_wait", { id, timeout: 0.02 }));
          assert.equal(result.wait_timed_out, true);
          assert.equal(result.status, "running");
        });
      });
      await t.test("/reap stops tracked live jobs, including ones whose launching run ended", async () => {
        await usingJob(fixture, "direct", "bg_run", async ({ peer: a, id: aId }) => {
          await usingJob(fixture, "codemode", "bg_run", async ({ peer: b, id: bId }) => {
            assert.equal(fixture.session.agent.signal, undefined);
            assert(processAlive(a.info.pid));
            assert(processAlive(b.info.pid));
            await a.ping();
            await b.ping();
            await fixture.session.prompt("/reap");
            await stopped(a);
            await stopped(b);
            for (const id of [aId, bId]) {
              const result = fixture.structured(await fixture.call("bg_wait", { id, timeout: 5 }));
              assert.equal(result.status, "killed");
              assert.equal(result.wait_timed_out, false);
            }
            await fixture.session.prompt("/reap");
            const status = fixture.structured(await fixture.call("bg_status", {}));
            assert(status.jobs.every((job) => job.status !== "running"));
          });
        });
      });
    } finally {
      await fixture.dispose();
    }
  });
