import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type BookmarkKind = "more" | "less" | "saved";

export interface Bookmark {
  version: 1;
  id: string;
  createdAt: string;
  kind: BookmarkKind;
  note: string;
  response: string;
  source: {
    sessionId: string;
    sessionFile?: string;
    entryId: string;
    cwd: string;
  };
}

const filename = /^[0-9a-f-]{36}\.json$/;

function valid(value: unknown, name: string): value is Bookmark {
  if (!value || typeof value !== "object") return false;
  const b = value as Partial<Bookmark>;
  return (
    b.version === 1 &&
    `${b.id}.json` === name &&
    typeof b.createdAt === "string" &&
    Number.isFinite(Date.parse(b.createdAt)) &&
    (b.kind === "more" || b.kind === "less" || b.kind === "saved") &&
    typeof b.note === "string" &&
    typeof b.response === "string" &&
    b.response.trim().length > 0 &&
    !!b.source &&
    typeof b.source.sessionId === "string" &&
    typeof b.source.entryId === "string" &&
    typeof b.source.cwd === "string" &&
    (b.source.sessionFile === undefined || typeof b.source.sessionFile === "string")
  );
}

export async function saveBookmark(directory: string, data: Omit<Bookmark, "version" | "id" | "createdAt">) {
  const bookmark: Bookmark = { ...data, version: 1, id: randomUUID(), createdAt: new Date().toISOString() };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${bookmark.id}.tmp`);
  await writeFile(temporary, `${JSON.stringify(bookmark, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  // Only complete records become visible to other sessions' readers.
  try {
    await rename(temporary, join(directory, `${bookmark.id}.json`));
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
  return bookmark;
}

export async function listBookmarks(directory: string) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bookmarks: [], errors: [] };
    throw error;
  }
  const bookmarks: Bookmark[] = [];
  const errors: string[] = [];
  for (const name of names.filter((name) => filename.test(name))) {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (value && typeof value === "object" && "kind" in value && value.kind === "bookmark") value.kind = "saved";
      if (!valid(value, name)) throw new Error("Invalid bookmark record");
      bookmarks.push(value);
    } catch (error) {
      // A capture may be deleted by another session while this list is loading.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${name}: ${String(error)}`);
    }
  }
  bookmarks.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return { bookmarks, errors };
}

export async function deleteBookmark(directory: string, id: string) {
  if (!filename.test(`${id}.json`)) throw new Error("Invalid bookmark ID");
  await unlink(join(directory, `${id}.json`));
}
