import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import compactFooter from "../agent/extensions/compact-footer.ts";

function harness(mode = "tui", override = "1") {
  const handlers = new Map();
  const statuses = new Map();
  const writes = [];
  let usage = { tokens: 100_000, percent: 25, contextWindow: 400_000 };
  const ctx = {
    mode,
    model: { provider: "openai", id: "gpt-6.1-sol", reasoning: true },
    thinkingLevel: "medium",
    getContextUsage: () => usage,
    ui: { setStatus: (key, value) => {
      writes.push([key, value]);
      if (value === undefined) statuses.delete(key);
      else statuses.set(key, value);
    } },
  };
  compactFooter({ on: (event, handler) => handlers.set(event, handler), getThinkingLevel: () => "low" });
  return {
    ctx, statuses, writes,
    emit: (event, data = { message: { role: "user" } }) => {
      const previous = process.env.POWERLINE_NERD_FONTS;
      if (override === null) delete process.env.POWERLINE_NERD_FONTS;
      else process.env.POWERLINE_NERD_FONTS = override;
      try { return handlers.get(event)(data, ctx); }
      finally {
        if (previous === undefined) delete process.env.POWERLINE_NERD_FONTS;
        else process.env.POWERLINE_NERD_FONTS = previous;
      }
    },
    setUsage: (value) => { usage = value; },
    context: () => [...statuses].filter(([key]) => key.startsWith("compact-context")),
  };
}

test("provider identity, model ID and inline thinking survive provider/model changes", () => {
  const h = harness();
  h.emit("session_start");
  assert.equal(h.statuses.get("compact-model"), "\uEC81 gpt-6.1-sol · med");
  h.ctx.model = { provider: "github-copilot", id: "gpt-6-luna", reasoning: true };
  h.emit("model_select");
  assert.equal(h.statuses.get("compact-model"), "\uF4B8 gpt-6-luna · med");
  h.ctx.thinkingLevel = "max";
  h.emit("thinking_level_select");
  assert.equal(h.statuses.get("compact-model"), "\uF4B8 gpt-6-luna · max");
  for (const provider of ["custom-provider", "constructor", "toString"]) {
    h.ctx.model = { provider, id: `${provider}/my-model`, reasoning: false };
    h.emit("model_select");
    assert.equal(h.statuses.get("compact-model"), `${provider} my-model`);
  }
  h.ctx.model = undefined;
  h.emit("model_select");
  assert.equal(h.statuses.get("compact-model"), "no-model");
});

test("ASCII mode retains the provider instead of emitting an unsupported glyph", () => {
  const h = harness("tui", "0");
  h.emit("session_start");
  assert.equal(h.statuses.get("compact-model"), "openai gpt-6.1-sol · med");
});

test("this Meslo-configured footer keeps provider glyphs without an explicit override", () => {
  const h = harness("tui", null);
  h.emit("session_start");
  assert.equal(h.statuses.get("compact-model"), "\uEC81 gpt-6.1-sol · med");
});

test("off and non-reasoning models hide thinking; the API supplies missing thinking state", () => {
  const h = harness();
  h.ctx.thinkingLevel = "off";
  h.emit("session_start");
  assert.equal(h.statuses.get("compact-model"), "\uEC81 gpt-6.1-sol");
  h.ctx.thinkingLevel = undefined;
  h.emit("thinking_level_select");
  assert.equal(h.statuses.get("compact-model"), "\uEC81 gpt-6.1-sol · low");
});

test("exactly one combined context segment follows the existing warning boundaries", () => {
  const h = harness();
  for (const [percent, key] of [[0, "compact-context"], [70, "compact-context"], [70.1, "compact-context-warn"], [90, "compact-context-warn"], [90.1, "compact-context-error"], [105, "compact-context-error"], [25, "compact-context"]]) {
    h.setUsage({ tokens: percent * 4_000, percent, contextWindow: 400_000 });
    h.emit("message_end");
    assert.deepEqual(h.context(), [[key, `${Math.round(percent)}%/400k`]]);
  }
});

test("capacities and unknown post-compaction usage remain honest", () => {
  const h = harness();
  for (const [contextWindow, capacity] of [[999, "999"], [1_000, "1k"], [32_768, "32.8k"], [1_000_000, "1M"], [1_500_000, "1.5M"]]) {
    h.setUsage({ tokens: 0, percent: 0, contextWindow });
    h.emit("message_end");
    assert.deepEqual(h.context(), [["compact-context", `0%/${capacity}`]]);
  }
  h.setUsage({ tokens: null, percent: null, contextWindow: 1_000_000 });
  h.emit("session_compact");
  assert.deepEqual(h.context(), [["compact-context", "?%/1M"]]);
  h.setUsage(undefined);
  h.emit("model_select");
  assert.deepEqual(h.context(), []);
});

