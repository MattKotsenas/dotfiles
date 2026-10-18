// Independent sessions, routing and auth compatibility on the supported SDK.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ai, sdk } from "./sdk.mjs";
import { getParentCredentials } from "./auth-adapter.mjs";
import { jsonFile, unresolvedApiKey, refreshModels, createSession, inheritingSession } from "./resources.mjs";

const id = "delegation-auth-lifecycle";
const savedOAuth = (account, expires = Date.now() + 3600000) => ({
  type: "oauth", account, access: `oauth-${account}`, refresh: `refresh-${account}`, expires,
});

function provider(role, service, responses) {
  const fake = ai.fauxProvider({ provider: id, models: [{ id: "model" }], tokensPerSecond: 0 });
  if (responses) fake.setResponses(responses);
  const auth = (key) => ({ apiKey: key, headers: { "x-account": key }, baseUrl: `https://${key}.invalid` });
  return { ...fake.provider, auth: {
    apiKey: {
      name: "Synthetic key",
      resolve: async ({ credential }) => credential?.key ? { auth: auth(credential.key) } : undefined,
    },
    oauth: {
      name: "Synthetic subscription", isSubscription: true,
      login: async (interaction) => savedOAuth(await interaction.prompt({ type: "text", message: "account" })),
      refresh: async (current) => {
        service.refreshes.push({ role, token: current.refresh });
        return { ...savedOAuth(current.account), access: `rotated-${current.account}`, refresh: `rotated-refresh-${current.account}` };
      },
      toAuth: async (current) => auth(current.access),
    },
  }, streamSimple(model, context, options) {
    assert.equal(options.apiKey, service.expectedKey, "service rejects a stale or wrong key");
    assert.equal(options.headers["x-account"], service.expectedKey);
    assert.equal(model.baseUrl, `https://${service.expectedKey}.invalid`);
    service.requests.push({ role, context, key: options.apiKey });
    if (!responses) fake.setResponses([ai.fauxAssistantMessage(`${role}-done`)]);
    return fake.provider.streamSimple(model, context, options);
  } };
}

function observeSession(role, routes, hooks) {
  return (pi) => {
    pi.registerVirtualModel({ provider: id, id: "auto", thinkingLevels: ["off"], route(request, ctx) {
      routes.push({ role, turn: request.state?.turn ?? 0 });
      return { model: ctx.modelRegistry.find(id, "model"), thinkingLevel: "off", state: { turn: (request.state?.turn ?? 0) + 1 } };
    } });
    let count = 0;
    pi.on("after_provider_response", () => hooks.push({ role, count: ++count }));
  };
}

function assertStopped(session, expectedText) {
  const last = session.messages.findLast((message) => message.role === "assistant");
  assert.equal(last.stopReason, "stop", last.errorMessage);
  assert.equal(session.getLastAssistantText(), expectedText);
}

async function assertAuthFailure(session, prompt, requests) {
  const before = requests.length;
  let rejected;
  try { await session.prompt(prompt); } catch (error) { rejected = error; }
  if (rejected) assert.match(rejected.message, /auth|key|configured|resolver|refresh/i);
  else assert.equal(session.messages.findLast((message) => message.role === "assistant").stopReason, "error");
  assert.equal(requests.length, before, "auth failure must not reach the service");
}

