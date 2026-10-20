import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerBookmarks } from "../agent/extensions/bookmarks/index.ts";
import { listBookmarks } from "../agent/extensions/bookmarks/store.ts";

const answer = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "test",
  model: "fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

async function fixture(t, { mode = "tui", ephemeral = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-bookmarks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "bookmarks");
  const cwd = join(root, "project");
  await mkdir(cwd);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const ui = { choices: [], notes: [], confirmations: [], notifications: [], views: [], selections: [] };
  const errors = [];
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: root,
      modelRuntime,
      settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) => {
            registerBookmarks(pi, directory);
            pi.on("session_before_switch", () => (ui.cancelSwitch ? { cancel: true } : undefined));
          },
        ],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: [] })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: root,
    sessionManager: ephemeral ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, join(root, "sessions")),
  });
  const bind = async () => {
    await runtime.session.bindExtensions({
      mode,
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        switchSession: (path, options) => runtime.switchSession(path, options),
        navigateTree: (id, options) => runtime.session.navigateTree(id, options),
      },
      uiContext: {
        select: async (title, options) => {
          ui.selections.push({ title, options });
          const choice = ui.choices.shift();
          if (choice !== undefined && typeof choice !== "number")
            assert(options.includes(choice), `Unknown UI option: ${choice}`);
          return typeof choice === "number" ? options[choice] : choice;
        },
        input: async () => ui.notes.shift(),
        confirm: async () => ui.confirmations.shift() ?? false,
        notify: (message, type) => ui.notifications.push({ message, type }),
        custom: async (factory, options) =>
          new Promise((resolve) => {
            assert.equal(options.overlay, true, "saved response opens in a distinct overlay");
            const component = factory({ requestRender() {}, terminal: { rows: ui.rows ?? 30 } }, {}, {}, resolve);
            ui.views.push(component.render(ui.width ?? 70).join("\n"));
            for (const input of ui.viewInputs ?? []) {
              component.handleInput(input);
              ui.views.push(component.render(ui.width ?? 70).join("\n"));
            }
            component.handleInput("\u001b");
          }),
      },
      onError: (error) => errors.push(error),
    });
  };
  runtime.setRebindSession(bind);
  await bind();
  t.after(async () => {
    await runtime.dispose();
    assert.deepEqual(errors, []);
  });
  const exchange = (prompt, text) => {
    const manager = runtime.session.sessionManager;
    manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
    return manager.appendMessage(answer(text));
  };
  const run = (command) => runtime.session.prompt(command);
  return {
    root,
    cwd,
    directory,
    runtime,
    ui,
    exchange,
    run,
    records: async () => (await listBookmarks(directory)).bookmarks,
    storedKind: async (id) => JSON.parse(await readFile(join(directory, `${id}.json`), "utf8")).kind,
  };
}

for (const kind of ["more", "less", "saved"]) {
  test(`${kind}: capture survives session replacement and browsing preserves the conversation`, async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.records(), []);
    const target = f.exchange(
      "Explain the timing change.",
      "The conflict is detected before the bindings are published.",
    );
    const manager = f.runtime.session.sessionManager;
    const original = manager.getEntries();
    const source = manager.getSessionFile();
    await f.run(`/bookmark ${kind} useful timing explanation`);
    const [record] = await f.records();
    assert.equal(record.kind, kind);
    assert.equal(await f.storedKind(record.id), kind);
    assert.equal(record.note, "useful timing explanation");
    assert.equal(record.response, "The conflict is detected before the bindings are published.");
    assert.equal(record.source.entryId, target);
    assert.equal(record.source.sessionFile, source);
    assert.equal(record.source.cwd, f.cwd);
    assert.deepEqual(manager.getEntries(), original, "capture adds no model context, labels, or session entries");
    await f.runtime.switchSession(source);
    f.ui.choices.push(0, "View saved response");
    await f.run("/bookmarks");
    assert.match(f.ui.views.at(-1), /bindings are published/);
    assert.equal((await f.records()).length, 1);
    assert.deepEqual(f.runtime.session.sessionManager.getEntries(), original);
  });
}

