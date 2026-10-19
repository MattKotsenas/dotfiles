// SDK compatibility checks for the production auth adapter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ai, sdk } from "./sdk.mjs";
import { getParentCredentials, inheritParentAuth, trackModelRefreshes } from "./auth-adapter.mjs";
import { credentialStore, jsonFile, registeredRuntime, inheritingRuntime, refreshModels } from "./resources.mjs";

const id = "composition-test";
const savedKey = { type: "api_key", key: "saved-key" };
const savedOAuth = () => ({
  type: "oauth",
  access: "saved-access",
  refresh: "saved-refresh",
  expires: Date.now() + 3600000,
});

function providerConfig(role) {
  return {
    headers: { "x-owner": role, "x-json": role, [`x-${role}-only-config`]: role },
    authHeader: true,
    modelOverrides: { model: { headers: { "x-model": role } } },
  };
}

function testProvider(role, requests = [], logins = []) {
  const fake = ai.fauxProvider({ provider: id, models: [{ id: "model" }], tokensPerSecond: 0 });
  return {
    ...fake.provider,
    auth: {
      apiKey: {
        name: `${role} key`,
        async login() {
          logins.push(role);
          return { type: "api_key", key: `${role}-login` };
        },
        async resolve() {
          return {
            auth: { apiKey: `${role}-resolved`, headers: { "x-auth": role } },
            env: { ACCOUNT_HEADER: "account-value" },
          };
        },
      },
      oauth: {
        name: `${role} OAuth`,
        isSubscription: true,
        async login() {
          logins.push(role);
          return {
            type: "oauth",
            access: `${role}-login-access`,
            refresh: "login-refresh",
            expires: Date.now() + 3600000,
          };
        },
        async refresh() {
          throw new Error("not expired");
        },
        async toAuth(current) {
          return { apiKey: current.access, headers: { "x-auth": role } };
        },
      },
    },
    streamSimple(model, context, options) {
      requests.push({ role, model, options });
      fake.setResponses([ai.fauxAssistantMessage("done")]);
      return fake.provider.streamSimple(model, context, options);
    },
  };
}

for (const oauth of [false, true])
  test(`${oauth ? "OAuth" : "key"}: parent auth and child provider/model headers coexist across refresh`, async () => {
    const requests = [];
    const logins = [];
    const { runtime: parent } = await registeredRuntime(testProvider("parent", requests, logins), {
      credentials: await credentialStore(id, oauth ? savedOAuth() : savedKey),
      modelsPath: await jsonFile("models.json", { providers: { [id]: providerConfig("parent") } }),
    });
    const { runtime: child, waitForRefreshes: waitChild } = await inheritingRuntime(
      new sdk.ModelRegistry(parent),
      await jsonFile("models.json", { providers: { [id]: providerConfig("child") } }),
    );
    child.registerNativeProvider(testProvider("child", requests, logins));
    await refreshModels(child, waitChild);
    for (let round = 0; round < 2; round++) {
      await child.refresh({ allowNetwork: false });
      await waitChild();
      const result = await child.completeSimple(child.getModel(id, "model"), { messages: [] });
      assert.equal(result.stopReason, "stop", result.errorMessage);
      const { role, options } = requests.at(-1);
      assert.equal(role, "child");
      assert.equal(options.apiKey, oauth ? "saved-access" : "parent-resolved");
      assert.equal(options.headers["x-auth"], "parent");
      assert.equal(options.headers["x-owner"], "child");
      assert.equal(options.headers["x-json"], "child");
      assert.equal(options.headers["x-child-only-config"], "child");
      assert.equal(
        options.headers["x-parent-only-config"],
        undefined,
        "parent configuration must not leak into child requests",
      );
      assert.equal(options.headers["x-model"], "child");
      assert.equal(options.headers.Authorization, `Bearer ${options.apiKey}`);
      if (!oauth) assert.equal(options.env.ACCOUNT_HEADER, "account-value");
    }
  });

