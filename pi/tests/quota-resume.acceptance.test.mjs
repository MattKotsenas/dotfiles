import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, HOUR, MINUTE, quota, START, text, until } from "./quota-resume/fixture.mjs";

for (const transport of ["http", "sse", "sse-error"]) {
  for (const fields of [{ resets_at: (START + MINUTE) / 1000 }, { resets_in_seconds: 60 }]) {
    test(`${transport} ${JSON.stringify(fields)}: waits for reset plus grace, then completes without an extra user message`, {
      timeout: 10000,
    }, async (t) => {
      const f = await fixture(t);
      const resetAt = START + MINUTE;
      assert(resetAt > START);
      await f.start(quota(fields, transport), "Original task completed.");
      f.waiting();
      assert.equal(f.requests.length, 1);
      const initial = f.ui.message;
      await f.tick(MINUTE);
      assert.notEqual(f.ui.message, initial, "the countdown must update");
      await f.tick(29999);
      assert.equal(f.requests.length, 1, "the grace period must elapse before retrying");
      await f.tick(1);
      await f.done();
      assert.equal(f.requests.length, 2);
      assert.equal(f.requests[1].at, resetAt + 30000);
      assert.equal(f.session.getLastAssistantText(), "Original task completed.");
      assert.deepEqual(f.requests[1].messages.filter((m) => m.role === "user").map(text), [
        "Finish the original task.",
      ]);
      assert(!f.requests[1].messages.some((m) => m.role === "assistant" && m.stopReason === "error"));
      assert.equal(f.ui.message, undefined);
      assert.equal(f.ui.indicator, undefined);
      assert.equal(f.ui.notifications.length, 2, "notify on entry and successful recovery only");
      assert.match(f.osc.at(-1), /state=done/);
      assert(!f.osc.some((frame) => /state=(error|blocked)/.test(frame)));
    });
  }
}

test("unknown reset probes every fifteen minutes without repeating notifications", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.start(quota(), quota(), "Capacity returned.");
  f.waiting();
  await f.tick(15 * MINUTE - 1);
  assert.equal(f.requests.length, 1);
  await f.tick(1);
  await until(() => f.requests.length === 2 && f.ui.message?.includes("Press escape to cancel."));
  f.waiting();
  assert.equal(f.ui.notifications.length, 1);
  await f.tick(15 * MINUTE);
  await f.done();
  assert.deepEqual(
    f.requests.map((r) => r.at),
    [START, START + 15 * MINUTE, START + 30 * MINUTE],
  );
  assert.equal(f.session.getLastAssistantText(), "Capacity returned.");
});

test("steering, follow-ups and manual model/provider selection preserve the scheduled retry", {
  timeout: 10000,
}, async (t) => {
  const f = await fixture(t);
  await f.start(quota(), "Original task completed with steering.", "Follow-up completed.");
  f.waiting();
  assert.equal(await f.session.steer("Apply this correction."), "queued");
  assert.equal(await f.session.followUp("Do the follow-up."), "queued");
  await f.select("second", "manual-alternative");
  await f.tick(15 * MINUTE - 1);
  assert.equal(f.requests.length, 1);
  await f.tick(1);
  await f.done();
  assert.deepEqual(
    f.requests.map((r) => [r.provider, r.model]),
    [
      ["openai", "first"],
      ["manual-alternative", "second"],
      ["manual-alternative", "second"],
    ],
  );
  assert.deepEqual(f.requests[1].messages.filter((m) => m.role === "user").map(text), [
    "Finish the original task.",
    "Apply this correction.",
  ]);
  assert.deepEqual(f.requests[2].messages.filter((m) => m.role === "user").map(text), [
    "Finish the original task.",
    "Apply this correction.",
    "Do the follow-up.",
  ]);
});

test("Pi interruption cancels the wait and recovery permanently", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.start(quota(), "Must never run.");
  f.waiting();
  await f.session.abort();
  await f.done();
  await f.tick(6 * HOUR);
  assert.equal(f.requests.length, 1);
  assert.equal(f.ui.message, undefined);
  assert.equal(f.ui.indicator, undefined);
  assert.match(f.osc.at(-1), /state=idle/);
});

test("interrupt then reload cannot resurrect recovery", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.start(quota(), "Must never run.");
  f.waiting();
  await f.session.abort();
  await f.done();
  await f.session.reload();
  await f.tick(6 * HOUR);
  assert.equal(f.requests.length, 1);
  assert.equal(f.ui.message, undefined);
});

