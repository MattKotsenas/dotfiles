import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded, createFixture, processAlive, resultText, until, usingJob } from "./background/fixture.mjs";

const notices = (fixture, id) =>
  fixture.notifications.filter((message) => message.content.startsWith(`Background job finished: ${id} [`));

async function pendingWait(fixture, id, mode) {
  const started = fixture.starts.length;
  const waiting = fixture.invoke("bg_wait", { id, timeout: 30 }, mode);
  await until(
    () => fixture.starts.slice(started).some((event) => event.toolName === "bg_wait"),
    5000,
    "wait starts before execution finishes",
  );
  return { waiting };
}

for (const output of ["file", "memory"])
  test(`completion notifications through Pi (${output})`, { timeout: 90000 }, async (t) => {
    const fixture = await createFixture({ output });
    try {
      await t.test(
        "unobserved completion has a short label, final output, and a retrievable full command",
        async () => {
          await usingJob(fixture, "direct", "bg_run", async ({ peer, id, launch }) => {
            const command = launch.value.command;
            assert(command.length > 50, "precondition: command exceeds the existing UI label limit");
            assert.deepEqual(notices(fixture, id), []);
            await peer.finish();
            await until(() => notices(fixture, id).length > 0, 5000, "completion notification");
            const [notice] = notices(fixture, id);
            const label = notice.content.split("\n")[0].match(/\] (.*)$/)?.[1];
            assert(label, notice.content);
            assert(label.length <= 50);
            assert(label.endsWith("…"));
            assert(!notice.content.includes(command));
            assert.match(notice.content, /DONE ü 雪/);
            assert.match(notice.content, /STDERR LINE/);
            assert.match(notice.content, output === "file" ? /log: .*\.log/ : /output: memory/);
            const status = (await fixture.invoke("bg_status", { id }, "codemode")).value.jobs[0];
            assert.equal(status.command, command);
            assert.equal(status.exit_code, 7);
            const late = (await fixture.invoke("bg_wait", { id, timeout: 0 }, "codemode")).value;
            assert.equal(late.wait_timed_out, false);
            assert.equal(late.command, command);
            assert.equal(notices(fixture, id).length, 1, "an already delivered notification is retained exactly once");
          });
        },
      );
      for (const [name, command, expectedLabel] of [
        ["short", "printf done", "printf done"],
        ["multiline", "printf done\n# hidden second line", "printf done"],
        [
          "inline",
          `printf done; # ${"padding ".repeat(30)}`,
          `${`printf done; # ${"padding ".repeat(30)}`.slice(0, 49)}…`,
        ],
      ]) {
        await t.test(`${name} command notification keeps a bounded first-line label`, async () => {
          assert(expectedLabel.length <= 50);
          const launch = fixture.structured(await fixture.call("bg_run", { command }));
          await until(() => notices(fixture, launch.id).length > 0, 5000, "label notification");
          const [notice] = notices(fixture, launch.id);
          assert.equal(notice.content.split("\n")[0].split("] ")[1], expectedLabel);
          assert.match(notice.content, /Last lines:\ndone$/);
          assert.equal(notices(fixture, launch.id).length, 1);
          const status = (await fixture.invoke("bg_status", { id: launch.id }, "codemode")).value.jobs[0];
          assert.equal(status.command, command);
          assert.equal(status.exit_code, 0);
        });
      }
      for (const mode of ["direct", "codemode"]) {
        for (const exitCode of [0, 7]) {
          await t.test(`${mode} completed wait replaces the exit-${exitCode} notification`, async () => {
            await usingJob(fixture, "direct", "bg_run", async ({ peer, id }) => {
              assert.deepEqual(notices(fixture, id), []);
              const { waiting } = await pendingWait(fixture, id, mode);
              assert(processAlive(peer.info.pid), "precondition: execution is live while the wait is pending");
              await peer.finish(exitCode);
              const result = await bounded(waiting, 5000, "completed wait returns");
              assert.equal(result.end.isError, false, resultText(result.end));
              assert.equal(result.value.wait_timed_out, false);
              assert.equal(result.value.exit_code, exitCode);
              assert.match(result.value.output, /DONE ü 雪/);
              assert.match(result.value.output, /STDERR LINE/);
              assert.deepEqual(notices(fixture, id), [], "the completed wait already carries the final result");
            });
          });
        }
      }
      await t.test("a codemode wait replaces the intentional-stop notification", async () => {
        await usingJob(fixture, "direct", "bg_run", async ({ peer, id }) => {
          assert(processAlive(peer.info.pid), "precondition: execution is live before explicit stop");
          const endCount = fixture.ends.length;
          const result = await fixture.call("codemode", {
            code: `text(await Promise.all([tools.bg_wait({id:${JSON.stringify(id)},timeout:30}),tools.bg_kill({id:${JSON.stringify(id)}})]));`,
          });
          assert.equal(result.isError, false, resultText(result));
          const ends = fixture.ends.slice(endCount);
          const stopping = ends.find((end) => end.toolName === "bg_kill");
          assert.equal(fixture.structured(stopping).stop_requested, true);
          const waited = ends.find((end) => end.toolName === "bg_wait");
          assert.equal(fixture.structured(waited).wait_timed_out, false);
          assert.equal(fixture.structured(waited).status, "killed");
          assert.deepEqual(notices(fixture, id), []);
        });
      });
      await t.test("concurrent waits expire and observe completion without a duplicate notification", async () => {
        await usingJob(fixture, "direct", "bg_run", async ({ peer, id }) => {
          const endCount = fixture.ends.length;
          const waiting = fixture.call("codemode", {
            code: `text(await Promise.all([tools.bg_wait({id:${JSON.stringify(id)},timeout:0}),tools.bg_wait({id:${JSON.stringify(id)},timeout:30}),tools.bg_wait({id:${JSON.stringify(id)},timeout:30})]));`,
          });
          await until(
            () =>
              fixture.ends
                .slice(endCount)
                .some((end) => end.toolName === "bg_wait" && end.result.structuredContent?.wait_timed_out),
            5000,
            "short wait expires before completion",
          );
          assert.equal(fixture.ends.slice(endCount).filter((end) => end.toolName === "bg_wait").length, 1);
          await peer.ping();
          await peer.finish();
          const result = await bounded(waiting, 5000, "remaining concurrent waits finish");
          assert.equal(result.isError, false, resultText(result));
          const waits = fixture.ends.slice(endCount).filter((end) => end.toolName === "bg_wait");
          assert.equal(waits.length, 3);
          assert.equal(waits.filter((end) => end.result.structuredContent.wait_timed_out === false).length, 2);
          assert.deepEqual(notices(fixture, id), []);
        });
      });
      await t.test("an expired wait preserves the later completion notification", async () => {
        await usingJob(fixture, "direct", "bg_run", async ({ peer, id }) => {
          const expired = await fixture.invoke("bg_wait", { id, timeout: 0 }, "codemode");
          assert.equal(expired.value.wait_timed_out, true);
          assert.equal(expired.value.status, "running");
          assert.deepEqual(notices(fixture, id), []);
          await peer.ping();
          await peer.finish();
          await until(() => notices(fixture, id).length > 0, 5000, "notification after an expired wait");
          assert.equal(notices(fixture, id).length, 1);
        });
      });
      await t.test("a cancelled wait preserves execution and its later completion notification", async () => {
        await usingJob(fixture, "direct", "bg_run", async ({ peer, id }) => {
          const { waiting } = await pendingWait(fixture, id, "direct");
          await fixture.session.abort();
          const cancelled = await bounded(waiting, 5000, "wait is cancelled");
          assert.equal(cancelled.end.isError, true);
          assert.deepEqual(notices(fixture, id), []);
          await peer.ping();
          await peer.finish();
          await until(() => notices(fixture, id).length > 0, 5000, "notification after a cancelled wait");
          assert.equal(notices(fixture, id).length, 1);
        });
      });
    } finally {
      await fixture.dispose();
    }
  });