for (const oauth of [false, true])
  test(`${oauth ? "OAuth" : "key"}: replacement and loss of parent auth take effect without recomposing the child`, async () => {
    const requests = [];
    const logins = [];
    const { runtime: parent, waitForRefreshes: waitParent } = await registeredRuntime(
      testProvider("parent", requests, logins),
      {
        credentials: await credentialStore(id, oauth ? savedOAuth() : savedKey),
        modelsPath: await jsonFile("models.json", { providers: { [id]: providerConfig("parent") } }),
      },
    );
    const { runtime: child, waitForRefreshes: waitChild } = await inheritingRuntime(
      new sdk.ModelRegistry(parent),
      await jsonFile("models.json", { providers: { [id]: providerConfig("child") } }),
    );
    child.registerNativeProvider(testProvider("child", requests, logins));
    await refreshModels(child, waitChild);
    assert.equal((await child.completeSimple(child.getModel(id, "model"), { messages: [] })).stopReason, "stop");
    const replacement = testProvider("parent", requests, logins);
    if (oauth)
      replacement.auth.oauth.toAuth = async () => ({ apiKey: "replacement", headers: { "x-auth": "replacement" } });
    else
      replacement.auth.apiKey.resolve = async () => ({
        auth: { apiKey: "replacement", headers: { "x-auth": "replacement" } },
      });
    parent.registerNativeProvider(replacement);
    await parent.refresh({ allowNetwork: false });
    await waitParent();
    assert.equal((await child.completeSimple(child.getModel(id, "model"), { messages: [] })).stopReason, "stop");
    assert.equal(requests.at(-1).options.apiKey, "replacement");
    assert.equal(requests.at(-1).options.headers["x-owner"], "child");
    parent.unregisterProvider(id);
    await parent.refresh({ allowNetwork: false });
    await waitParent();
    // A header-only parent config can still resolve its saved API key after the
    // custom provider is removed. That is the parent's own valid auth path.
    if (!oauth) {
      assert.equal((await parent.getAuth(id)).auth.apiKey, "saved-key");
      assert.equal((await child.completeSimple(child.getModel(id, "model"), { messages: [] })).stopReason, "stop");
      assert.equal(requests.at(-1).options.apiKey, "saved-key");
      await parent.logout(id);
    }
    assert.equal(await parent.getAuth(id), undefined, "parent really is unconfigured");
    const count = requests.length;
    assert.equal((await child.completeSimple(child.getModel(id, "model"), { messages: [] })).stopReason, "error");
    assert.equal(requests.length, count, "removed parent handler must not reveal child auth");
  });

for (const mode of ["absent", "fail"])
  test(`parent ${mode} auth blocks an otherwise usable child resolver`, async () => {
    const requests = [];
    const logins = [];
    const { runtime: parent, waitForRefreshes: waitParent } = await registeredRuntime(
      testProvider("parent", requests, logins),
      {
        credentials: await credentialStore(id, savedKey),
        modelsPath: await jsonFile("models.json", { providers: { [id]: providerConfig("parent") } }),
      },
    );
    const { runtime: child, waitForRefreshes: waitChild } = await inheritingRuntime(
      new sdk.ModelRegistry(parent),
      await jsonFile("models.json", { providers: { [id]: providerConfig("child") } }),
    );
    child.registerNativeProvider(testProvider("child", requests, logins));
    await refreshModels(child, waitChild);
    assert.equal((await child.completeSimple(child.getModel(id, "model"), { messages: [] })).stopReason, "stop");
    assert.equal(requests.length, 1);
    const replacement = testProvider("parent", requests, logins);
    replacement.auth.apiKey.resolve = async () => {
      if (mode === "fail") throw new Error("parent auth rejected");
      return undefined;
    };
    parent.registerNativeProvider(replacement);
    await waitParent();
    const failed = await child.completeSimple(child.getModel(id, "model"), { messages: [] });
    assert.equal(failed.stopReason, "error");
    assert.equal(requests.length, 1, "must not use child's working auth after parent failure");
  });

for (const oauth of [false, true])
  test(`${oauth ? "OAuth" : "key"} login uses current parent method and shared storage`, async () => {
    const requests = [];
    const logins = [];
    const { runtime: parent } = await registeredRuntime(testProvider("parent", requests, logins), {
      credentials: await credentialStore(id, oauth ? savedOAuth() : savedKey),
      modelsPath: await jsonFile("models.json", { providers: { [id]: providerConfig("parent") } }),
    });
    const { runtime: child, waitForRefreshes: waitChild } = await inheritingRuntime(
      new sdk.ModelRegistry(parent),
      await jsonFile("models.json", { providers: { [id]: providerConfig("child") } }),
    );
    child.registerNativeProvider(testProvider("child", requests, logins));
    await refreshModels(child, waitChild);
    const replacement = testProvider("parent", requests, logins);
    const method = oauth ? "oauth" : "apiKey";
    replacement.auth[method].login = async () => {
      logins.push("replacement");
      return oauth
        ? { type: "oauth", access: "replacement-access", refresh: "replacement-refresh", expires: Date.now() + 3600000 }
        : { type: "api_key", key: "replacement-key" };
    };
    parent.registerNativeProvider(replacement);
    const credential = await child.login(id, oauth ? "oauth" : "api_key", {
      prompt: async () => {
        throw new Error("must not invent a generic login prompt");
      },
      notify() {},
    });
    await waitChild();
    assert.deepEqual(logins, ["replacement"]);
    assert.deepEqual(await getParentCredentials(new sdk.ModelRegistry(parent)).read(id), credential);
  });