test("existing child sees temporary key rotation and removal despite an unresolved configured key", async (t) => {
  const modelsPath = await jsonFile("models.json", { providers: { [id]: { apiKey: unresolvedApiKey() } } });
  const authPath = await jsonFile("auth.json", { [id]: { type: "api_key", key: "saved-a" } });
  const service = { expectedKey: "saved-a", requests: [], refreshes: [] };
  const routes = [];
  const hooks = [];
  let parentRegistry;
  const parentProvider = provider("parent", service);
  const { session: parent, waitForRefreshes: waitParent } = await createSession(t, {
    authPath, modelsPath, provider: parentProvider, systemPrompt: "parent instructions",
    extensionFactories: [
      observeSession("parent", routes, hooks),
      (pi) => {
        pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
      },
    ],
  });
  const parentRuntime = parent.modelRuntime;
  const { session: child, waitForRefreshes: waitChild } = await inheritingSession(t, parentRegistry, {
    modelsPath, systemPrompt: "child instructions",
    provider: provider("child", service),
    extensionFactories: [observeSession("child", routes, hooks)],
  });
  const childRuntime = child.modelRuntime;
  await parent.setModel(parentRuntime.getModel(id, "auto"));
  await child.setModel(childRuntime.getModel(id, "auto"));
  const saved = await readFile(authPath, "utf8");
  await child.prompt("FIRST");
  assertStopped(child, "child-done");
  for (const key of ["runtime-a", "runtime-b"]) {
    await parentRuntime.setRuntimeApiKey(id, key);
    service.expectedKey = key;
    await refreshModels(childRuntime, waitChild);
    assert.equal((await getParentCredentials(parentRegistry).read(id)).key, key);
    await child.prompt(key);
    assertStopped(child, "child-done");
  }
  await parentRuntime.removeRuntimeApiKey(id);
  service.expectedKey = "saved-a";
  await refreshModels(childRuntime, waitChild);
  await child.prompt("REMOVED");
  assertStopped(child, "child-done");
  assert.equal(await readFile(authPath, "utf8"), saved, "runtime keys must not reach auth.json");
  assert.match(JSON.stringify(service.requests.at(-1).context), /FIRST/);
});

test("OAuth, key override, removal, logout and another login retain history and correct status", async (t) => {
  const modelsPath = await jsonFile("models.json", { providers: { [id]: { apiKey: unresolvedApiKey() } } });
  const authPath = await jsonFile("auth.json", { [id]: savedOAuth("a") });
  const service = { expectedKey: "oauth-a", requests: [], refreshes: [] };
  const routes = [];
  const hooks = [];
  let parentRegistry;
  const parentProvider = provider("parent", service);
  const { session: parent, waitForRefreshes: waitParent } = await createSession(t, {
    authPath, modelsPath, provider: parentProvider, systemPrompt: "parent instructions",
    extensionFactories: [
      observeSession("parent", routes, hooks),
      (pi) => {
        pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
      },
    ],
  });
  const parentRuntime = parent.modelRuntime;
  const { session: child, waitForRefreshes: waitChild } = await inheritingSession(t, parentRegistry, {
    modelsPath, systemPrompt: "child instructions",
    provider: provider("child", service),
    extensionFactories: [observeSession("child", routes, hooks)],
  });
  const childRuntime = child.modelRuntime;
  await parent.setModel(parentRuntime.getModel(id, "auto"));
  await child.setModel(childRuntime.getModel(id, "auto"));
  await child.prompt("FIRST");
  assertStopped(child, "child-done");
  assert(childRuntime.isUsingSubscription(id));
  await parentRuntime.setRuntimeApiKey(id, "runtime-key");
  service.expectedKey = "runtime-key";
  await refreshModels(childRuntime, waitChild);
  assert.equal(childRuntime.isUsingOAuth(id), false, "temporary-key override must replace OAuth status");
  await child.prompt("OVERRIDE");
  assertStopped(child, "child-done");
  await parentRuntime.removeRuntimeApiKey(id);
  service.expectedKey = "oauth-a";
  await refreshModels(childRuntime, waitChild);
  assert(childRuntime.isUsingSubscription(id));
  await child.prompt("RESTORED");
  assertStopped(child, "child-done");
  await parentRuntime.logout(id);
  await refreshModels(childRuntime, waitChild);
  assert.equal(await getParentCredentials(parentRegistry).read(id), undefined);
  assert.equal(parentRuntime.hasConfiguredAuth(id), false, "parent availability must reflect logout");
  assert.equal(childRuntime.hasConfiguredAuth(id), false, JSON.stringify({
    error: childRuntime.getError(), auth: await childRuntime.checkAuth(id),
  }));
  await assertAuthFailure(child, "LOGGED_OUT", service.requests);
  await parentRuntime.login(id, "oauth", { prompt: async () => "b", notify: () => {} });
  service.expectedKey = "oauth-b";
  await refreshModels(childRuntime, waitChild);
  await child.prompt("NEW_ACCOUNT");
  assertStopped(child, "child-done");
  assert(childRuntime.isUsingSubscription(id));
  assert.match(JSON.stringify(service.requests.at(-1).context), /FIRST/);
});

