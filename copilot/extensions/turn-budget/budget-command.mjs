const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;
const USAGE =
  "Usage: /budget next <positive integer AIC> | /budget history [1-50]";

export function parseBudgetCommand(args) {
  const nextMatch = /^\s*next\s+([1-9]\d*)\s*$/.exec(args);
  if (nextMatch) {
    const aiCredits = Number(nextMatch[1]);
    if (Number.isSafeInteger(aiCredits)) {
      return { action: "next", aiCredits };
    }
  }

  const historyMatch = /^\s*history(?:\s+([1-9]\d*))?\s*$/.exec(args);
  if (historyMatch) {
    const limit =
      historyMatch[1] === undefined
        ? DEFAULT_HISTORY_LIMIT
        : Number(historyMatch[1]);
    if (Number.isSafeInteger(limit) && limit <= MAX_HISTORY_LIMIT) {
      return { action: "history", limit };
    }
  }

  throw new TypeError(USAGE);
}