test("an unsupported parent API-key login is not replaced with a generic prompt", async () => {
  // A configured parent would gain Pi's generic key-login prompt.
  const parentProvider = testProvider("parent");
  delete parentProvider.auth.apiKey.login;
  const requests = [];
  const logins = [];
  const { runtime: parent } = await registeredRuntime(parentProvider, {
    credentials: await credentialStore(id, savedKey),
    modelsPath: null,
  });
  const { runtime: child, waitForRefreshes: waitChild } = await inheritingRuntime(
    new sdk.ModelRegistry(parent),
    await jsonFile("models.json", { providers: { [id]: providerConfig("child") } }),
  );
  child.registerNativeProvider(testProvider("child", requests, logins));
  await refreshModels(child, waitChild);
  assert.equal(parent.getProvider(id).auth.apiKey.login, undefined, "parent has no supported key login");
  // Without composition the normal child composer supplies a generic prompt.
  await assert.rejects(
    child.login(id, "api_key", { prompt: async () => "must-not-be-saved", notify() {} }),
    /does not support api_key login/,
  );
  assert.equal((await getParentCredentials(new sdk.ModelRegistry(parent)).read(id)).key, "saved-key");
});

test("adding parent OAuth support is visible without recomposing the child", async () => {
  const parentProvider = testProvider("parent");
  delete parentProvider.auth.oauth;
  const requests = [];
  const logins = [];
  const { runtime: parent } = await registeredRuntime(parentProvider, {
    credentials: await credentialStore(id, savedKey),
    modelsPath: await jsonFile("models.json", { providers: { [id]: providerConfig("parent") } }),
  });
  const { runtime: child, waitForRefreshes: waitChild } = await inheritingRuntime(
    new sdk.ModelRegistry(parent),
    await jsonFile("models.json", { providers: { [id]: providerConfig("child") } }),
  );
  child.registerNativeProvider(testProvider("child", requests, logins));
  await refreshModels(child, waitChild);
  assert.equal(parent.getProvider(id).auth.oauth, undefined);
  assert.equal(child.getProvider(id).auth.oauth, undefined);
  const replacement = testProvider("parent", requests, logins);
  parent.registerNativeProvider(replacement);
  await parent.login(id, "oauth", { prompt: async () => "unused", notify() {} });
  assert.equal((await parent.getAuth(id)).auth.apiKey, "parent-login-access");
  assert.equal((await child.getAuth(id)).auth.apiKey, "parent-login-access");
  assert.equal((await child.completeSimple(child.getModel(id, "model"), { messages: [] })).stopReason, "stop");
  assert.equal(requests.at(-1).options.headers["x-auth"], "parent");
});

test("a short-lived refreshed OAuth token is derived once without another refresh", async () => {
  const requests = [];
  const logins = [];
  const { runtime: parent, waitForRefreshes: waitParent } = await registeredRuntime(
    testProvider("parent", requests, logins),
    {
      credentials: await credentialStore(id, savedOAuth()),
      modelsPath: await jsonFile("models.json", { providers: { [id]: providerConfig("parent") } }),
    },
  );
  const { runtime: child, waitForRefreshes: waitChild } = await inheritingRuntime(
    new sdk.ModelRegistry(parent),
    await jsonFile("models.json", { providers: { [id]: providerConfig("child") } }),
  );
  child.registerNativeProvider(testProvider("child", requests, logins));
  await refreshModels(child, waitChild);
  const credentials = getParentCredentials(new sdk.ModelRegistry(parent));
  await credentials.modify(id, (current) => ({ ...current, expires: 0 }));
  let refreshes = 0;
  const replacement = testProvider("parent", requests, logins);
  replacement.auth.oauth.refresh = async (current) => {
    refreshes++;
    return { ...current, access: `short-lived-${refreshes}`, expires: Date.now() + 60000 };
  };
  parent.registerNativeProvider(replacement);
  await parent.refresh({ allowNetwork: false });
  await waitParent();
  assert.equal(refreshes, 0, "offline catalog refresh must not exchange the token");
  const childAuth = await child.getAuth(id);
  assert.equal(childAuth.auth.apiKey, "short-lived-1");
  assert.equal(refreshes, 1, "the parent derivation must use the credential already refreshed by Pi");
  assert.equal((await credentials.read(id)).access, "short-lived-1");
});