test("OAuth refresh persists once and the parent reuses rotated tokens", async (t) => {
  const modelsPath = await jsonFile("models.json", { providers: { [id]: { apiKey: unresolvedApiKey() } } });
  const authPath = await jsonFile("auth.json", { [id]: savedOAuth("a", 0) });
  const service = { expectedKey: "rotated-a", requests: [], refreshes: [] };
  const routes = [];
  const hooks = [];
  let parentRegistry;
  const parentProvider = provider("parent", service);
  const { session: parent, waitForRefreshes: waitParent } = await createSession(t, {
    authPath, modelsPath, provider: parentProvider, systemPrompt: "parent instructions",
    extensionFactories: [
      observeSession("parent", routes, hooks),
      (pi) => {
        pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
      },
    ],
  });
  const parentRuntime = parent.modelRuntime;
  const { session: child, waitForRefreshes: waitChild } = await inheritingSession(t, parentRegistry, {
    modelsPath, systemPrompt: "child instructions",
    provider: provider("child", service),
    extensionFactories: [observeSession("child", routes, hooks)],
  });
  const childRuntime = child.modelRuntime;
  await parent.setModel(parentRuntime.getModel(id, "auto"));
  await child.setModel(childRuntime.getModel(id, "auto"));
  await child.prompt("CHILD_REFRESH");
  assertStopped(child, "child-done");
  assert.equal(JSON.parse(await readFile(authPath, "utf8"))[id].refresh, "rotated-refresh-a");
  await parent.prompt("PARENT_REUSES");
  assertStopped(parent, "parent-done");
  assert.equal(service.refreshes.length, 1);
  assert.equal(service.refreshes[0].role, "parent", "the existing wrapper retains the parent's OAuth implementation");
});

test("temporary-only credentials work without saving them, and removal blocks existing children", async (t) => {
  const modelsPath = await jsonFile("models.json", { providers: { [id]: { apiKey: unresolvedApiKey() } } });
  const authPath = await jsonFile("auth.json", {});
  const service = { expectedKey: "temporary-only", requests: [], refreshes: [] };
  const routes = [];
  const hooks = [];
  let parentRegistry;
  const parentProvider = provider("parent", service);
  const { session: parent, waitForRefreshes: waitParent } = await createSession(t, {
    authPath, modelsPath, provider: parentProvider, systemPrompt: "parent instructions",
    extensionFactories: [
      observeSession("parent", routes, hooks),
      (pi) => {
        pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
      },
    ],
  });
  const parentRuntime = parent.modelRuntime;
  await parentRuntime.setRuntimeApiKey(id, "temporary-only");
  await refreshModels(parentRuntime, waitParent);
  const { session: child, waitForRefreshes: waitChild } = await inheritingSession(t, parentRegistry, {
    modelsPath, systemPrompt: "child instructions",
    provider: provider("child", service),
    extensionFactories: [observeSession("child", routes, hooks)],
  });
  const childRuntime = child.modelRuntime;
  await parent.setModel(parentRuntime.getModel(id, "auto"));
  await child.setModel(childRuntime.getModel(id, "auto"));
  assert.equal(await readFile(authPath, "utf8"), "{}");
  await child.prompt("FIRST_TEMPORARY_TURN");
  assertStopped(child, "child-done");
  await parentRuntime.removeRuntimeApiKey(id);
  await refreshModels(childRuntime, waitChild);
  await assertAuthFailure(child, "OVERRIDE_REMOVED", service.requests);
  await parentRuntime.setRuntimeApiKey(id, "another-temporary-key");
  service.expectedKey = "another-temporary-key";
  await refreshModels(childRuntime, waitChild);
  await child.prompt("KEY_RESTORED");
  assertStopped(child, "child-done");
  assert.match(JSON.stringify(service.requests.at(-1).context), /FIRST_TEMPORARY_TURN/);
  assert.equal(await readFile(authPath, "utf8"), "{}");
});

