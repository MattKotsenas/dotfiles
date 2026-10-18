// Real SDK refresh races, gated by promises rather than timing.
// No provider requests or installed SDK changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ai, sdk } from "./sdk.mjs";
import { trackModelRefreshes } from "./auth-adapter.mjs";

async function waitWhileHeld(wait, finish) {
  let completed = false;
  const waiting = wait().then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false, "waiting must include the newer, still-held refresh");
  for (const gate of finish) gate.release();
  await waiting;
}

function barrier() {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return { ready, release };
}

test("virtual routing checks usable credentials while a newer availability pass is pending", async () => {
  const store = new ai.InMemoryCredentialStore();
  await store.modify("openai", async () => ({ type: "api_key", key: "synthetic-not-sent" }));
  const entered = Array.from({ length: 3 }, barrier);
  const finish = Array.from({ length: 3 }, barrier);
  let enumerations = 0;
  const credentials = {
    read: (...args) => store.read(...args),
    modify: (...args) => store.modify(...args),
    delete: (...args) => store.delete(...args),
    async list(...args) {
      const index = enumerations++;
      if (index < entered.length) {
        entered[index].release();
        await finish[index].ready;
      }
      return store.list(...args);
    },
  };
  const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const wait = trackModelRefreshes(runtime);
  const physical = runtime.getModels("openai")[0];
  assert(physical, "builtin catalog must contain a physical OpenAI model");
  assert.equal(runtime.hasConfiguredAuth("openai"), false, "no availability pass has populated the initial snapshot");
  let refresh;
  let newest;
  try {
    runtime.registerVirtualModel({ provider: "race-router", id: "auto", thinkingLevels: ["off"], route: () => ({ model: physical, thinkingLevel: "off" }) });
    await entered[0].ready; // registration's automatic refresh is pending
    refresh = runtime.refresh({ allowNetwork: false });
    await entered[1].ready;
    newest = runtime.refresh({ allowNetwork: false });
    await entered[2].ready; // supersede the refresh that the caller awaits
    finish[1].release();
    const result = await refresh;
    assert.equal(result.errors.size, 0);
    assert.equal(runtime.hasConfiguredAuth("openai"), false, "superseded refresh leaves the initial snapshot in place");
    assert.equal((await runtime.checkAuth("openai")).type, "api_key", "the credential is usable despite the empty snapshot");
    await waitWhileHeld(wait, finish);
    const routed = await runtime.resolveModel(runtime.getModel("race-router", "auto"), [], { reason: "direct", thinkingLevel: "off" });
    assert.equal(routed.model.id, physical.id);
  } finally {
    for (const gate of finish) gate.release();
    await Promise.allSettled([refresh, newest]);
  }
});

test("an awaited catalog refresh publishes its account models even when superseded", async () => {
  const id = "catalog-race";
  const credentials = new ai.InMemoryCredentialStore();
  await credentials.modify(id, () => ({ type: "api_key", key: "synthetic-not-sent" }));
  const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const wait = trackModelRefreshes(runtime);
  const fake = ai.fauxProvider({ provider: id, models: [{ id: "base" }] });
  const entered = Array.from({ length: 3 }, barrier);
  const finish = Array.from({ length: 3 }, barrier);
  let calls = 0;
  let models = fake.provider.getModels();
  let refresh;
  let newest;
  try {
    runtime.registerNativeProvider({ ...fake.provider, getModels: () => models, getAllModels: () => models,
      async refreshModels(context) {
        const index = calls++;
        if (index < entered.length) {
          entered[index].release();
          await finish[index].ready;
        }
        await context.publish({ update() { models = [...fake.provider.getModels(), { ...fake.getModel(), id: "account-a" }]; } });
      },
    });
    assert.equal(runtime.getModel(id, "account-a"), undefined);
    await entered[0].ready;
    refresh = runtime.refresh({ allowNetwork: false });
    await entered[1].ready;
    newest = runtime.refresh({ allowNetwork: false });
    await entered[2].ready;
    const result = await refresh; // superseding aborts the older publication, without a caller abort
    assert.equal(result.errors.size, 0);
    assert.equal(result.aborted, false);
    await waitWhileHeld(wait, finish);
    const presentWhenCallerContinues = !!runtime.getModel(id, "account-a");
    for (const gate of finish) gate.release();
    await newest;
    assert(runtime.getModel(id, "account-a"), "the latest pass can publish the account model normally");
    assert(presentWhenCallerContinues, "the caller continued before the account model was published");
  } finally {
    for (const gate of finish) gate.release();
    await Promise.allSettled([refresh, newest]);
  }
});

test("cancellation stops waiting for a registration refresh without cancelling its publication", { timeout: 10000 }, async (t) => {
  const entered = barrier();
  const finish = barrier();
  t.after(() => finish.release());
  const store = new ai.InMemoryCredentialStore();
  const credentials = {
    read: (...args) => store.read(...args), modify: (...args) => store.modify(...args), delete: (...args) => store.delete(...args),
    async list(...args) { entered.release(); await finish.ready; return store.list(...args); },
  };
  const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const wait = trackModelRefreshes(runtime);
  runtime.registerNativeProvider(ai.fauxProvider({ provider: "wait-cancel", models: [{ id: "model" }] }).provider);
  await entered.ready;
  const controller = new AbortController();
  const waiting = wait(controller.signal);
  controller.abort(new Error("cancel child readiness"));
  await assert.rejects(waiting, /cancel child readiness/);
  finish.release();
  await wait();
  assert(runtime.getModel("wait-cancel", "model"));
});

test("a rejected refresh remains visible to a later waiter", async () => {
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const wait = trackModelRefreshes(runtime);
  let rejection;
  // Invalid caller input makes the real SDK reject, rather than returning its
  // normal best-effort result.errors. The tracker must not consume that rejection.
  await assert.rejects(runtime.refresh({ providers: 42 }), (error) => { rejection = error; return error instanceof TypeError; });
  await assert.rejects(wait(), (error) => error === rejection);
});
