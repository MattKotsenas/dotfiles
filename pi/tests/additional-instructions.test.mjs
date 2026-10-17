import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const executable = execFileSync("volta", ["which", "pi"], { encoding: "utf8" }).trim();
const hostRoot = join(dirname(executable), "node_modules/@earendil-works/pi-coding-agent");
const host = createRequire(pathToFileURL(join(hostRoot, "package.json")));
const { createJiti } = host("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false,
  alias: { "@earendil-works/pi-coding-agent": join(hostRoot, "dist/index.js") } });
const { additionalInstructions, instructionPath } = await jiti.import("../agent/extensions/additional-instructions.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-instructions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configure = paths => writeFileSync(join(root, "settings.json"), JSON.stringify({ additionalInstructions: { paths } }));
  const warnings = [];
  let handler;
  additionalInstructions({ on: (name, callback) => { assert.equal(name, "before_agent_start"); handler = callback; } }, root);
  return { root, configure, warnings, inject(files = []) {
    handler({ systemPromptOptions: { contextFiles: files } }, { hasUI: true, ui: { notify: text => warnings.push(text) } });
    return files;
  } };
}

test("home paths expand independently of cwd; relative paths use the agent directory", () => {
  for (const path of ["~/rules.md", "~\\rules.md"]) assert.equal(instructionPath(path, tmpdir()), join(homedir(), "rules.md"));
  assert.equal(instructionPath("~", tmpdir()), homedir());
  assert.equal(instructionPath("rules.md", tmpdir()), resolve(tmpdir(), "rules.md"));
  assert.equal(instructionPath(join(tmpdir(), "rules.md"), homedir()), join(tmpdir(), "rules.md"));
  assert.throws(() => instructionPath("~someone/rules.md", tmpdir()), /Unsupported home path/);
});

test("file patterns load sorted matches in configured order, once", t => {
  const h = fixture(t);
  const rules = join(h.root, "rules");
  mkdirSync(rules);
  mkdirSync(join(rules, "nested"));
  const content = "---\napplyTo: '**'\n---\n# Keep café and 界 verbatim\n";
  writeFileSync(join(rules, "b.md"), "B");
  writeFileSync(join(rules, "a.md"), content);
  writeFileSync(join(rules, "ignored.txt"), "ignored");
  writeFileSync(join(rules, "nested", "hidden.md"), "hidden");
  const existing = { path: join(rules, "b.md"), content: "native instructions" };
  writeFileSync(join(h.root, "first.md"), "first");
  h.configure(["first.md", "rules/*.md", "rules/a.md", "rules/*.md"]);
  assert.deepEqual(h.inject([existing]), [existing, { path: join(h.root, "first.md"), content: "first" }, { path: join(rules, "a.md"), content }]);
  assert.deepEqual(h.warnings, []);
});

test("configured tilde path reads a real file, and edits are picked up on the next run", t => {
  const h = fixture(t);
  const file = join(h.root, "portable.md");
  writeFileSync(file, "first");
  h.configure([`~/${relative(homedir(), h.root).replaceAll("\\", "/")}/*.md`]);
  assert.equal(h.inject()[0].content, "first");
  writeFileSync(file, "second");
  assert.equal(h.inject()[0].content, "second");
  h.configure([]);
  assert.deepEqual(h.inject(), []);
});

test("symlink aliases do not duplicate existing native context", t => {
  const h = fixture(t);
  const file = join(h.root, "rules.md");
  writeFileSync(file, "rules");
  symlinkSync(file, join(h.root, "alias.md"));
  h.configure(["alias.md"]);
  const existing = { path: file, content: "native" };
  assert.deepEqual(h.inject([existing]), [existing]);
});

test("missing paths warn without dropping healthy paths or existing context", t => {
  const h = fixture(t);
  writeFileSync(join(h.root, "ok.md"), "OK");
  h.configure(["missing", "ok.md"]);
  const existing = { path: join(h.root, "native.md"), content: "native" };
  assert.deepEqual(h.inject([existing]).map(f => f.content), ["native", "OK"]);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /additional-instructions:.*missing/);
});

test("a broken directory entry warns without skipping later readable files", t => {
  const h = fixture(t);
  mkdirSync(join(h.root, "rules"));
  symlinkSync(join(h.root, "missing.md"), join(h.root, "rules", "a.md"));
  writeFileSync(join(h.root, "rules", "b.md"), "B");
  h.configure(["rules/*.md"]);
  assert.deepEqual(h.inject().map(file => file.content), ["B"]);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /a\.md/);
});

test("recursion requires ** and directories are not implicitly expanded", t => {
  const h = fixture(t);
  mkdirSync(join(h.root, "rules", "nested"), { recursive: true });
  writeFileSync(join(h.root, "rules", "a.instructions.md"), "A");
  writeFileSync(join(h.root, "rules", "nested", "b.instructions.md"), "B");
  writeFileSync(join(h.root, "rules", "ignored.md"), "ignored");
  h.configure(["rules/*.instructions.md"]);
  assert.deepEqual(h.inject().map(file => file.content), ["A"]);
  h.configure(["rules/**/*.instructions.md"]);
  assert.deepEqual(h.inject().map(file => file.content), ["A", "B"]);
  h.configure(["rules", "rules/no-match*.md"]);
  assert.deepEqual(h.inject(), []);
  assert.equal(h.warnings.length, 2);
  assert.ok(h.warnings.every(warning => warning.includes("No files matched")));
});