test("the default five-hour deadline ends recovery without probing before a later advertised reset", {
  timeout: 10000,
}, async (t) => {
  const f = await fixture(t);
  await f.start(quota({ resets_at: (START + 7 * HOUR) / 1000 }), "Must never run.");
  f.waiting();
  assert.match(f.ui.message, /Recovery times out/, "the deadline must not be advertised as another retry");
  await f.tick(5 * HOUR - 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.finished, false);
  await f.tick(1);
  await f.done();
  assert.equal(f.requests.length, 1);
  assert.match(f.ui.notifications.at(-1).message, /timed out/i);
  assert.match(f.osc.at(-1), /state=error/);
  assert.equal(f.ui.indicator, undefined);
});

test("repeated quota errors do not restart a configured recovery budget", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { settings: { openaiQuotaResume: { maxWaitMs: 30 * MINUTE } } });
  await f.start(quota(), quota(), "Must never run.");
  f.waiting();
  assert.match(f.ui.message, /Retrying in/);
  await f.tick(15 * MINUTE);
  await until(() => f.requests.length === 2 && f.ui.message?.includes("Recovery times out in 15m 0s"));
  f.waiting();
  await f.tick(15 * MINUTE - 1);
  assert.equal(f.finished, false, "recovery must stay active until the original deadline");
  assert.equal(f.ui.notifications.length, 1);
  await f.tick(1);
  await f.done();
  assert.match(f.ui.notifications.at(-1).message, /timed out/i);
  await f.tick(HOUR);
  assert.equal(f.requests.length, 2);
  assert.match(f.osc.at(-1), /state=error/);
});

for (const fields of [{ resets_at: START / 1000 }, { resets_in_seconds: 0 }]) {
  test(`a reset at the current instant still receives grace: ${JSON.stringify(fields)}`, {
    timeout: 10000,
  }, async (t) => {
    const f = await fixture(t);
    await f.start(quota(fields), "Recovered.");
    f.waiting();
    await f.tick(29999);
    assert.equal(f.requests.length, 1);
    await f.tick(1);
    await f.done();
    assert.equal(f.requests.length, 2);
  });
}

for (const fields of [{ resets_at: "tomorrow" }, { resets_at: 0 }, { resets_at: (START - HOUR) / 1000 }]) {
  test(`unusable reset data uses the probing interval: ${JSON.stringify(fields)}`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    await f.start(quota(fields), "Recovered.");
    f.waiting();
    await f.tick(15 * MINUTE - 1);
    assert.equal(f.requests.length, 1);
    await f.tick(1);
    await f.done();
    assert.equal(f.requests.length, 2);
  });
}

test("a different terminal error after a probe leaves Pi failed and clears waiting UI", {
  timeout: 10000,
}, async (t) => {
  const f = await fixture(t);
  await f.start(quota(), quota({ code: "insufficient_quota", message: "Billing exhausted." }));
  f.waiting();
  await f.tick(15 * MINUTE);
  await f.done();
  await f.tick(6 * HOUR);
  assert.equal(f.requests.length, 2);
  assert.match(f.osc.at(-1), /state=error/);
  assert.equal(f.ui.message, undefined);
  assert.equal(f.ui.indicator, undefined);
  assert.equal(f.ui.notifications.length, 1, "a failed probe is not successful recovery");
});

for (const options of [{ mode: "print" }, { mode: "rpc" }, { provider: "manual-alternative" }, { enabled: false }]) {
  test(`recovery stays inactive for ${JSON.stringify(options)}`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, options);
    await f.start(quota(), "Must never run.");
    await f.done();
    await f.tick(6 * HOUR);
    assert.equal(f.requests.length, 1);
    assert.equal(f.ui.message, undefined);
    assert.equal(f.ui.notifications.length, 0);
    assert.match(f.osc.at(-1), /state=error/);
  });
}

test("a non-quota code remains authoritative when its message mentions the quota code", {
  timeout: 10000,
}, async (t) => {
  const f = await fixture(t);
  await f.start(
    quota({
      code: "authentication_error",
      message: "Subscription configuration invalid; subscription_sharing_usage_limit_exceeded is not applicable.",
    }),
  );
  await f.done();
  assert.equal(f.requests.length, 1);
  assert.equal(f.ui.message, undefined);
  assert.equal(f.ui.notifications.length, 0);
  assert.match(f.osc.at(-1), /state=error/);
});