test("capture uses the current branch, skipping tool-only and thinking-only messages", async (t) => {
  const f = await fixture(t);
  const a = f.exchange("Question A", "Visible answer A");
  const b = f.exchange("Question B", "Abandoned answer B");
  const manager = f.runtime.session.sessionManager;
  assert.equal(manager.getLeafId(), b);
  manager.branch(a);
  manager.appendMessage({ ...answer(""), content: [{ type: "thinking", thinking: "private thought" }] });
  await f.run("/bookmark less wrong abstraction");
  const [record] = await f.records();
  assert.equal(record.source.entryId, a);
  assert.equal(record.response, "Visible answer A");
  manager.branch(b);
  assert.equal((await f.records()).length, 1, "navigation cannot hide a capture");
});

test("interactive capture can choose an earlier response and save an empty note", async (t) => {
  const f = await fixture(t);
  const earlier = f.exchange("Earlier question", "Earlier response");
  f.exchange("Later question", "Later response");
  f.ui.choices.push("Choose earlier response", 1, "More of this");
  f.ui.notes.push("");
  await f.run("/bookmark");
  const [record] = await f.records();
  assert.equal(record.source.entryId, earlier);
  assert.equal(record.kind, "more");
  assert.equal(record.note, "");
  f.ui.choices.push(0, "View saved response");
  await f.run("/bookmarks");
  assert.match(f.ui.views.at(-1), /Earlier response/);
  assert(!f.ui.views.at(-1).includes("Later response"));
});

for (const stage of ["kind", "earlier", "note"]) {
  test(`Escape at ${stage} cancels without saving`, async (t) => {
    const f = await fixture(t);
    f.exchange("Question", "Answer");
    if (stage === "earlier") f.ui.choices.push("Choose earlier response", undefined);
    if (stage === "note") {
      f.ui.choices.push("Less of this");
      f.ui.notes.push(undefined);
    }
    await f.run("/bookmark");
    assert.deepEqual(await f.records(), []);
  });
}

test("Save for reference captures a neutral bookmark", async (t) => {
  const f = await fixture(t);
  f.exchange("Question", "Useful reference");
  f.ui.choices.push("Save for reference");
  f.ui.notes.push("");
  await f.run("/bookmark");
  const [record] = await f.records();
  assert.equal(record.kind, "saved");
  assert.equal(await f.storedKind(record.id), "saved");
  assert.equal(record.response, "Useful reference");
});

test("ordinary text becomes a neutral bookmark note", async (t) => {
  const f = await fixture(t);
  f.exchange("Question", "Answer");
  await f.run("/bookmark return to this explanation");
  const [record] = await f.records();
  assert.equal(record.kind, "saved");
  assert.equal(await f.storedKind(record.id), "saved");
  assert.equal(record.note, "return to this explanation");
});

test("existing bookmark records and the old command spelling remain usable", async (t) => {
  const f = await fixture(t);
  f.exchange("Question", "Existing saved response");
  await f.run("/bookmark bookmark original note");
  const [record] = await f.records();
  assert.equal(record.kind, "saved");
  assert.equal(await f.storedKind(record.id), "saved");
  assert.equal(record.note, "original note");
  const file = join(f.directory, `${record.id}.json`);
  const legacy = JSON.stringify({ ...record, kind: "bookmark" });
  await writeFile(file, legacy);
  assert.equal(JSON.parse(await readFile(file, "utf8")).kind, "bookmark");
  assert.equal((await f.records())[0].kind, "saved");
  assert.equal(await readFile(file, "utf8"), legacy, "reading leaves existing files unchanged");
});

