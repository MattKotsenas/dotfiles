import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Selection } from "./selection.ts";
import { selectionType } from "./selection.ts";
export type Saved = {
  leaf: string | null;
  persistedEntryCount: number;
  model: NonNullable<Selection["model"]>;
  thinking: string;
};
// Record selection before constructing the replacement runtime.
export function prepareContinuation(manager: SessionManager, saved: Saved) {
  const entries = manager.getEntries();
  if (
    !Number.isInteger(saved.persistedEntryCount) ||
    saved.persistedEntryCount < 0 ||
    saved.persistedEntryCount > entries.length
  ) {
    throw new Error("Session history changed during the move; continuation was not prepared");
  }
  const added = entries.slice(saved.persistedEntryCount);
  const descendsFrom = (entry: SessionEntry | undefined, ancestor: string | null) => {
    for (
      let current = entry;
      current;
      current = current.parentId === null ? undefined : manager.getEntry(current.parentId)
    ) {
      if (current.id === ancestor) return true;
    }
    return ancestor === null;
  };
  const endpoint = added.length ? (added.at(-1) as SessionEntry).id : saved.leaf;
  const tip = endpoint === null ? undefined : manager.getEntry(endpoint);
  // Keep all lifecycle writes on one path continuing the saved branch.
  if (added.length && (!descendsFrom(tip, saved.leaf) || added.some((entry) => !descendsFrom(tip, entry.id)))) {
    throw new Error("Lifecycle writes changed branch; continuation was not prepared");
  }
  if (endpoint === null) manager.resetLeaf();
  else manager.branch(endpoint);
  // Checkpoint the selected branch and the visible runtime selection.
  const modelEntry = manager.appendModelChange(saved.model.provider, saved.model.id);
  const thinkingEntry = manager.appendThinkingLevelChange(saved.thinking);
  // Match SDK construction: abandoned or context-edited messages do not count.
  if (manager.buildSessionProjection().messages.length === 0)
    manager.appendCustomEntry(selectionType, {
      model: saved.model,
      thinkingLevel: saved.thinking,
    });
  return {
    endpoint,
    modelEntry,
    thinkingEntry,
    lifecycleIds: added.map((entry) => entry.id),
  };
}
