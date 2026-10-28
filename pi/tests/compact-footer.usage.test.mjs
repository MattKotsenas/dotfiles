import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import compactFooter from "../agent/extensions/compact-footer.ts";
import cost from "../agent/extensions/cost/index.ts";
import { COST_ENTRY, checkpointRecord, footerRecord } from "../agent/extensions/cost/model.ts";
import { ai, sdk } from "./delegation/sdk.mjs";

const sdkRoot =
  process.env.PI_SDK_ROOT ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { FooterComponent } = await import(pathToFileURL(join(sdkRoot, "dist/modes/interactive/components/footer.js")));
const usage = (total) => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

test("one cost writer matches Pi totals while compact footer retains model/context rendering", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const handlers = new Map();
  const statuses = new Map();
  const writes = [];
  const ledger = sdk.SessionManager.inMemory();
  const api = {
    on(event, handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    getThinkingLevel: () => "off",
    registerCommand: () => {},
    appendEntry: (type, data) => ledger.appendCustomEntry(type, data),
  };
  cost(api);
  compactFooter(api);
  const ctx = {
    mode: "tui",
    sessionManager: ledger,
    getContextUsage: () => ({ tokens: 10, percent: 1, contextWindow: 1_000 }),
    ui: {
      setStatus: (key, value) => {
        writes.push([key, value]);
        statuses.set(key, value);
      },
    },
  };
  const nativeFooter = new FooterComponent({ sessionManager: ledger, getContextUsage: ctx.getContextUsage }, {});
  const refresh = (event = "turn_end") => {
    for (const handler of handlers.get(event) ?? []) handler({}, ctx);
  };
  const check = (expected) => {
    refresh();
    assert.equal(nativeFooter.getSessionStats().usageTotals.cost, expected);
    assert.equal(statuses.get("compact-cost"), expected ? `$${expected.toFixed(2)}` : undefined);
    assert.equal(statuses.get("compact-context"), "1%/1k");
    assert.equal(statuses.get("compact-model"), "no-model");
  };
  refresh("session_start");
  t.after(() => refresh("session_shutdown"));
  check(0);
  const root = ledger.appendMessage({ ...ai.fauxAssistantMessage("root"), usage: usage(0.125) });
  check(0.125);
  const abandoned = ledger.appendMessage({
    ...ai.fauxAssistantMessage("billed failure", { stopReason: "error" }),
    usage: usage(0.25),
  });
  ledger.appendMessage({
    ...ai.fauxAssistantMessage("billed cancellation", { stopReason: "aborted" }),
    usage: usage(0.5),
  });
  ledger.appendMessage({
    role: "toolResult",
    toolCallId: "child",
    toolName: "delegate",
    content: [],
    isError: true,
    timestamp: 0,
    usage: usage(1),
  });
  check(1.875);
  ledger.appendUsage("classifier", "faux", "model", usage(2));
  ledger.appendCompaction("summary", root, 10, undefined, false, usage(4));
  ledger.branchWithSummary(root, "branch summary", undefined, false, usage(8));
  assert(ledger.getEntries().some((entry) => entry.id === abandoned));
  assert(!ledger.getBranch().some((entry) => entry.id === abandoned));
  check(15.875);
  const checkpoint = checkpointRecord(ledger.getSessionId(), "Baseline", ledger.getEntries().at(-1).id);
  ledger.appendCustomEntry(COST_ENTRY, checkpoint);
  ledger.appendCustomEntry(COST_ENTRY, footerRecord(ledger.getSessionId(), checkpoint.id));
  refresh();
  assert.equal(statuses.get("compact-cost"), "$0.00");
  ledger.branch(root);
  refresh("session_tree");
  assert.equal(statuses.get("compact-cost"), "$0.00");
  ledger.appendUsage("cache_warm", "faux", "model", usage(16));
  ledger.branch(root);
  assert.equal(ledger.getLeafId(), root, "append and return to the cached leaf between refreshes");
  t.mock.timers.tick(1000);
  assert.equal(statuses.get("compact-cost"), "$16.00");
  assert.equal(nativeFooter.getSessionStats().usageTotals.cost, 31.875);
  ledger.appendCustomEntry(COST_ENTRY, footerRecord(ledger.getSessionId(), null));
  check(31.875);
  const previous = writes.length;
  refresh("turn_end");
  refresh("agent_end");
  assert.equal(writes.length, previous, "unchanged refreshes do not republish statuses");
  ledger.newSession();
  refresh("session_start");
  check(0);
});

test("compact footer never publishes or clears another extension's cost status", () => {
  const handlers = new Map();
  const writes = [];
  compactFooter({ on: (event, handler) => handlers.set(event, handler), getThinkingLevel: () => "off" });
  const ctx = { mode: "tui", ui: { setStatus: (...args) => writes.push(args) }, getContextUsage: () => undefined };
  handlers.get("session_start")({}, ctx);
  handlers.get("session_shutdown")({}, ctx);
  assert(writes.length > 0);
  assert(writes.every(([key]) => key !== "compact-cost"));
});
