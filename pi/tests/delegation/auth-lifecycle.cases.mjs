// Independent sessions, routing and auth compatibility on the supported SDK.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ai, sdk } from "./sdk.mjs";
import { getParentCredentials, inheritParentAuth, trackModelRefreshes } from "./auth-adapter.mjs";

const fixtures = process.env.PI_DELEGATION_AUTH_FIXTURES;
if (!fixtures) throw new Error("Run through pi/tests/delegation.auth.test.mjs.");
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

async function createSession(t, { root, role, runtime, model, extensions, tools }) {
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", defaultTools: [],
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: extensions, systemPrompt: `${role} instructions`,
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({
    cwd: root, agentDir: root, modelRuntime: runtime, settingsManager, resourceLoader,
    model, thinkingLevel: "off", tools,
    sessionManager: sdk.SessionManager.inMemory(root),
  });
  t.after(async () => { await session.abort(); session.dispose(); });
  await session.bindExtensions({ mode: "print" });
  return session;
}

async function replaceParentAuth(h, resolve) {
  const { provider, extension, runtime, waitForRefreshes } = h.parent;
  extension.registerProvider({ ...provider, auth: {
    apiKey: { name: "Replacement key", resolve },
    oauth: { ...provider.auth.oauth, isSubscription: false, toAuth: async () => (await resolve()).auth },
  } });
  await runtime.refresh({ allowNetwork: false, providers: [id] });
  await waitForRefreshes();
}

async function fixture(t, {
  credential = { type: "api_key", key: "saved-a" }, runtimeApiKey,
  expectedKey = runtimeApiKey ?? credential?.key ?? credential?.access,
  childTools = [], childExtension, childResponses,
} = {}) {
  // The runner deletes these files after this process exits. SDK background
  // refreshes have no public drain method and can recreate auth.json during rm().
  const root = await mkdtemp(join(fixtures, "delegation-auth-lifecycle-"));
  const authPath = join(root, "auth.json");
  const modelsPath = join(root, "models.json");

  const variable = `PI_UNSET_${randomUUID().replaceAll("-", "_")}`;
  assert.equal(process.env[variable], undefined);
  await writeFile(modelsPath, JSON.stringify({ providers: { [id]: { apiKey: `$${variable}` } } }));
  await writeFile(authPath, JSON.stringify(credential ? { [id]: credential } : {}));
  let parentRegistry;
  const requests = [];
  const routes = [];
  const hooks = [];
  const refreshes = [];
  const service = { expectedKey, requests, refreshes };
  async function create(role, credentials) {
    const runtime = await sdk.ModelRuntime.create({
      ...(credentials ? { credentials } : { authPath }), modelsPath, refreshOnCreate: false,
    });
    if (role === "child") await inheritParentAuth(runtime, parentRegistry);
    const waitForRefreshes = trackModelRefreshes(runtime);
    const registered = provider(role, service, role === "child" ? childResponses : undefined);
    let extension;
    const factory = (pi) => {
      extension = pi;
      pi.registerProvider(registered);
      pi.registerVirtualModel({ provider: id, id: "auto", thinkingLevels: ["off"], route(request, ctx) {
        routes.push({ role, turn: request.state?.turn ?? 0 });
        return { model: ctx.modelRegistry.find(id, "model"), thinkingLevel: "off", state: { turn: (request.state?.turn ?? 0) + 1 } };
      } });
      let count = 0;
      pi.on("after_provider_response", () => hooks.push({ role, count: ++count }));
      if (role === "parent") {
        pi.on("session_start", (_event, ctx) => { parentRegistry = ctx.modelRegistry; });
      }
    };
    const session = await createSession(t, {
      root, role, runtime, model: registered.getModels()[0],
      extensions: [factory, ...(role === "child" && childExtension ? [childExtension] : [])],
      tools: role === "child" ? childTools : [],
    });
    return { session, runtime, provider: registered, extension, waitForRefreshes };
  }
  const parent = await create("parent");
  if (runtimeApiKey !== undefined) await parent.runtime.setRuntimeApiKey(id, runtimeApiKey);
  await parent.runtime.refresh({ allowNetwork: false });
  await parent.waitForRefreshes();
  const child = await create("child", getParentCredentials(parentRegistry));
  const prepare = async () => {
    const result = await child.runtime.refresh({ allowNetwork: false });
    assert.equal(result.errors.size, 0);
    await child.waitForRefreshes();
  };
  await prepare();
  await parent.session.setModel(parent.runtime.getModel(id, "auto"));
  await child.session.setModel(child.runtime.getModel(id, "auto"));
  async function success(target, prompt) {
    await target.session.prompt(prompt);
    const last = target.session.messages.findLast((message) => message.role === "assistant");
    assert.equal(last.stopReason, "stop", last.errorMessage);
    assert.equal(target.session.getLastAssistantText(), target === parent ? "parent-done" : "child-done");
  }
  async function failure(prompt) {
    const before = requests.length;
    let rejected;
    try { await child.session.prompt(prompt); } catch (error) { rejected = error; }
    if (rejected) assert.match(rejected.message, /auth|key|configured|resolver|refresh/i);
    else assert.equal(child.session.messages.findLast((message) => message.role === "assistant").stopReason, "error");
    assert.equal(requests.length, before, "auth failure must not reach the service");
  }
  return { parent, child, parentRegistry, prepare, success, failure, requests, routes, hooks, refreshes,
    stored: async () => JSON.parse(await readFile(authPath, "utf8"))[id],
    file: () => readFile(authPath, "utf8"),
    service,
  };
}

