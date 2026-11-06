import assert from "node:assert/strict";
import { test } from "node:test";
import { usageSince } from "../agent/extensions/shared/usage.ts";
import { ai, sdk } from "./delegation/sdk.mjs";
import { usage } from "./delegation/usage-provider.mjs";

const zero = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (n, stopReason = "stop") => ({
  ...ai.fauxAssistantMessage(`charged-${n}`, { stopReason }),
  usage: usage(n),
});

test("usage ledger excludes prior reports and includes tool, explicit, compacted and abandoned-branch charges", () => {
  const ledger = sdk.SessionManager.inMemory();
  assert.equal(ledger.getEntryCount(), 0);
  assert.deepEqual(usageSince(ledger, 0), zero);
  const root = ledger.appendMessage(assistant(2));
  const reported = ledger.getEntryCount();
  assert.deepEqual(usageSince(ledger, 0), usage(2));
  const abandoned = ledger.appendMessage(assistant(3));
  ledger.appendMessage({
    role: "toolResult",
    toolName: "priced",
    toolCallId: "one",
    content: [],
    isError: false,
    timestamp: 0,
    usage: usage(5),
  });
  ledger.appendUsage("classifier", "synthetic", "priced", usage(7));
  ledger.appendCompaction("compacted", null, 100, undefined, false, usage(11));
  ledger.branchWithSummary(root, "abandoned", undefined, false, usage(13));
  ledger.appendCustomEntry("not-a-charge", { usage: usage(100) });
  ledger.appendMessage({ role: "user", content: "unbilled", timestamp: 0 });
  ledger.appendMessage({
    role: "toolResult",
    toolName: "free",
    toolCallId: "two",
    content: [],
    isError: false,
    timestamp: 0,
  });
  assert(
    ledger.getEntries().some((entry) => entry.id === abandoned),
    "charged history remains in the ledger",
  );
  assert(
    !ledger.getBranch().some((entry) => entry.id === abandoned),
    "precondition: charged history left the active branch",
  );
  assert.deepEqual(usageSince(ledger, reported), usage(39));
  const nextReport = ledger.getEntryCount();
  assert.deepEqual(usageSince(ledger, nextReport), zero);
  ledger.appendUsage("cache_warm", "synthetic", "priced", usage(17));
  assert.deepEqual(
    usageSince(ledger, nextReport),
    usage(17),
    "new entries count even without new conversation messages",
  );
});

for (const stopReason of ["error", "aborted"]) {
  test(`usage ledger retains provider-reported ${stopReason} work`, () => {
    const ledger = sdk.SessionManager.inMemory();
    assert.deepEqual(usageSince(ledger, 0), zero);
    ledger.appendMessage(assistant(19, stopReason));
    assert.deepEqual(usageSince(ledger, 0), usage(19));
  });
}

for (const [sources, expected] of [
  [[undefined], false],
  [[undefined, undefined], false],
  [[true], true],
  [[true, true], true],
  [[false], false],
  [[true, false], false],
  [[false, true], false],
  [[undefined, true], false],
  [[true, undefined], false],
]) {
  test(`cost source [${sources.map((source) => source ?? "missing").join(", ")}] aggregates to ${expected}`, () => {
    const ledger = sdk.SessionManager.inMemory();
    assert.deepEqual(usageSince(ledger, 0), zero);
    for (const source of sources) {
      const message = assistant(1);
      // Reported totals can differ from the catalog-priced components.
      message.usage.cost.total = 2;
      if (source === undefined) delete message.usage.cost.totalFromProvider;
      else message.usage.cost.totalFromProvider = source;
      assert.notEqual(message.usage.cost.total, message.usage.cost.input + message.usage.cost.output);
      ledger.appendMessage(message);
    }
    const total = usageSince(ledger, 0);
    assert.equal(total.cost.total, 2 * sources.length);
    assert.equal(total.totalTokens, usage(sources.length).totalTokens);
    assert.equal(total.cost.totalFromProvider, expected);
    assert.equal(Object.hasOwn(total.cost, "totalFromProvider"), expected !== undefined);
    assert.equal(usageSince(ledger, ledger.getEntryCount()).cost.totalFromProvider, undefined);
  });
}

test("optional reasoning and one-hour cache splits preserve missing and explicit zero without adding tokens", () => {
  const ledger = sdk.SessionManager.inMemory();
  const withoutSplits = usage(3);
  delete withoutSplits.reasoning;
  delete withoutSplits.cacheWrite1h;
  ledger.appendMessage({ ...assistant(3), usage: withoutSplits });
  assert.deepEqual(usageSince(ledger, 0), withoutSplits);
  ledger.appendMessage({ ...assistant(5), usage: { ...usage(5), reasoning: 0, cacheWrite1h: 0 } });
  assert.deepEqual(usageSince(ledger, 0), { ...usage(8), reasoning: 0, cacheWrite1h: 0 });
});