test("absolute patterns handle spaces and overlapping patterns without duplicates", t => {
  const h = fixture(t);
  const directory = join(h.root, "rules with spaces");
  mkdirSync(directory);
  writeFileSync(join(directory, "a.md"), "A");
  writeFileSync(join(directory, "b.md"), "B");
  h.configure([join(directory, "b.md"), join(directory, "*.md")]);
  assert.deepEqual(h.inject().map(file => file.content), ["B", "A"]);
  assert.deepEqual(h.warnings, []);
});

test("absent configuration is a no-op; invalid configuration is visible", t => {
  const h = fixture(t);
  assert.deepEqual(h.inject(), []);
  assert.deepEqual(h.warnings, []);
  for (const paths of ["rules.md", [null], [" "]]) {
    h.configure(paths);
    assert.deepEqual(h.inject(), []);
    assert.match(h.warnings.at(-1), /array of non-empty paths/);
  }
  writeFileSync(join(h.root, "settings.json"), "{broken");
  h.inject();
  assert.equal(h.warnings.length, 4);
});

test("non-interactive failures go to stderr", t => {
  const h = fixture(t);
  h.configure(["missing"]);
  let handler;
  additionalInstructions({ on: (_, callback) => { handler = callback; } }, h.root);
  const errors = [];
  t.mock.method(console, "error", text => errors.push(text));
  handler({ systemPromptOptions: { contextFiles: [] } }, { hasUI: false });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /additional-instructions:.*missing/);
});

test("dotfiles configure the shared source and leave AGENTS with only Pi-specific rules", () => {
  const settings = JSON.parse(readFileSync(new URL("../agent/settings.json", import.meta.url)));
  assert.deepEqual(settings.additionalInstructions.paths, ["~/.copilot/instructions/*.instructions.md"]);
  const agents = readFileSync(new URL("../agent/AGENTS.md", import.meta.url), "utf8");
  assert.ok(!agents.includes("Read them and consider them part of the system prompt"));
  assert.ok(agents.includes("Run named reviewers in separate Pi CLI processes"));
});

test("real Pi session keeps injected instructions through manual compaction without reinjection", async t => {
  const h = fixture(t);
  const sentinel = "ADDITIONAL_INSTRUCTIONS_COMPACTION_SENTINEL";
  writeFileSync(join(h.root, "rules.md"), sentinel);
  h.configure(["*.md"]);
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(hostRoot, "dist/index.js")));
  const { fauxProvider, fauxAssistantMessage } = await import(pathToFileURL(join(hostRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")));
  const faux = fauxProvider({ provider: "instructions-test", models: [{ id: "fixture" }], tokensPerSecond: Infinity });
  faux.setResponses([fauxAssistantMessage("Before compaction"), fauxAssistantMessage("After compaction")]);
  const runtime = await ModelRuntime.create({ authPath: join(h.root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false, keepRecentTokens: 0 }, cacheWarming: "off" });
  let injected = 0;
  const resourceLoader = new DefaultResourceLoader({ cwd: h.root, agentDir: h.root, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      additionalInstructions({ on: (name, handler) => pi.on(name, (event, ctx) => {
        injected++;
        handler(event, ctx);
      }) }, h.root);
      pi.on("session_before_compact", event => ({ compaction: {
        summary: "A deterministic test summary, with no instruction sentinel.",
        firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
      } }));
    }] });
  await resourceLoader.reload();
  const manager = SessionManager.inMemory(h.root);
  const { session } = await createAgentSession({ cwd: h.root, agentDir: h.root, modelRuntime: runtime,
    model: runtime.getModel("instructions-test", "fixture"), thinkingLevel: "off", tools: [],
    settingsManager, resourceLoader, sessionManager: manager });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "print" });
  assert.ok(!session.systemPrompt.includes(sentinel));
  await session.prompt("Before");
  assert.equal(session.getLastAssistantText(), "Before compaction");
  assert.ok(JSON.stringify(manager.buildSessionContext().messages.filter(message => message.role === "system")).includes(sentinel));
  await session.compact();
  const projection = manager.buildSessionContext();
  const system = projection.messages.filter(message => message.role === "system");
  assert.ok(JSON.stringify(system).includes(sentinel), "compacted system state retains instructions verbatim");
  assert.ok(!JSON.stringify(projection.messages.filter(message => message.role !== "system")).includes(sentinel));
  assert.equal(injected, 1, "no extension reinjection during compaction");
  await session.prompt("After");
  assert.equal(session.getLastAssistantText(), "After compaction");
  assert.equal(injected, 2);
  const after = JSON.stringify(manager.buildSessionContext().messages.filter(message => message.role === "system"));
  assert.equal(after.split(sentinel).length - 1, 1, "instructions stay present without accumulating copies");
});
