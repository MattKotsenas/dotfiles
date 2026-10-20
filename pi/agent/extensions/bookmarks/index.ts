import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  parseSessionEntries,
  SessionManager,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Bookmark, type BookmarkKind, deleteBookmark, listBookmarks, saveBookmark } from "./store.ts";

const kinds = { "More of this": "more", "Less of this": "less", "Save for reference": "saved" } as const;

function kindLabel(kind: BookmarkKind): string {
  return Object.keys(kinds).find((label) => kinds[label as keyof typeof kinds] === kind) ?? kind;
}

function response(entry: SessionMessageEntry): string {
  if (entry.message.role !== "assistant") return "";
  return entry.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function preview(text: string): string {
  return stripTerminalSequences(text).replace(/\s+/g, " ").slice(0, 100);
}

async function view(bookmark: Bookmark, ctx: ExtensionCommandContext) {
  const text = [
    bookmark.response,
    "",
    `Note: ${bookmark.note}`,
    `Saved: ${bookmark.createdAt}`,
    `Project: ${bookmark.source.cwd}`,
    `Source: ${bookmark.source.sessionFile ?? "ephemeral session"} #${bookmark.source.entryId}`,
  ].join("\n");
  await ctx.ui.custom<void>(
    (tui, _theme, _keys, done) => {
      const scroll = new ScrollView(new Text(stripTerminalSequences(text), 1, 0));
      return {
        render(width: number) {
          const lines = scroll.render(width);
          const header = truncateToWidth(`Saved response · ${kindLabel(bookmark.kind)}`, width);
          const footer = truncateToWidth("Esc close · ↑/↓ scroll · PgUp/PgDn", width);
          const height = Math.max(1, Math.min(20, tui.terminal.rows - 6) - 4);
          scroll.updateLayout(lines.length, height, () => tui.requestRender());
          const border = "─".repeat(width);
          return [border, header, ...lines.slice(scroll.scrollTop, scroll.scrollTop + height), footer, border];
        },
        invalidate() {
          scroll.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) done();
          else if (matchesKey(data, "up")) scroll.scrollBy(-1);
          else if (matchesKey(data, "down")) scroll.scrollBy(1);
          else if (matchesKey(data, "pageUp")) scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1));
          else if (matchesKey(data, "pageDown")) scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1));
          else if (matchesKey(data, "home")) scroll.scrollToStart();
          else if (matchesKey(data, "end")) scroll.scrollToEnd();
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
  );
}

async function resumeAt(bookmark: Bookmark, ctx: ExtensionCommandContext) {
  const result = await ctx.navigateTree(bookmark.source.entryId, { summarize: false });
  if (!result.cancelled) ctx.ui.notify(`Resumed from: ${preview(bookmark.response)}`, "info");
}

async function goToSource(bookmark: Bookmark, ctx: ExtensionCommandContext) {
  const source = bookmark.source;
  if (source.sessionId === ctx.sessionManager.getSessionId() && ctx.sessionManager.getEntry(source.entryId)) {
    await resumeAt(bookmark, ctx);
    return;
  }
  if (!source.sessionFile) throw new Error("Source was an ephemeral session. Its saved response is still available.");
  // Inspect without opening a disk-backed manager, which can migrate historical files.
  const entries = parseSessionEntries(await readFile(source.sessionFile, "utf8"));
  const manager = SessionManager.inMemory(source.cwd, undefined, entries);
  const target = manager.getEntry(source.entryId);
  if (
    manager.getSessionId() !== source.sessionId ||
    target?.type !== "message" ||
    target.message.role !== "assistant"
  ) {
    throw new Error("The source session no longer contains this response. Its saved snapshot is still available.");
  }
  await ctx.switchSession(source.sessionFile, {
    withSession: async (fresh) => {
      await resumeAt(bookmark, fresh);
    },
  });
}