test("a key changed during a child tool reaches the next request of the same invocation", async (t) => {
  const modelsPath = await jsonFile("models.json", { providers: { [id]: { apiKey: unresolvedApiKey() } } });
  const authPath = await jsonFile("auth.json", { [id]: { type: "api_key", key: "saved-a" } });
  const service = { expectedKey: "saved-a", requests: [], refreshes: [] };
  const routes = [];
  const hooks = [];
  let parentRegistry;
  const parentProvider = provider("parent", service);
  const { session: parent, waitForRefreshes: waitParent } = await createSession(t, {
    authPath, modelsPath, provider: parentProvider, systemPrompt: "parent instructions",
    extensionFactories: [
      observeSession("parent", routes, hooks),
      (pi) => {
        pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
      },
    ],
  });
  const parentRuntime = parent.modelRuntime;
  const { session: child, waitForRefreshes: waitChild } = await inheritingSession(t, parentRegistry, {
    modelsPath, systemPrompt: "child instructions",
    provider: provider("child", service, [
      ai.fauxAssistantMessage(ai.fauxToolCall("rotate_key", {}), { stopReason: "toolUse" }),
      ai.fauxAssistantMessage("child-done"),
    ]),
    tools: ["rotate_key"],
    extensionFactories: [observeSession("child", routes, hooks), (pi) => pi.registerTool({
      name: "rotate_key", label: "Rotate synthetic key", description: "Rotate the parent test key.", parameters: ai.Type.Object({}),
      async execute() {
        await parentRuntime.setRuntimeApiKey(id, "rotated-during-tool");
        service.expectedKey = "rotated-during-tool";
        return { content: [{ type: "text", text: "rotated" }], details: undefined };
      },
    })],
  });
  const childRuntime = child.modelRuntime;
  await parent.setModel(parentRuntime.getModel(id, "auto"));
  await child.setModel(childRuntime.getModel(id, "auto"));
  const saved = await readFile(authPath, "utf8");
  assert.deepEqual(child.getActiveToolNames(), ["rotate_key"]);
  await child.prompt("ROTATE_DURING_TOOL");
  assertStopped(child, "child-done");
  assert.deepEqual(service.requests.map((request) => request.key), ["saved-a", "rotated-during-tool"]);
  assert.equal(await readFile(authPath, "utf8"), saved);
});

test("concurrent parent and child OAuth requests refresh a rotated token only once", async (t) => {
  const modelsPath = await jsonFile("models.json", { providers: { [id]: { apiKey: unresolvedApiKey() } } });
  const authPath = await jsonFile("auth.json", { [id]: savedOAuth("a", 0) });
  const service = { expectedKey: "rotated-a", requests: [], refreshes: [] };
  const routes = [];
  const hooks = [];
  let parentRegistry;
  const parentProvider = provider("parent", service);
  const { session: parent, waitForRefreshes: waitParent } = await createSession(t, {
    authPath, modelsPath, provider: parentProvider, systemPrompt: "parent instructions",
    extensionFactories: [
      observeSession("parent", routes, hooks),
      (pi) => {
        pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
      },
    ],
  });
  const parentRuntime = parent.modelRuntime;
  const { session: child, waitForRefreshes: waitChild } = await inheritingSession(t, parentRegistry, {
    modelsPath, systemPrompt: "child instructions",
    provider: provider("child", service),
    extensionFactories: [observeSession("child", routes, hooks)],
  });
  const childRuntime = child.modelRuntime;
  await parent.setModel(parentRuntime.getModel(id, "auto"));
  await child.setModel(childRuntime.getModel(id, "auto"));
  await Promise.all([parent.prompt("PARENT_CONCURRENT"), child.prompt("CHILD_CONCURRENT")]);
  assertStopped(parent, "parent-done");
  assertStopped(child, "child-done");
  assert.equal(service.requests.length, 2);
  assert.equal(service.refreshes.length, 1);
  assert.equal(JSON.parse(await readFile(authPath, "utf8"))[id].refresh, "rotated-refresh-a");
});

test("failed OAuth refresh preserves credentials and makes no service request", async (t) => {
  const modelsPath = await jsonFile("models.json", { providers: { [id]: { apiKey: unresolvedApiKey() } } });
  const authPath = await jsonFile("auth.json", { [id]: savedOAuth("a", 0) });
  const service = { expectedKey: "oauth-a", requests: [], refreshes: [] };
  const routes = [];
  const hooks = [];
  let parentRegistry;
  let parentExtension;
  const parentProvider = provider("parent", service);
  const { session: parent, waitForRefreshes: waitParent } = await createSession(t, {
    authPath, modelsPath, provider: parentProvider, systemPrompt: "parent instructions",
    extensionFactories: [
      observeSession("parent", routes, hooks),
      (pi) => {
        parentExtension = pi;
        pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
      },
    ],
  });
  const parentRuntime = parent.modelRuntime;
  const { session: child, waitForRefreshes: waitChild } = await inheritingSession(t, parentRegistry, {
    modelsPath, systemPrompt: "child instructions",
    provider: provider("child", service),
    extensionFactories: [observeSession("child", routes, hooks)],
  });
  const childRuntime = child.modelRuntime;
  await parent.setModel(parentRuntime.getModel(id, "auto"));
  await child.setModel(childRuntime.getModel(id, "auto"));
  const before = JSON.parse(await readFile(authPath, "utf8"))[id];
  const original = parentProvider;
  parentExtension.registerProvider({ ...original, auth: { ...original.auth, oauth: {
    ...original.auth.oauth,
    async refresh(current) {
      service.refreshes.push({ role: "parent", token: current.refresh });
      throw new Error("refresh rejected");
    },
  } } });
  await parentRuntime.refresh({ allowNetwork: false });
  await waitParent();
  await refreshModels(childRuntime, waitChild);
  await assertAuthFailure(child, "FAILED_REFRESH", service.requests);
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8"))[id], before);
  assert.equal(service.refreshes.length, 1);
});