test("existing child sees temporary key rotation and removal despite an unresolved configured key", async (t) => {
  const h = await fixture(t);
  const saved = await h.file();
  await h.success(h.child, "FIRST");
  for (const key of ["runtime-a", "runtime-b"]) {
    await h.parent.runtime.setRuntimeApiKey(id, key);
    h.service.expectedKey = key;
    await h.prepare();
    assert.equal((await getParentCredentials(h.parentRegistry).read(id)).key, key);
    await h.success(h.child, key);
  }
  await h.parent.runtime.removeRuntimeApiKey(id);
  h.service.expectedKey = "saved-a";
  await h.prepare();
  await h.success(h.child, "REMOVED");
  assert.equal(await h.file(), saved, "runtime keys must not reach auth.json");
  assert.match(JSON.stringify(h.requests.at(-1).context), /FIRST/);
});

test("OAuth, key override, removal, logout and another login retain history and correct status", async (t) => {
  const h = await fixture(t, { credential: savedOAuth("a") });
  await h.success(h.child, "FIRST");
  assert(h.child.runtime.isUsingSubscription(id));
  await h.parent.runtime.setRuntimeApiKey(id, "runtime-key");
  h.service.expectedKey = "runtime-key";
  await h.prepare();
  assert.equal(h.child.runtime.isUsingOAuth(id), false, "temporary-key override must replace OAuth status");
  await h.success(h.child, "OVERRIDE");
  await h.parent.runtime.removeRuntimeApiKey(id);
  h.service.expectedKey = "oauth-a";
  await h.prepare();
  assert(h.child.runtime.isUsingSubscription(id));
  await h.success(h.child, "RESTORED");
  await h.parent.runtime.logout(id);
  await h.prepare();
  assert.equal(await getParentCredentials(h.parentRegistry).read(id), undefined);
  assert.equal(h.parent.runtime.hasConfiguredAuth(id), false, "parent availability must reflect logout");
  assert.equal(h.child.runtime.hasConfiguredAuth(id), false, JSON.stringify({
    error: h.child.runtime.getError(), auth: await h.child.runtime.checkAuth(id),
  }));
  await h.failure("LOGGED_OUT");
  await h.parent.runtime.login(id, "oauth", { prompt: async () => "b", notify: () => {} });
  h.service.expectedKey = "oauth-b";
  await h.prepare();
  await h.success(h.child, "NEW_ACCOUNT");
  assert(h.child.runtime.isUsingSubscription(id));
  assert.match(JSON.stringify(h.requests.at(-1).context), /FIRST/);
});

test("OAuth refresh persists once and the parent reuses rotated tokens", async (t) => {
  const h = await fixture(t, { credential: savedOAuth("a", 0), expectedKey: "rotated-a" });
  await h.success(h.child, "CHILD_REFRESH");
  assert.equal((await h.stored()).refresh, "rotated-refresh-a");
  await h.success(h.parent, "PARENT_REUSES");
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.refreshes[0].role, "parent", "the existing wrapper retains the parent's OAuth implementation");
});

test("temporary-only credentials work without saving them, and removal blocks existing children", async (t) => {
  const h = await fixture(t, { credential: null, runtimeApiKey: "temporary-only" });
  assert.equal(await h.file(), "{}");
  await h.success(h.child, "FIRST_TEMPORARY_TURN");
  await h.parent.runtime.removeRuntimeApiKey(id);
  await h.prepare();
  await h.failure("OVERRIDE_REMOVED");
  await h.parent.runtime.setRuntimeApiKey(id, "another-temporary-key");
  h.service.expectedKey = "another-temporary-key";
  await h.prepare();
  await h.success(h.child, "KEY_RESTORED");
  assert.match(JSON.stringify(h.requests.at(-1).context), /FIRST_TEMPORARY_TURN/);
  assert.equal(await h.file(), "{}");
});

