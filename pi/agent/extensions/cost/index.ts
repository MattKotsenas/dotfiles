import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { project, unfinishedTurns } from "./ledger.ts";
import { COST_ENTRY, checkpointRecord, cleanText, costRecord, footerRecord, type CostSnapshot } from "./model.ts";
import { CostView } from "./view.ts";

interface Cursor {
  afterEntryId: string | null;
}
interface PreparedTurn extends Cursor {
  excerpt: string;
}

export default function (pi: ExtensionAPI) {
  let pendingInput: Cursor | undefined;
  let precompact: Cursor | undefined;
  let prepared: PreparedTurn | undefined;
  let active: { id: string } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let signature: string | undefined;
  const snapshots = new Map<string | undefined, CostSnapshot>();
  let published: string | undefined;
  let hasPublished = false;
  let popup: { invalidate(): void; redraw(): void } | undefined;

  const lastRaw = (ctx: ExtensionContext) => ctx.sessionManager.getEntries().at(-1)?.id ?? null;

  function snapshot(ctx: ExtensionContext, rangeId?: string): CostSnapshot {
    const manager = ctx.sessionManager;
    const entries = manager.getEntries();
    const next = JSON.stringify([entries.length, entries.at(-1)?.id, manager.getLeafId(), manager.getSessionId()]);
    if (signature !== next) {
      signature = next;
      snapshots.clear();
    }
    let result = snapshots.get(rangeId);
    if (!result) {
      result = project(entries, new Set(manager.getBranch().map((entry) => entry.id)), manager.getSessionId(), rangeId);
      snapshots.set(rangeId, result);
    }
    return result;
  }

  function refresh(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const previous = signature;
    const current = snapshot(ctx);
    const value =
      current.footerCost > 0 || current.baseline
        ? `$${current.footerCost.toFixed(2)}`
        : ctx.model && ctx.modelRegistry.isUsingOAuth(ctx.model)
          ? "(sub)"
          : undefined;
    if (!hasPublished || value !== published) {
      hasPublished = true;
      published = value;
      ctx.ui.setStatus("compact-cost", value);
    }
    if (previous !== signature && popup) {
      popup.invalidate();
      popup.redraw();
    }
  }

  function resetTurn() {
    pendingInput = undefined;
    precompact = undefined;
    prepared = undefined;
    active = undefined;
  }

  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    stop();
    resetTurn();
    signature = undefined;
    snapshots.clear();
    hasPublished = false;
    const owner = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getEntries();
    const afterEntryId = entries.at(-1)?.id ?? null;
    for (const turn of unfinishedTurns(entries, owner)) {
      pi.appendEntry(COST_ENTRY, {
        version: 1,
        owner,
        kind: "turn_end",
        id: turn.id,
        afterEntryId,
        status: "interrupted",
      });
    }
    refresh(ctx);
    if (ctx.mode === "tui") {
      // Idle cache warming appends native usage without an extension notification.
      timer = setInterval(() => refresh(ctx), 1000);
      timer.unref?.();
    }
  });

  pi.on("input", (_event, ctx) => {
    if (!ctx.isIdle()) return;
    pendingInput = { afterEntryId: lastRaw(ctx) };
    precompact = undefined;
    prepared = undefined;
  });

  pi.on("session_before_compact", (event, ctx) => {
    // The trigger type arrives only after preprompt compaction. Never borrow a user
    // cursor here: that input may have been handled or rejected without starting a run.
    if (!active && !ctx.isIdle() && event.reason === "threshold" && !event.willRetry) {
      precompact = { afterEntryId: lastRaw(ctx) };
    }
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    precompact = undefined;
    refresh(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!active) {
      const cursor = event.messageType === "user" ? pendingInput : precompact;
      const content = event.messageType === "user" ? event.prompt : event.message.content;
      const excerpt =
        typeof content === "string"
          ? content
          : content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join(" ");
      prepared = { afterEntryId: cursor ? cursor.afterEntryId : lastRaw(ctx), excerpt: cleanText(excerpt) };
    }
    pendingInput = undefined;
    precompact = undefined;
    refresh(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!active && prepared) {
      active = { id: randomUUID() };
      pi.appendEntry(COST_ENTRY, {
        version: 1,
        owner: ctx.sessionManager.getSessionId(),
        kind: "turn_start",
        id: active.id,
        ...prepared,
      });
    }
    prepared = undefined;
    refresh(ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    if (active) {
      pi.appendEntry(COST_ENTRY, {
        version: 1,
        owner: ctx.sessionManager.getSessionId(),
        kind: "turn_end",
        id: active.id,
        afterEntryId: lastRaw(ctx),
        status: event.aborted ? "aborted" : "settled",
      });
    }
    resetTurn();
    refresh(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    resetTurn();
    refresh(ctx);
  });
  const update = (_event: unknown, ctx: ExtensionContext) => refresh(ctx);
  pi.on("turn_end", update);
  pi.on("agent_end", update);
  pi.on("session_compact", update);
  pi.on("model_select", update);
  pi.on("thinking_level_select", update);
  pi.on("session_info_changed", update);
  pi.on("session_shutdown", (_event, ctx) => {
    stop();
    resetTurn();
    popup = undefined;
    snapshots.clear();
    signature = undefined;
    if (ctx.mode === "tui" && hasPublished) ctx.ui.setStatus("compact-cost", undefined);
    hasPublished = false;
  });

  pi.registerCommand("cost", {
    description: "Inspect session costs, mark a checkpoint, or restore the total footer",
    handler: async (args, ctx) => {
      const owner = ctx.sessionManager.getSessionId();
      const notify = (text: string, type: "info" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, type);
      };
      const mark = (afterEntryId: string | null, name: string) => {
        const record = checkpointRecord(owner, name, afterEntryId);
        pi.appendEntry(COST_ENTRY, record);
        refresh(ctx);
        return record;
      };
      const footer = (id: string | null) => {
        pi.appendEntry(COST_ENTRY, footerRecord(owner, id));
        refresh(ctx);
      };
      const input = args.trim();
      if (input === "mark" || input.startsWith("mark ")) {
        const record = mark(
          lastRaw(ctx),
          input.slice(4).trim() || `Checkpoint ${snapshot(ctx).checkpoints.length + 1}`,
        );
        notify(`Cost checkpoint: ${record.name}`);
        return;
      }
      if (input === "total") {
        footer(null);
        notify("Cost footer shows the session total.");
        return;
      }
      if (input) {
        notify("Usage: /cost, /cost mark [name], /cost total", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        notify("The cost popup needs interactive Pi. Use /cost mark [name] or /cost total.", "warning");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _keys, done) => {
          const view = new CostView(
            (rangeId) => snapshot(ctx, rangeId),
            theme,
            () => tui.requestRender(),
            done,
            {
              mark,
              undo: () => {
                const live = new Set(
                  snapshot(ctx)
                    .checkpoints.filter((checkpoint) => checkpoint.owner === owner)
                    .map((checkpoint) => checkpoint.id),
                );
                const newest = ctx.sessionManager.getEntries().findLast((entry) => {
                  const record = costRecord(entry);
                  return record?.kind === "checkpoint" && record.owner === owner && live.has(record.id);
                });
                const record = newest && costRecord(newest);
                if (record?.kind === "checkpoint") {
                  pi.appendEntry(COST_ENTRY, { version: 1, owner, kind: "remove", id: record.id });
                  refresh(ctx);
                }
              },
              footer,
            },
          );
          popup = { invalidate: () => view.invalidate(), redraw: () => tui.requestRender() };
          return {
            render: (width) => view.render(width, Math.max(1, tui.terminal.rows - 2)),
            handleInput: (data) => view.handleInput(data),
            invalidate: () => view.invalidate(),
            dispose: () => {
              popup = undefined;
            },
          };
        },
        { overlay: true, overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center" } },
      );
    },
  });
}