for (const oauth of [false, true]) {
  test(`${oauth ? "OAuth" : "key"} resolver changes remain live, routers and hooks remain independent`, async (t) => {
    const modelsPath = await jsonFile("models.json", { providers: { [id]: { apiKey: unresolvedApiKey() } } });
    const authPath = await jsonFile("auth.json", { [id]: oauth ? savedOAuth("a") : { type: "api_key", key: "saved-a" } });
    const service = { expectedKey: oauth ? "oauth-a" : "saved-a", requests: [], refreshes: [] };
    const routes = [];
    const hooks = [];
    let parentRegistry;
    let parentExtension;
    const parentProvider = provider("parent", service);
    const { session: parent, waitForRefreshes: waitParent } = await createSession(t, {
      authPath, modelsPath, provider: parentProvider, systemPrompt: "parent instructions",
      extensionFactories: [
        observeSession("parent", routes, hooks),
        (pi) => {
          parentExtension = pi;
          pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
        },
      ],
    });
    const parentRuntime = parent.modelRuntime;
    const { session: child, waitForRefreshes: waitChild } = await inheritingSession(t, parentRegistry, {
      modelsPath, systemPrompt: "child instructions",
      provider: provider("child", service),
      extensionFactories: [observeSession("child", routes, hooks)],
    });
    const childRuntime = child.modelRuntime;
    await parent.setModel(parentRuntime.getModel(id, "auto"));
    await child.setModel(childRuntime.getModel(id, "auto"));
    const before = await readFile(authPath, "utf8");
    await child.prompt("FIRST");
    assertStopped(child, "child-done");
    const resolve = async () => ({ auth: {
      apiKey: "extension-replacement", headers: { "x-account": "extension-replacement" },
      baseUrl: "https://extension-replacement.invalid",
    } });
    parentExtension.registerProvider({ ...parentProvider, auth: {
      apiKey: { name: "Replacement key", resolve },
      oauth: { ...parentProvider.auth.oauth, isSubscription: false, toAuth: async () => (await resolve()).auth },
    } });
    await refreshModels(parentRuntime, waitParent);
    service.expectedKey = "extension-replacement";
    await refreshModels(childRuntime, waitChild);
    await child.prompt("REPLACED");
    assertStopped(child, "child-done");
    assert.equal(childRuntime.isUsingSubscription(id), false);
    const rejectAuth = async () => { throw new Error("parent resolver failed"); };
    parentExtension.registerProvider({ ...parentProvider, auth: {
      apiKey: { name: "Replacement key", resolve: rejectAuth },
      oauth: { ...parentProvider.auth.oauth, isSubscription: false, toAuth: rejectAuth },
    } });
    await refreshModels(parentRuntime, waitParent);
    await refreshModels(childRuntime, waitChild);
    await assertAuthFailure(child, "FAILED_RESOLVER", service.requests);
    assert.equal(await readFile(authPath, "utf8"), before);
    parentExtension.registerProvider(parentProvider);
    await parentRuntime.refresh({ allowNetwork: false });
    await waitParent();
    service.expectedKey = oauth ? "oauth-a" : "saved-a";
    child.dispose();
    await parent.prompt("PARENT_AFTER_CHILD_DISPOSAL");
    assertStopped(parent, "parent-done");
    assert.deepEqual(hooks, [{ role: "child", count: 1 }, { role: "child", count: 2 }, { role: "parent", count: 1 }]);
    assert.deepEqual(routes.filter((route) => route.role === "parent"), [{ role: "parent", turn: 0 }]);
  });
}

