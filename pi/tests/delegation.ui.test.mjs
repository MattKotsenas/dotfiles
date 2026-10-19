import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { answer, fixture, invoke } from "./delegation/fixture.mjs";
import { sdk } from "./delegation/sdk.mjs";
import { modelId, providerId } from "./delegation/ui-extension.mjs";

for (const mode of ["tui", "rpc", "print"]) {
  test(`child UI preserves parent display state and prompt results in ${mode} mode`, async (t) => {
    const { parent, authPath } = await fixture(t, { persisted: true });
    const extensions = join(dirname(authPath), "extensions");
    await writeFile(
      join(extensions, "compact-footer.ts"),
      `export { default } from ${JSON.stringify(new URL("../agent/extensions/compact-footer.ts", import.meta.url).href)};`,
    );
    await writeFile(
      join(extensions, "ui-probe.ts"),
      `export { default } from ${JSON.stringify(new URL("./delegation/ui-extension.mjs", import.meta.url).href)};`,
    );
    await parent.reload();
    const status = new Map();
    const displayWrites = [];
    const notifications = [];
    const ui = { ...parent.extensionRunner.getUIContext() };
    for (const name of [
      "setWorkingMessage",
      "setWorkingVisible",
      "setWorkingIndicator",
      "setHiddenThinkingLabel",
      "setWidget",
      "setFooter",
      "setHeader",
      "setTitle",
      "pasteToEditor",
      "setEditorText",
      "addAutocompleteProvider",
      "setEditorComponent",
      "setTheme",
      "setToolsExpanded",
      "onTerminalInput",
    ]) {
      ui[name] = () => {
        displayWrites.push(name);
        return () => {};
      };
    }
    Object.assign(ui, {
      setStatus: (key, value) => status.set(key, value),
      getEditorText: () => "parent draft",
      select: async () => "allow",
      confirm: async () => mode === "tui",
      input: async () => "input-result",
      editor: async () => "editor-result",
      custom: async (factory) =>
        mode === "tui" ? new Promise((resolve) => factory(undefined, undefined, undefined, resolve)) : undefined,
      notify: (...args) => notifications.push(args),
    });
    parent.extensionRunner.setUIContext(mode === "print" ? undefined : ui, mode);
    await parent.extensionRunner.emit({ type: "session_start" });
    const parentModel = status.get("compact-model");
    if (mode === "tui") assert(parentModel.includes("scripted"), "precondition: the real parent footer is published");
    assert.deepEqual(displayWrites, []);
    const result = await invoke(parent, { provider: providerId, model: modelId, prompt: "Run UI probe", tools: [] });
    assert.equal(answer(result), "CHILD_DONE");
    assert.equal(status.get("compact-model"), parentModel, "the child's footer must not overwrite the parent's model");
    assert(!status.has("child-status"));
    assert.deepEqual(displayWrites, [], "children must not change persistent parent display/editor state");
    const record = parent.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "delegation.child.v1" &&
          entry.data.handle === result.details.handle,
      ).data;
    const child = sdk.SessionManager.open(record.sessionFile);
    const observed = child
      .getEntries()
      .find((entry) => entry.type === "custom" && entry.customType === "child-ui").data;
    assert.deepEqual(observed, {
      mode,
      hasUI: mode !== "print",
      selected: mode === "print" ? null : "allow",
      confirmed: mode === "tui",
      input: mode === "print" ? null : "input-result",
      edited: mode === "print" ? null : "editor-result",
      custom: mode === "tui" ? "custom-result" : null,
      editorText: "",
    });
    assert.deepEqual(notifications, mode === "print" ? [] : [["Child notification", "info"]]);
    displayWrites.length = 0;
    parent.extensionRunner.setUIContext(undefined, "print");
    await parent.reload();
    assert.deepEqual(displayWrites, [], "child shutdown must not clear or replace parent chrome");
    assert.equal(status.get("compact-model"), parentModel);
  });
}