test("streaming context counts input, output, cache reads and cache writes", () => {
  const h = harness();
  h.emit("session_start");
  assert.deepEqual(h.context(), [["compact-context", "25%/400k"]]);
  h.emit("message_update", { message: { role: "assistant", stopReason: "stop", usage: { input: 20_000, output: 4_000, cacheRead: 280_000, cacheWrite: 16_000 } } });
  assert.deepEqual(h.context(), [["compact-context-warn", "80%/400k"]]);
  h.emit("agent_end");
  assert.deepEqual(h.context(), [["compact-context", "25%/400k"]]);
  for (const stopReason of ["error", "aborted"]) {
    h.emit("message_update", { message: { role: "assistant", stopReason, usage: { input: 400_000, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    assert.deepEqual(h.context(), [["compact-context", "25%/400k"]]);
  }
});

test("finalized assistant usage survives pre-persistence message_end until turn_end reconciliation", () => {
  const h = harness();
  h.emit("session_start");
  const message = { role: "assistant", stopReason: "toolUse", usage: { input: 20_000, output: 4_000, cacheRead: 280_000, cacheWrite: 16_000 } };
  h.emit("message_update", { message });
  assert.deepEqual(h.context(), [["compact-context-warn", "80%/400k"]]);
  h.emit("message_end", { message });
  assert.deepEqual(h.context(), [["compact-context-warn", "80%/400k"]], "SDK has not persisted finalized usage yet");
  h.setUsage({ tokens: 324_000, percent: 81, contextWindow: 400_000 });
  h.emit("turn_end");
  assert.deepEqual(h.context(), [["compact-context-warn", "81%/400k"]], "reconcile persisted assistant and tool context");
});

test("completion-only providers publish final usage without a streaming usage update", () => {
  const h = harness();
  h.emit("session_start");
  h.emit("message_end", { message: { role: "assistant", stopReason: "stop", usage: { input: 380_000, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  assert.deepEqual(h.context(), [["compact-context-error", "95%/400k"]]);
});

test("session_start clears stale warning keys even if the UI retains statuses", () => {
  const h = harness();
  h.setUsage({ tokens: 380_000, percent: 95, contextWindow: 400_000 });
  h.emit("session_start");
  assert.deepEqual(h.context(), [["compact-context-error", "95%/400k"]]);
  h.setUsage({ tokens: 100_000, percent: 25, contextWindow: 400_000 });
  h.emit("session_start");
  assert.deepEqual(h.context(), [["compact-context", "25%/400k"]]);
});

test("session navigation republishes statuses and shutdown removes them", () => {
  const h = harness();
  h.emit("session_start");
  const count = h.writes.length;
  h.emit("message_end");
  assert.equal(h.writes.length, count, "unchanged content should not request more renders");
  h.statuses.clear();
  h.emit("session_start");
  assert.equal(h.statuses.size, 2);
  h.setUsage({ tokens: 360_000, percent: 90, contextWindow: 400_000 });
  h.emit("session_tree");
  assert.deepEqual(h.context(), [["compact-context-warn", "90%/400k"]]);
  h.emit("session_shutdown");
  assert.equal(h.statuses.size, 0);
});

for (const mode of ["print", "json", "rpc"]) {
  test(`${mode} mode has no terminal-only effects`, () => {
    const h = harness(mode);
    h.emit("session_start");
    h.emit("message_end");
    h.emit("session_shutdown");
    assert.equal(h.writes.length, 0);
  });
}

test("configuration replaces native segments, removes cache ratio and preserves git/path/other statuses", () => {
  const { powerline } = JSON.parse(readFileSync(new URL("../agent/settings.json", import.meta.url)));
  for (const native of ["model", "thinking", "context_pct", "context_total", "cache_read", "cache_write"]) {
    assert.ok(powerline.disabledSegments.includes(native));
    assert.ok(!powerline.layout.left.includes(native));
  }
  assert.equal(powerline.layout.left[0], "custom:compact-model");
  assert.ok(powerline.layout.left.includes("git"));
  assert.deepEqual(powerline.path, { mode: "abbreviated", maxLength: 30 });
  assert.equal(powerline.layout.secondary, undefined, "retain upstream aggregate extension statuses");
  assert.equal(powerline.model, undefined);
  assert.equal(powerline.context, undefined);
  assert.equal(powerline.cache_read, undefined);
  for (const [id, color] of [["compact-context", "dim"], ["compact-context-warn", "warning"], ["compact-context-error", "error"]]) {
    assert.equal(powerline.customItems.find((item) => item.id === id).color, color);
    assert.ok(powerline.layout.left.includes(`custom:${id}`));
  }
});