test("returning to a capture selects its original branch without a model call", async (t) => {
  const f = await fixture(t);
  const target = f.exchange("Question A", "Answer A");
  await f.run("/bookmark more");
  const later = f.exchange("Question B", "Answer B");
  assert.notEqual(target, later);
  f.ui.choices.push(0, "Resume from this response");
  await f.run("/bookmarks");
  assert.equal(f.runtime.session.sessionManager.getLeafId(), target);
  assert(!f.runtime.session.sessionManager.getBranch().some((entry) => entry.id === later));
});

test("cross-session navigation uses the replacement context and source working directory", async (t) => {
  const f = await fixture(t);
  const target = f.exchange("Source question", "Source response");
  const source = f.runtime.session.sessionFile;
  await f.run("/bookmark less");
  const otherCwd = join(f.root, "other-project");
  await mkdir(otherCwd);
  const other = SessionManager.create(otherCwd, join(f.root, "other-sessions"));
  other.appendMessage({ role: "user", content: "Unrelated task", timestamp: Date.now() });
  other.appendMessage(answer("Unrelated answer"));
  await f.runtime.switchSession(other.getSessionFile());
  assert.equal(f.runtime.cwd, otherCwd);
  f.ui.choices.push(0, "Resume from this response");
  await f.run("/bookmarks");
  assert.equal(f.runtime.session.sessionFile, source);
  assert.equal(f.runtime.cwd, f.cwd);
  assert.equal(f.runtime.session.sessionManager.getLeafId(), target);
});

test("source-switch cancellation leaves the current conversation intact", async (t) => {
  const f = await fixture(t);
  f.exchange("Original", "Saved answer");
  await f.run("/bookmark more");
  const source = f.runtime.session.sessionFile;
  const other = SessionManager.create(f.cwd, join(f.root, "other-sessions"));
  other.appendMessage({ role: "user", content: "Other", timestamp: Date.now() });
  other.appendMessage(answer("Other answer"));
  await f.runtime.switchSession(other.getSessionFile());
  assert.notEqual(f.runtime.session.sessionFile, source);
  f.ui.cancelSwitch = true;
  f.ui.choices.push(0, "Resume from this response");
  await f.run("/bookmarks");
  assert.equal(f.runtime.session.sessionFile, other.getSessionFile());
  assert.equal((await f.records()).length, 1);
});

test("missing source retains the snapshot and reports the unavailable context", async (t) => {
  const f = await fixture(t);
  f.exchange("Question", "Preserved snapshot");
  await f.run("/bookmark less");
  await rm(f.runtime.session.sessionFile);
  // Navigate from a different session so an in-memory source cannot satisfy the lookup.
  const other = SessionManager.create(f.cwd, join(f.root, "other-sessions"));
  other.appendMessage({ role: "user", content: "Other", timestamp: Date.now() });
  await f.runtime.switchSession(other.getSessionFile());
  f.ui.choices.push(0, "Resume from this response");
  await f.run("/bookmarks");
  assert.equal((await f.records())[0].response, "Preserved snapshot");
  assert.equal(f.ui.notifications.at(-1).type, "error");
});

test("delete requires confirmation and affects only the selected capture", async (t) => {
  const f = await fixture(t);
  f.exchange("Question", "Answer");
  await f.run("/bookmark less first");
  await f.run("/bookmark more second");
  const before = await f.records();
  assert.equal(before.length, 2);
  f.ui.choices.push(0, "Delete");
  f.ui.confirmations.push(false);
  await f.run("/bookmarks");
  assert.equal((await f.records()).length, 2);
  f.ui.choices.push(0, "Delete");
  f.ui.confirmations.push(true);
  await f.run("/bookmarks");
  assert.deepEqual(
    (await f.records()).map((b) => b.id),
    [before[1].id],
  );
});

test("an ephemeral session still saves a durable snapshot", async (t) => {
  const f = await fixture(t, { ephemeral: true });
  assert.equal(f.runtime.session.sessionFile, undefined);
  f.exchange("Question", "Ephemeral answer");
  await f.run("/bookmark more");
  const [record] = await f.records();
  assert.equal(record.source.sessionFile, undefined);
  assert.equal(record.response, "Ephemeral answer");
});