for (const message of [
  'Authentication failed. Diagnostic example: {"code":"subscription_sharing_usage_limit_exceeded"}',
  'Error Code authentication_error: {"code":"subscription_sharing_usage_limit_exceeded"}',
  'OpenAI API error (401): Authentication failed; example {"code":"subscription_sharing_usage_limit_exceeded"}',
  'OpenAI API error (429): {"code":"subscription_sharing_usage_limit_exceeded"} trailing text',
  'OpenAI API error (429): {"code":"subscription_sharing_usage_limit_exceeded",',
  "OpenAI API error (429): null",
]) {
  test(`unrelated or malformed normalized errors remain terminal: ${message}`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, { settings: { retry: { enabled: false } } });
    await f.start(quota({ message }, "normalized"));
    await f.done();
    await f.tick(6 * HOUR);
    assert.equal(f.requests.length, 1);
    assert.equal(f.ui.notifications.length, 0);
    assert.equal(f.ui.message, undefined);
    assert.match(f.osc.at(-1), /state=error/);
  });
}

test("an HTTP quota body without a message retains its relative reset", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.start(quota({ message: undefined, resets_in_seconds: 60 }), "Recovered.");
  f.waiting();
  await f.tick(MINUTE + 29999);
  assert.equal(f.requests.length, 1);
  await f.tick(1);
  await f.done();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].at, START + MINUTE + 30000);
});

test("repeated startup does not install recovery handlers twice", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.session.bindExtensions({ mode: "tui" });
  await f.start(quota(), "Recovered.");
  f.waiting();
  assert.equal(f.ui.notifications.length, 1);
  await f.tick(15 * MINUTE);
  await f.done();
  assert.equal(f.requests.length, 2);
  assert.equal(f.ui.notifications.length, 2);
});

test("Pi's named SSE error loses quota details and remains an ordinary terminal failure", {
  timeout: 10000,
}, async (t) => {
  const f = await fixture(t);
  await f.start(quota({ resets_in_seconds: 60 }, "named-error"));
  await f.done();
  assert.equal(f.requests.length, 1);
  assert.equal(f.ui.notifications.length, 0);
  assert.match(f.osc.at(-1), /state=error/);
});

test("runtime shutdown while waiting cancels recovery before replacing extensions", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.start(quota(), "Must never run.");
  f.waiting();
  await f.session.reload();
  await f.done();
  await f.tick(6 * HOUR);
  assert.equal(f.requests.length, 1);
  assert.equal(f.ui.message, undefined);
  assert.match(f.osc.at(-1), /state=idle/);
});

test("API billing exhaustion is left to Pi", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.start(quota({ code: "insufficient_quota", message: "Billing exhausted." }));
  await f.done();
  await f.tick(6 * HOUR);
  assert.equal(f.requests.length, 1);
  assert.equal(f.ui.notifications.length, 0);
  assert.match(f.osc.at(-1), /state=error/);
});

test("ordinary rate limits retain Pi's short retry policy", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.start(quota({ code: "rate_limit_exceeded", message: "Rate limit exceeded." }), "Native retry succeeded.");
  assert.equal(f.ui.message, undefined);
  await f.tick(2000);
  await f.done();
  assert.equal(f.requests.length, 2);
  assert.equal(f.ui.notifications.length, 0);
});

test("legacy Codex usage-limit wording recovers after its approximate reset", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { provider: "openai-codex" });
  await f.start(
    quota({ message: "You have hit your ChatGPT usage limit (plus plan). Try again in ~2 min." }),
    "Recovered.",
  );
  f.waiting();
  await f.tick(2 * MINUTE + 29999);
  assert.equal(f.requests.length, 1);
  await f.tick(1);
  await f.done();
  assert.equal(f.requests.length, 2);
});

for (const maxWaitMs of [0, -1, "five hours", null, 2147483648]) {
  test(`invalid recovery settings leave the quota error failed: ${JSON.stringify(maxWaitMs)}`, {
    timeout: 10000,
  }, async (t) => {
    const f = await fixture(t, { settings: { openaiQuotaResume: { maxWaitMs } } });
    await f.start(quota());
    await f.done();
    assert.equal(f.requests.length, 1);
    assert.match(f.ui.notifications.at(-1)?.message ?? "", /maxWaitMs/);
    assert.match(f.osc.at(-1), /state=error/);
  });
}
