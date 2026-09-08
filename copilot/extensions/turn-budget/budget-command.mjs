const USAGE = "Usage: /budget next <positive integer AIC>";

export function parseBudgetCommand(args) {
  const match = /^\s*next\s+([1-9]\d*)\s*$/.exec(args);
  if (!match) {
    throw new TypeError(USAGE);
  }

  const aiCredits = Number(match[1]);
  if (!Number.isSafeInteger(aiCredits)) {
    throw new TypeError(USAGE);
  }

  return { aiCredits };
}