test("simultaneous independent sessions save separate complete records", async (t) => {
  const f = await fixture(t);
  const g = await fixture(t);
  // Use the same external collection from independently created extension runtimes.
  await rm(g.directory, { recursive: true, force: true });
  const { symlink } = await import("node:fs/promises");
  await mkdir(f.directory);
  await symlink(f.directory, g.directory, "junction");
  f.exchange("First question", "First answer");
  g.exchange("Second question", "Second answer");
  await Promise.all([f.run("/bookmark more"), g.run("/bookmark less")]);
  const records = await f.records();
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((b) => b.id)).size, 2);
  assert.deepEqual(records.map((b) => b.response).sort(), ["First answer", "Second answer"]);
  assert((await readdir(f.directory)).every((name) => name.endsWith(".json")));
});

for (const mode of ["print", "json", "rpc"]) {
  test(`${mode} supports explicit capture without opening dialogs`, async (t) => {
    const f = await fixture(t, { mode });
    f.exchange("Question", "Answer");
    await f.run("/bookmark more");
    assert.equal((await f.records()).length, 1);
    await f.run("/bookmark");
    assert.match(f.ui.notifications.at(-1).message, /interactive/i);
    assert.equal((await f.records()).length, 1);
  });
}

test("no assistant response and empty collection are reported without creating data", async (t) => {
  const f = await fixture(t);
  await f.run("/bookmark less");
  assert.match(f.ui.notifications.at(-1).message, /No assistant/i);
  await f.run("/bookmarks");
  assert.match(f.ui.notifications.at(-1).message, /No bookmarks/i);
  assert.deepEqual(await f.records(), []);
});

test("bad records are reported while readable captures remain available", async (t) => {
  const f = await fixture(t);
  f.exchange("Question", "Answer");
  await f.run("/bookmark less");
  const [record] = await f.records();
  const bad = "00000000-0000-4000-8000-000000000000.json";
  await writeFile(join(f.directory, bad), '{"version":1,"id":"../../outside"}');
  await writeFile(join(f.directory, "partial.tmp"), "{");
  f.ui.choices.push(undefined);
  await f.run("/bookmarks");
  assert(f.ui.notifications.some((n) => n.type === "warning" && n.message.includes(bad)));
  const result = await listBookmarks(f.directory);
  assert.deepEqual(
    result.bookmarks.map((b) => b.id),
    [record.id],
  );
  assert.equal(result.errors.length, 1);
  assert.equal(JSON.parse(await readFile(join(f.directory, `${record.id}.json`), "utf8")).response, "Answer");
});

test("storage failures produce an error instead of a saved confirmation", async (t) => {
  const f = await fixture(t);
  await writeFile(f.directory, "not a directory");
  f.exchange("Question", "Answer");
  await f.run("/bookmark less");
  assert.equal(f.ui.notifications.at(-1).type, "error");
  assert(!f.ui.notifications.some((n) => /Saved/.test(n.message)));
});