export function registerBookmarks(pi: ExtensionAPI, directory: string) {
  pi.registerCommand("bookmark", {
    description: "Save an assistant response: /bookmark [more|less|saved] [note]",
    handler: async (args, ctx) => {
      try {
        if (!ctx.isIdle()) {
          ctx.ui.notify("Wait for the agent to finish before capturing a response.", "warning");
          return;
        }
        const candidates = ctx.sessionManager
          .getBranch()
          .filter(
            (entry): entry is SessionMessageEntry => entry.type === "message" && response(entry).trim().length > 0,
          )
          .reverse();
        let target = candidates[0];
        if (!target) {
          ctx.ui.notify("No assistant response to bookmark.", "warning");
          return;
        }
        const sessionId = ctx.sessionManager.getSessionId();
        const sessionFile = ctx.sessionManager.getSessionFile();
        const cwd = ctx.sessionManager.getCwd();
        let kind: BookmarkKind = "saved";
        let note = args.trim();
        if (note) {
          const match = /^(more|less|saved|bookmark)(?:\s+(.*))?$/s.exec(note);
          if (match) {
            kind = match[1] === "bookmark" ? "saved" : (match[1] as BookmarkKind);
            note = match[2] ?? "";
          }
        } else {
          if (ctx.mode !== "tui") {
            ctx.ui.notify(
              "Interactive capture requires terminal mode. Use /bookmark more|less|saved [note].",
              "warning",
            );
            return;
          }
          let choice = await ctx.ui.select(`Capture: ${preview(response(target))}`, [
            ...Object.keys(kinds),
            "Choose earlier response",
          ]);
          if (choice === "Choose earlier response") {
            const options = candidates.map((entry, i) => `${i + 1}. ${preview(response(entry))}`);
            const selected = await ctx.ui.select("Choose response on this branch", options);
            if (selected === undefined) return;
            target = candidates[options.indexOf(selected)];
            choice = await ctx.ui.select("Capture as", Object.keys(kinds));
          }
          if (choice === undefined) return;
          kind = kinds[choice as keyof typeof kinds];
          const entered = await ctx.ui.input("Optional note (Enter saves; Escape cancels)");
          if (entered === undefined) return;
          note = entered;
        }
        await saveBookmark(directory, {
          kind,
          note,
          response: response(target),
          source: { sessionId, sessionFile, entryId: target.id, cwd },
        });
        ctx.ui.notify(`Saved ${kind} bookmark${note ? `: ${preview(note)}` : ""}.`, "info");
      } catch (error) {
        ctx.ui.notify(`Bookmark failed: ${String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("bookmarks", {
    description: "Browse saved responses across sessions",
    handler: async (_args, ctx) => {
      try {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/bookmarks requires interactive terminal mode.", "warning");
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("Wait for the agent to finish before browsing bookmarks.", "warning");
          return;
        }
        const { bookmarks, errors } = await listBookmarks(directory);
        if (errors.length) ctx.ui.notify(`Some bookmarks could not be read:\n${errors.join("\n")}`, "warning");
        if (!bookmarks.length) {
          ctx.ui.notify("No bookmarks saved.", "info");
          return;
        }
        const options = bookmarks.map(
          (b, i) =>
            `${i + 1}. [${kindLabel(b.kind)}] ${b.note ? `${preview(b.note).slice(0, 30)} · ` : ""}${preview(b.response)}`,
        );
        const selected = await ctx.ui.select("Bookmarks", options);
        if (selected === undefined) return;
        const bookmark = bookmarks[options.indexOf(selected)];
        const action = await ctx.ui.select(`${kindLabel(bookmark.kind)}: ${preview(bookmark.response)}`, [
          "View saved response",
          "Resume from this response",
          "Delete",
        ]);
        if (action === "View saved response") await view(bookmark, ctx);
        else if (action === "Resume from this response") await goToSource(bookmark, ctx);
        else if (
          action === "Delete" &&
          (await ctx.ui.confirm("Delete bookmark?", preview(bookmark.note || bookmark.response)))
        ) {
          await deleteBookmark(directory, bookmark.id);
          ctx.ui.notify("Bookmark deleted.", "info");
        }
      } catch (error) {
        ctx.ui.notify(`Bookmarks failed: ${String(error)}`, "error");
      }
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerBookmarks(pi, join(getAgentDir(), "bookmarks"));
}