test("a key changed during a child tool reaches the next request of the same invocation", async (t) => {
  let h;
  h = await fixture(t, {
    childTools: ["rotate_key"],
    childResponses: [
      ai.fauxAssistantMessage(ai.fauxToolCall("rotate_key", {}), { stopReason: "toolUse" }),
      ai.fauxAssistantMessage("child-done"),
    ],
    childExtension(pi) {
      pi.registerTool({
        name: "rotate_key", label: "Rotate synthetic key", description: "Rotate the parent test key.", parameters: ai.Type.Object({}),
        async execute() {
          await h.parent.runtime.setRuntimeApiKey(id, "rotated-during-tool");
          h.service.expectedKey = "rotated-during-tool";
          return { content: [{ type: "text", text: "rotated" }], details: undefined };
        },
      });
    },
  });
  const saved = await h.file();
  assert.deepEqual(h.child.session.getActiveToolNames(), ["rotate_key"]);
  await h.success(h.child, "ROTATE_DURING_TOOL");
  assert.deepEqual(h.requests.map((request) => request.key), ["saved-a", "rotated-during-tool"]);
  assert.equal(await h.file(), saved);
});

test("concurrent parent and child OAuth requests refresh a rotated token only once", async (t) => {
  const h = await fixture(t, { credential: savedOAuth("a", 0), expectedKey: "rotated-a" });
  await Promise.all([h.success(h.parent, "PARENT_CONCURRENT"), h.success(h.child, "CHILD_CONCURRENT")]);
  assert.equal(h.requests.length, 2);
  assert.equal(h.refreshes.length, 1);
  assert.equal((await h.stored()).refresh, "rotated-refresh-a");
});

test("failed OAuth refresh preserves credentials and makes no service request", async (t) => {
  const h = await fixture(t, { credential: savedOAuth("a", 0) });
  const before = await h.stored();
  const original = h.parent.provider;
  h.parent.extension.registerProvider({ ...original, auth: { ...original.auth, oauth: {
    ...original.auth.oauth,
    async refresh(current) {
      h.refreshes.push({ role: "parent", token: current.refresh });
      throw new Error("refresh rejected");
    },
  } } });
  await h.parent.runtime.refresh({ allowNetwork: false });
  await h.parent.waitForRefreshes();
  await h.prepare();
  await h.failure("FAILED_REFRESH");
  assert.deepEqual(await h.stored(), before);
  assert.equal(h.refreshes.length, 1);
});

for (const oauth of [false, true]) {
  test(`${oauth ? "OAuth" : "key"} resolver changes remain live, routers and hooks remain independent`, async (t) => {
    const h = await fixture(t, { credential: oauth ? savedOAuth("a") : { type: "api_key", key: "saved-a" } });
    const before = await h.file();
    await h.success(h.child, "FIRST");
    await replaceParentAuth(h, async () => ({ auth: {
      apiKey: "extension-replacement", headers: { "x-account": "extension-replacement" },
      baseUrl: "https://extension-replacement.invalid",
    } }));
    h.service.expectedKey = "extension-replacement";
    await h.prepare();
    await h.success(h.child, "REPLACED");
    assert.equal(h.child.runtime.isUsingSubscription(id), false);
    await replaceParentAuth(h, async () => { throw new Error("parent resolver failed"); });
    await h.prepare();
    await h.failure("FAILED_RESOLVER");
    assert.equal(await h.file(), before);
    h.parent.extension.registerProvider(h.parent.provider);
    await h.parent.runtime.refresh({ allowNetwork: false });
    await h.parent.waitForRefreshes();
    h.service.expectedKey = oauth ? "oauth-a" : "saved-a";
    h.child.session.dispose();
    await h.success(h.parent, "PARENT_AFTER_CHILD_DISPOSAL");
    assert.deepEqual(h.hooks, [{ role: "child", count: 1 }, { role: "child", count: 2 }, { role: "parent", count: 1 }]);
    assert.deepEqual(h.routes.filter((route) => route.role === "parent"), [{ role: "parent", turn: 0 }]);
  });
}

for (const oauth of [false, true]) {
  test(`parent ${oauth ? "OAuth" : "key"} resolver failure must block child requests`, async (t) => {
    const h = await fixture(t, { credential: oauth ? savedOAuth("a") : { type: "api_key", key: "saved-a" } });
    await h.success(h.child, "FIRST");
    await replaceParentAuth(h, async () => { throw new Error("parent resolver failed"); });
    await h.prepare();
    const before = h.requests.length;
    let rejected;
    try { await h.child.session.prompt("PARENT_AUTH_FAILED"); } catch (error) { rejected = error; }
    assert.equal(h.requests.length, before, "a parent resolver failure must block child requests");
    if (rejected) assert.match(rejected.message, /auth|resolver|key/i);
    else assert.equal(h.child.session.messages.findLast((message) => message.role === "assistant").stopReason, "error");
  });
}
test("stable auth retains independent child and parent routers/hooks after child disposal", async (t) => {
  const h = await fixture(t);
  await h.success(h.child, "FIRST");
  await h.success(h.child, "SECOND");
  h.child.session.dispose();
  await h.success(h.parent, "PARENT_AFTER_CHILD");
  assert.deepEqual(h.hooks, [{ role: "child", count: 1 }, { role: "child", count: 2 }, { role: "parent", count: 1 }]);
  assert.deepEqual(h.routes, [{ role: "child", turn: 0 }, { role: "child", turn: 1 }, { role: "parent", turn: 0 }]);
});
