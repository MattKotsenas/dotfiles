import assert from "node:assert/strict";
import test from "node:test";
import { parseBudgetCommand } from "../budget-command.mjs";

test("parses a positive integer next-unit budget", () => {
  assert.deepEqual(parseBudgetCommand("next 2000"), {
    action: "next",
    aiCredits: 2000,
  });
  assert.deepEqual(parseBudgetCommand(" next 1 "), {
    action: "next",
    aiCredits: 1,
  });
});

test("parses history with a bounded optional count", () => {
  assert.deepEqual(parseBudgetCommand("history"), {
    action: "history",
    limit: 10,
  });
  assert.deepEqual(parseBudgetCommand(" history 25 "), {
    action: "history",
    limit: 25,
  });
  assert.deepEqual(parseBudgetCommand("history 1"), {
    action: "history",
    limit: 1,
  });
  assert.deepEqual(parseBudgetCommand("history 50"), {
    action: "history",
    limit: 50,
  });
});

for (const args of [
  "",
  "next",
  "next 0",
  "next -1",
  "next 1.5",
  "next unlimited",
  "next 100 extra",
  "history 0",
  "history 51",
  "history all",
  "history 10 extra",
]) {
  test(`rejects invalid budget arguments: ${JSON.stringify(args)}`, () => {
    assert.throws(
      () => parseBudgetCommand(args),
      /Usage: \/budget next <positive integer AIC> \| \/budget history \[1-50\]/,
    );
  });
}
