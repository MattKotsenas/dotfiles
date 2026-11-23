import assert from "node:assert/strict";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { join, resolve } from "node:path";
import tls from "node:tls";

export const root = process.env.WORKSPACE_TEST_ROOT;
assert(root);
assert.equal(resolve(process.cwd()), root);
assert.equal(process.env.PI_CODING_AGENT_DIR, join(root, "agent"));
for (const [key, child] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  APPDATA: "appdata",
  LOCALAPPDATA: "localappdata",
  TEMP: "tmp",
  TMP: "tmp",
})) {
  assert.equal(process.env[key], join(root, child), `isolated ${key}`);
}
for (const key of Object.keys(process.env)) {
  assert(!/^(PI_SESSION|TMUX|PSMUX|.*TOKEN|.*SECRET|.*API_KEY)/i.test(key));
}

let fetchAttempts = 0,
  networkAttempts = 0,
  modelRequests = 0;
globalThis.fetch = () => {
  fetchAttempts++;
  throw new Error("Fetch forbidden");
};
const denyNetwork = () => {
  networkAttempts++;
  throw new Error("Network forbidden");
};
http.request = http.get = https.request = https.get = net.connect = net.createConnection = tls.connect = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
dns.lookup = dns.resolve = dns.promises.lookup = dns.promises.resolve = denyNetwork;
dgram.createSocket = http2.connect = denyNetwork;
syncBuiltinESMExports();

export const sdk = await import("@earendil-works/pi-coding-agent");
assert.equal(sdk.VERSION, "1.5.2");
export const { SessionManager: SM } = sdk;
const { createProvider } = await import("@earendil-works/pi-ai/models");
export const agentDir = join(root, "agent");
const credentials = {
  read: async () => undefined,
  list: async () => [],
  modify: async () => {
    throw new Error("Credential writes forbidden");
  },
  delete: async () => {
    throw new Error("Credential deletes forbidden");
  },
};
export const modelRuntime = await sdk.ModelRuntime.create({
  credentials,
  modelsPath: null,
  modelsStorePath: join(agentDir, "models.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
const models = ["left", "right"].map((id) => ({
  id,
  name: id,
  provider: "study",
  api: "offline-study",
  baseUrl: "http://invalid.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 1000,
}));
const denyModel = () => {
  modelRequests++;
  throw new Error("Model calls forbidden");
};
modelRuntime.registerNativeProvider(
  createProvider({
    id: "study",
    models,
    auth: {
      apiKey: {
        name: "Offline fixture, no key",
        check: async () => ({
          type: "api_key",
          source: "synthetic availability only",
        }),
        resolve: async () => {
          throw new Error("No request auth in study");
        },
      },
    },
    api: { stream: denyModel, streamSimple: denyModel },
  }),
);
await modelRuntime.refresh({ allowNetwork: false });
assert(modelRuntime.hasConfiguredAuth("study"));

export function counters() {
  return { fetchAttempts, networkAttempts, modelRequests };
}