for (const oauth of [false, true]) {
  test(`parent ${oauth ? "OAuth" : "key"} resolver failure must block child requests`, async (t) => {
    const modelsPath = await jsonFile("models.json", { providers: { [id]: { apiKey: unresolvedApiKey() } } });
    const authPath = await jsonFile("auth.json", { [id]: oauth ? savedOAuth("a") : { type: "api_key", key: "saved-a" } });
    const service = { expectedKey: oauth ? "oauth-a" : "saved-a", requests: [], refreshes: [] };
    const routes = [];
    const hooks = [];
    let parentRegistry;
    let parentExtension;
    const parentProvider = provider("parent", service);
    const { session: parent, waitForRefreshes: waitParent } = await createSession(t, {
      authPath, modelsPath, provider: parentProvider, systemPrompt: "parent instructions",
      extensionFactories: [
        observeSession("parent", routes, hooks),
        (pi) => {
          parentExtension = pi;
          pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
        },
      ],
    });
    const parentRuntime = parent.modelRuntime;
    const { session: child, waitForRefreshes: waitChild } = await inheritingSession(t, parentRegistry, {
      modelsPath, systemPrompt: "child instructions",
      provider: provider("child", service),
      extensionFactories: [observeSession("child", routes, hooks)],
    });
    const childRuntime = child.modelRuntime;
    await parent.setModel(parentRuntime.getModel(id, "auto"));
    await child.setModel(childRuntime.getModel(id, "auto"));
    await child.prompt("FIRST");
    assertStopped(child, "child-done");
    const rejectAuth = async () => { throw new Error("parent resolver failed"); };
    parentExtension.registerProvider({ ...parentProvider, auth: {
      apiKey: { name: "Replacement key", resolve: rejectAuth },
      oauth: { ...parentProvider.auth.oauth, isSubscription: false, toAuth: rejectAuth },
    } });
    await refreshModels(parentRuntime, waitParent);
    await refreshModels(childRuntime, waitChild);
    const before = service.requests.length;
    let rejected;
    try { await child.prompt("PARENT_AUTH_FAILED"); } catch (error) { rejected = error; }
    assert.equal(service.requests.length, before, "a parent resolver failure must block child requests");
    if (rejected) assert.match(rejected.message, /auth|resolver|key/i);
    else assert.equal(child.messages.findLast((message) => message.role === "assistant").stopReason, "error");
  });
}
test("stable auth retains independent child and parent routers/hooks after child disposal", async (t) => {
  const modelsPath = await jsonFile("models.json", { providers: { [id]: { apiKey: unresolvedApiKey() } } });
  const authPath = await jsonFile("auth.json", { [id]: { type: "api_key", key: "saved-a" } });
  const service = { expectedKey: "saved-a", requests: [], refreshes: [] };
  const routes = [];
  const hooks = [];
  let parentRegistry;
  const parentProvider = provider("parent", service);
  const { session: parent, waitForRefreshes: waitParent } = await createSession(t, {
    authPath, modelsPath, provider: parentProvider, systemPrompt: "parent instructions",
    extensionFactories: [
      observeSession("parent", routes, hooks),
      (pi) => {
        pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
      },
    ],
  });
  const parentRuntime = parent.modelRuntime;
  const { session: child, waitForRefreshes: waitChild } = await inheritingSession(t, parentRegistry, {
    modelsPath, systemPrompt: "child instructions",
    provider: provider("child", service),
    extensionFactories: [observeSession("child", routes, hooks)],
  });
  const childRuntime = child.modelRuntime;
  await parent.setModel(parentRuntime.getModel(id, "auto"));
  await child.setModel(childRuntime.getModel(id, "auto"));
  await child.prompt("FIRST");
  assertStopped(child, "child-done");
  await child.prompt("SECOND");
  assertStopped(child, "child-done");
  child.dispose();
  await parent.prompt("PARENT_AFTER_CHILD");
  assertStopped(parent, "parent-done");
  assert.deepEqual(hooks, [{ role: "child", count: 1 }, { role: "child", count: 2 }, { role: "parent", count: 1 }]);
  assert.deepEqual(routes, [{ role: "child", turn: 0 }, { role: "child", turn: 1 }, { role: "parent", turn: 0 }]);
});
