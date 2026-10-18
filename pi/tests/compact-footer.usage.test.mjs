import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import compactFooter from "../agent/extensions/compact-footer.ts";
import { ai, sdk } from "./delegation/sdk.mjs";

const { FooterComponent } = await import(pathToFileURL(join(process.env.PI_SDK_ROOT, "dist/modes/interactive/components/footer.js")));
const usage = (cost) => ({
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

test("compact cost matches Pi's footer across billed failures, summaries, branches and session changes", () => {
  const handlers = new Map();
  const statuses = new Map();
  compactFooter({ on: (event, handler) => handlers.set(event, handler), getThinkingLevel: () => "off" });
  const ledger = sdk.SessionManager.inMemory();
  const ctx = {
    mode: "tui", sessionManager: ledger,
    getContextUsage: () => ({ tokens: 10, percent: 1, contextWindow: 1_000 }),
    ui: { setStatus: (key, value) => statuses.set(key, value) },
  };
  const nativeFooter = new FooterComponent({ sessionManager: ledger, getContextUsage: ctx.getContextUsage }, {});
  const refresh = (event = "turn_end") => handlers.get(event)({}, ctx);
  const check = (expected) => {
    refresh();
    assert.equal(nativeFooter.getSessionStats().usageTotals.cost, expected);
    assert.equal(statuses.get("compact-cost"), expected ? `$${expected.toFixed(2)}` : undefined);
    assert.equal(statuses.get("compact-context"), "1%/1k");
  };
  refresh("session_start");
  check(0);
  const root = ledger.appendMessage({ ...ai.fauxAssistantMessage("root"), usage: usage(0.125) });
  check(0.125);
  const abandoned = ledger.appendMessage({ ...ai.fauxAssistantMessage("billed failure", { stopReason: "error" }), usage: usage(0.25) });
  ledger.appendMessage({ ...ai.fauxAssistantMessage("billed cancellation", { stopReason: "aborted" }), usage: usage(0.5) });
  ledger.appendMessage({ role: "toolResult", toolCallId: "child", toolName: "delegate", content: [], isError: true, timestamp: 0, usage: usage(1) });
  check(1.875);
  ledger.appendUsage("classifier", "faux", "model", usage(2));
  ledger.appendCompaction("summary", root, 10, undefined, false, usage(4));
  ledger.branchWithSummary(root, "branch summary", undefined, false, usage(8));
  assert(ledger.getEntries().some((entry) => entry.id === abandoned));
  assert(!ledger.getBranch().some((entry) => entry.id === abandoned));
  check(15.875);
  ledger.branch(root);
  refresh("session_tree");
  check(15.875);
  ledger.appendUsage("cache_warm", "faux", "model", usage(16));
  ledger.branch(root);
  assert.equal(ledger.getLeafId(), root, "precondition: append and return to the cached leaf between refreshes");
  refresh("session_tree");
  check(31.875);
  ledger.newSession();
  refresh("session_start");
  check(0);
});
