import assert from "node:assert/strict";
import test from "node:test";
import { parseBudgetCommand } from "../budget-command.mjs";

test("parses a positive integer next-unit budget", () => {
  assert.deepEqual(parseBudgetCommand("next 2000"), { aiCredits: 2000 });
  assert.deepEqual(parseBudgetCommand(" next 1 "), { aiCredits: 1 });
});

for (const args of [
  "",
  "next",
  "next 0",
  "next -1",
  "next 1.5",
  "next unlimited",
  "next 100 extra",
]) {
  test(`rejects invalid budget arguments: ${JSON.stringify(args)}`, () => {
    assert.throws(
      () => parseBudgetCommand(args),
      /Usage: \/budget next <positive integer AIC>/,
    );
  });
}