test("parent auth resolution receives child cancellation", async () => {
  const requests = [];
  const logins = [];
  const { runtime: parent } = await registeredRuntime(testProvider("parent", requests, logins), {
    credentials: await credentialStore(id, savedKey),
    modelsPath: await jsonFile("models.json", { providers: { [id]: providerConfig("parent") } }),
  });
  const { runtime: child, waitForRefreshes: waitChild } = await inheritingRuntime(
    new sdk.ModelRegistry(parent),
    await jsonFile("models.json", { providers: { [id]: providerConfig("child") } }),
  );
  child.registerNativeProvider(testProvider("child", requests, logins));
  await refreshModels(child, waitChild);
  let resolverEntered;
  const entered = new Promise((resolve) => {
    resolverEntered = resolve;
  });
  const replacement = testProvider("parent", requests, logins);
  replacement.auth.apiKey.resolve = async ({ signal }) => {
    resolverEntered();
    await new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  parent.registerNativeProvider(replacement);
  const controller = new AbortController();
  const resolution = child.getAuth(id, { signal: controller.signal });
  await entered;
  controller.abort(new Error("cancel child auth"));
  await assert.rejects(resolution, /cancel child auth/);
  assert.equal(requests.length, 0);
});

test("different legacy provider headers survive later registration without replacing parent auth", async () => {
  const requests = [];
  const logins = [];
  const { runtime: parent, waitForRefreshes: waitParent } = await registeredRuntime(
    testProvider("parent", requests, logins),
    {
      credentials: await credentialStore(id, savedKey),
      modelsPath: await jsonFile("models.json", { providers: { [id]: providerConfig("parent") } }),
    },
  );
  const { runtime: child, waitForRefreshes: waitChild } = await inheritingRuntime(
    new sdk.ModelRegistry(parent),
    await jsonFile("models.json", { providers: { [id]: providerConfig("child") } }),
  );
  child.registerNativeProvider(testProvider("child", requests, logins));
  await refreshModels(child, waitChild);
  for (const [role, runtime] of [
    ["parent", parent],
    ["child", child],
  ]) {
    const provider = testProvider(role, requests, logins);
    const model = provider.getModels()[0];
    runtime.registerProvider(id, {
      api: model.api,
      apiKey: `${role}-configured`,
      baseUrl: model.baseUrl,
      headers: { "x-owner": `${role}-extension`, "x-extension": role, [`x-${role}-only-extension`]: role },
      models: [{ ...model, headers: { "x-legacy-model": role } }],
      streamSimple: provider.streamSimple,
    });
    await runtime.refresh({ allowNetwork: false });
    await (role === "parent" ? waitParent : waitChild)();
  }
  assert.equal((await child.completeSimple(child.getModel(id, "model"), { messages: [] })).stopReason, "stop");
  const { role, options } = requests.at(-1);
  assert.equal(role, "child");
  assert.equal(options.apiKey, (await parent.getAuth(id)).auth.apiKey);
  assert.equal(options.headers["x-owner"], "child-extension");
  assert.equal(options.headers["x-extension"], "child");
  assert.equal(options.headers["x-child-only-extension"], "child");
  assert.equal(options.headers["x-parent-only-extension"], undefined);
  assert.equal(options.headers["x-json"], "child");
  assert.equal(options.headers["x-model"], "child");
  assert.equal(options.headers["x-legacy-model"], "child");
});

test("legacy OAuth account model projection remains child-owned", async () => {
  const requests = [];
  const logins = [];
  const { runtime: parent } = await registeredRuntime(testProvider("parent", requests, logins), {
    credentials: await credentialStore(id, savedOAuth()),
    modelsPath: await jsonFile("models.json", { providers: { [id]: providerConfig("parent") } }),
  });
  const { runtime: child, waitForRefreshes: waitChild } = await inheritingRuntime(
    new sdk.ModelRegistry(parent),
    await jsonFile("models.json", { providers: { [id]: providerConfig("child") } }),
  );
  child.registerNativeProvider(testProvider("child", requests, logins));
  await refreshModels(child, waitChild);
  const provider = testProvider("child", requests, logins);
  const model = provider.getModels()[0];
  const projections = [];
  child.registerProvider(id, {
    api: model.api,
    baseUrl: model.baseUrl,
    models: [model],
    oauth: {
      name: "Child catalog OAuth",
      async login() {
        throw new Error("must not use child login");
      },
      async refreshToken() {
        throw new Error("must not use child refresh");
      },
      getApiKey() {
        throw new Error("must not use child auth");
      },
      modifyModels(models, credential) {
        projections.push(credential.access);
        return [...models, { ...models[0], id: `account-${credential.access}` }];
      },
    },
    streamSimple: provider.streamSimple,
  });
  await child.refresh({ allowNetwork: false });
  await waitChild();
  assert(projections.includes("saved-access"));
  assert(child.getModel(id, "account-saved-access"));
  assert.equal(parent.getModel(id, "account-saved-access"), undefined);
  assert.equal((await child.completeSimple(child.getModel(id, "model"), { messages: [] })).stopReason, "stop");
  assert.equal(requests.at(-1).options.headers["x-auth"], "parent");
});

test("actual GitHub Copilot availability must retain the saved account's allowed-model filter", async () => {
  const modelsPath = await jsonFile("models.json", {});
  const credentials = new ai.InMemoryCredentialStore();
  const parent = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const all = parent.getModels("github-copilot");
  assert(all.length > 1, "real builtin must offer a meaningful filter control");
  const allowed = all[0].id;
  await credentials.modify("github-copilot", () => ({
    type: "oauth",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 3600000,
    availableModelIds: [allowed],
  }));
  await parent.refresh({ allowNetwork: false, providers: ["github-copilot"] });
  assert.deepEqual(
    (await parent.getAvailable("github-copilot")).map((model) => model.id),
    [allowed],
  );
  const child = await sdk.ModelRuntime.create({
    credentials: getParentCredentials(new sdk.ModelRegistry(parent)),
    modelsPath,
    refreshOnCreate: false,
  });
  await inheritParentAuth(child, new sdk.ModelRegistry(parent));
  const wait = trackModelRefreshes(child);
  await child.refresh({ allowNetwork: false });
  await wait();
  const available = (await child.getAvailable("github-copilot")).map((model) => model.id);
  console.log(`Copilot availability: parent=1 child=${available.length}; no requests or OAuth exchange`);
  assert.deepEqual(available, [allowed], "child must retain the actual builtin's credential-based filter");
});

test("credential access prefers a public accessor on a supported registry", async () => {
  const parent = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new sdk.ModelRegistry(parent);
  const publicStore = new ai.InMemoryCredentialStore();
  Object.defineProperty(registry, "credentialStore", { get: () => publicStore });
  assert.equal(getParentCredentials(registry), publicStore);
});

test("a failed public credential accessor does not fall back to private storage", async () => {
  const parent = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new sdk.ModelRegistry(parent);
  assert(getParentCredentials(registry), "private store must be usable before the public accessor fails");
  const failure = new Error("public credentials unavailable");
  Object.defineProperty(registry, "credentialStore", {
    get() {
      throw failure;
    },
  });
  assert.throws(
    () => getParentCredentials(registry),
    (error) => error === failure,
  );
});

test("private installation rejects the parent runtime and duplicate installation before changing methods", async () => {
  const parent = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new sdk.ModelRegistry(parent);
  const prototypeMethod = parent.composeProvider;
  await assert.rejects(inheritParentAuth(parent, registry), /fresh, separate/);
  assert.equal(parent.composeProvider, prototypeMethod);
  const child = await sdk.ModelRuntime.create({
    credentials: getParentCredentials(registry),
    modelsPath: null,
    refreshOnCreate: false,
  });
  await inheritParentAuth(child, registry);
  const installed = child.composeProvider;
  await assert.rejects(inheritParentAuth(child, registry), /fresh, separate/);
  assert.equal(child.composeProvider, installed);
  assert.equal(sdk.ModelRuntime.prototype.composeProvider, prototypeMethod);
});