for (const width of [20, 70]) {
  test(`snapshot view scrolls at width ${width} and strips terminal controls`, async (t) => {
    const f = await fixture(t);
    f.ui.width = width;
    f.ui.rows = 18;
    const text = Array.from({ length: 100 }, (_, i) => `Line ${i}: 日本語 🐦`).join("\n");
    f.exchange("Question", `\u001b]52;c;injected\u0007${text}`);
    await f.run("/bookmark less");
    f.ui.choices.push(0, "View saved response");
    f.ui.viewInputs = ["\u001b[F", "\u001b[H", "\u001b[6~", "\u001b[5~", "\u001b[B", "\u001b[A"];
    await f.run("/bookmarks");
    assert.match(f.ui.views[0], /Saved response/);
    assert.match(f.ui.views[0], /Line 0/);
    assert.notEqual(f.ui.views[1], f.ui.views[0]);
    assert.equal(f.ui.views[2], f.ui.views[0]);
    assert.notEqual(f.ui.views[3], f.ui.views[2]);
    assert.equal(f.ui.views[4], f.ui.views[2]);
    assert.notEqual(f.ui.views[5], f.ui.views[4]);
    assert.equal(f.ui.views[6], f.ui.views[4]);
    for (const view of f.ui.views) {
      assert(!view.includes("\u001b]52"));
      const lines = view.split("\n");
      assert(lines.length <= 12);
      assert(lines.every((line) => visibleWidth(line) <= width));
    }
    assert.equal(
      (await f.records())[0].response,
      `\u001b]52;c;injected\u0007${text}`,
      "the original snapshot is preserved",
    );
    assert(
      !stripTerminalSequences(f.ui.views[0]).includes("injected"),
      "terminal payloads are absent from the displayed text",
    );
  });
}

test("a long note cannot hide the response in a small overlay", async (t) => {
  const f = await fixture(t);
  f.ui.width = 27;
  f.ui.rows = 10;
  f.exchange("Question", "VISIBLE_SAVED_RESPONSE");
  await f.run(`/bookmark less ${"long note ".repeat(20)}`);
  f.ui.choices.push(0, "View saved response");
  await f.run("/bookmarks");
  const visible = f.ui.views[0]
    .split("\n")
    .slice(0, Math.floor(f.ui.rows * 0.85))
    .join("\n");
  assert.match(visible, /VISIBLE_SAVED_RESPONSE/);
  assert.match(visible, /Esc close/);
});

const execFile = promisify(execFileCallback);

test("separate processes publish complete captures into one collection", async (t) => {
  const f = await fixture(t);
  const module = new URL("../agent/extensions/bookmarks/store.ts", import.meta.url).href;
  const code = `import {saveBookmark} from ${JSON.stringify(module)};
    await saveBookmark(process.argv[1], {kind:'more',note:process.argv[2],response:'Response '+process.argv[2],
      source:{sessionId:process.argv[2],entryId:'entry',cwd:process.cwd()}});`;
  await Promise.all(
    ["one", "two"].map((id) => execFile(process.execPath, ["--input-type=module", "-e", code, f.directory, id])),
  );
  const records = await f.records();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((b) => b.response).sort(), ["Response one", "Response two"]);
});

test("fresh CLI discovery captures positive and negative examples without a model request", async (t) => {
  const f = await fixture(t);
  const target = f.exchange("Explain the consequence.", "A durable example for later review.");
  const extensionDir = join(f.root, "extensions", "bookmarks");
  await mkdir(extensionDir, { recursive: true });
  const entry = new URL("../agent/extensions/bookmarks/index.ts", import.meta.url).href;
  await writeFile(join(extensionDir, "index.ts"), `export { default } from ${JSON.stringify(entry)};\n`);
  const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  for (const kind of ["more", "less"]) {
    const run = execFile(
      process.execPath,
      [
        cli,
        "--print",
        "--offline",
        "--no-mcp",
        "--no-skills",
        "--no-themes",
        "--no-prompt-templates",
        "--no-context-files",
        "--session",
        f.runtime.session.sessionFile,
        `/bookmark ${kind} captured in a fresh process`,
      ],
      { cwd: f.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.root }, timeout: 30000 },
    );
    run.child.stdin.end();
    const { stdout, stderr } = await run;
    assert.equal(stderr, "");
    assert.equal(stdout.trim(), "A durable example for later review.");
    assert.equal((await f.records()).length, kind === "more" ? 1 : 2);
  }
  const records = await f.records();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((b) => b.kind).sort(), ["less", "more"]);
  assert(records.every((b) => b.source.entryId === target));
  f.ui.choices.push(0, "View saved response");
  await f.run("/bookmarks");
  assert.match(f.ui.views.at(-1), /durable example/);
});
