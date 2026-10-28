import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { CostView } from "../agent/extensions/cost/view.ts";

const sdkRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const { getThemeByName } = await import(pathToFileURL(join(sdkRoot, "dist/modes/interactive/theme/theme.js")));
const plain = (lines) => lines.map(stripTerminalSequences).join("\n");

// Snapshot contract fixture, independent of the spike's private export format.
function memory() {
  const records = [1, 2, 4, 8].map((cost, order) => ({
    id: `activity-${order}`,
    afterEntryId: `usage-${order}`,
    order,
    kind: order === 2 ? "overhead" : "prompt",
    excerpt: `Operation ${order + 1} 日本語`,
    onPath: order !== 1,
    main: cost,
    tools: 0,
    other: 0,
    pathMain: order === 1 ? 0 : cost / 2,
    pathTools: 0,
    pathOther: 0,
    cost,
    missing: false,
    provenance: "historical",
    partial: false,
  }));
  const checkpoints = [];
  const requests = [];
  let baselineId = null;
  let nextId = 0;
  const actions = {
    mark(afterEntryId, name) {
      const item = records.find((item) => item.afterEntryId === afterEntryId);
      assert(item, "mark must anchor to an actual entry, not an activity id");
      checkpoints.push({
        version: 1,
        owner: "test-session",
        kind: "checkpoint",
        id: `mark-${nextId++}`,
        name,
        afterEntryId,
        after: item.order,
        total: records.filter((row) => row.order <= item.order).reduce((n, row) => n + row.cost, 0),
      });
    },
    undo() {
      checkpoints.pop();
    },
    footer(id) {
      baselineId = id;
    },
  };
  const source = (rangeId) => {
    requests.push(rangeId);
    // Fresh identities ensure the renderer compares checkpoint IDs, not object references.
    const range = checkpoints.find((mark) => mark.id === rangeId);
    const baseline = checkpoints.find((mark) => mark.id === baselineId);
    const total = records.reduce((n, item) => n + item.cost, 0);
    const copy = (value) => (value ? Object.freeze({ ...value }) : undefined);
    return Object.freeze({
      activities: Object.freeze(records.filter((item) => item.order > (range?.after ?? -1)).map(copy)),
      checkpoints: Object.freeze(checkpoints.map(copy)),
      range: copy(range),
      baseline: copy(baseline),
      total,
      pathTotal: records.reduce((n, item) => n + item.pathMain, 0),
      footerCost: total - (baseline?.total ?? 0),
    });
  };
  const ui = new CostView(
    source,
    getThemeByName("dark"),
    () => {},
    () => {},
    actions,
  );
  return { ui, source, actions, records, checkpoints, requests };
}

function pick(ui, index, key = "\r") {
  ui.handleInput("c");
  for (let i = 0; i < index; i++) ui.handleInput("\x1b[B");
  ui.handleInput(key);
}

test("source-sliced ranges preserve ledger labels, path amounts, mark anchors and unfiltered totals", () => {
  const { ui, source, actions, records } = memory();
  assert.equal(ui.selected, 3, "opens at newest, not largest or first");
  actions.mark(records[1].afterEntryId, "Boundary");
  assert.equal(source().activities.length, 4);
  pick(ui, 1);
  assert.equal(ui.rangeId, source().checkpoints[0].id);
  assert.equal(source().baseline, undefined, "inspection never selects the footer");
  assert.deepEqual(
    ui.rows().map((row) => row.index),
    [2, 3],
    "no second temporal slice in the view",
  );
  ui.handleInput("p");
  assert.deepEqual(
    ui.rows().map((row) => row.cost),
    [2, 4],
  );
  const screen = plain(ui.render(90, 34));
  assert(screen.includes("Session $15.00 · Current path $6.50"));
  assert(screen.includes("Since Boundary: $6.00"));
  assert(screen.includes("#4  $4.00"));
  assert(screen.includes("Cumulative at #4: $6.00"));
  assert(screen.includes("Model $4.00 · Tools $0.00 · Other $0.00"));
  ui.handleInput("m");
  const mark = source().checkpoints.at(-1);
  assert.equal(mark.afterEntryId, "usage-3");
  assert.equal(mark.name, "After #4");
  assert(plain(ui.render(90, 34)).includes("Checkpoint: After #4"));
  assert.equal([...plain(ui.render(90, 34))].filter((c) => c === "┊").length, 1);
  ui.handleInput("u");
  assert.equal(source().checkpoints.length, 1);
  assert.equal(ui.selected, 1);
});

test("path filtering keeps full-ledger numbering in table and marks", () => {
  const { ui, source } = memory();
  ui.handleInput("p");
  ui.handleInput("\x1b[D");
  assert.equal(ui.rows()[ui.selected].item.order, 2);
  ui.handleInput("t");
  const screen = plain(ui.render(90, 34));
  assert.match(screen, /›\s+3\s+\$2\.00/);
  assert(screen.includes("Cumulative at #3: $2.50"));
  ui.handleInput("m");
  assert.equal(source().checkpoints[0].name, "After #3");
  assert.equal(source().checkpoints[0].afterEntryId, "usage-2");
});

test("footer selection is independent, persists through refresh and compares IDs in the picker", () => {
  const { ui, source, actions, records } = memory();
  actions.mark(records[1].afterEntryId, "Boundary");
  pick(ui, 1, "f");
  assert.equal(ui.rangeId, undefined);
  assert.equal(source().baseline.id, source().checkpoints[0].id);
  const picker = plain(ui.render(90, 34));
  assert(picker.includes("Boundary [footer]"));
  assert(picker.includes("Footer: $12.00 since Boundary"));
  ui.handleInput("\x1b");
  pick(ui, 1);
  assert(plain(ui.render(90, 34)).includes("Footer: $12.00 since Boundary"));
  pick(ui, 0, "f");
  assert.equal(source().baseline, undefined);
  ui.handleInput("\x1b");
  assert(ui.rangeId, "footer clear does not clear inspection range");
  assert(!plain(ui.render(90, 34)).includes("Footer:"));
});

test("removed range and baseline fall back on refresh without leaving stale view state", () => {
  const { ui, source, actions, requests } = memory();
  ui.handleInput("m");
  const id = source().checkpoints[0].id;
  actions.footer(id);
  pick(ui, 1);
  assert.equal(ui.rows().length, 0);
  assert.equal(ui.rangeId, id);
  actions.undo();
  const screen = plain(ui.render(90, 34));
  assert.equal(ui.rangeId, undefined);
  assert.equal(requests.at(-2), id);
  assert.equal(requests.at(-1), undefined);
  assert.equal(ui.rows().length, 4);
  assert(!screen.includes("Since After"));
  assert(!screen.includes("Footer:"));
});

test("render and input refresh external changes before details, bounds and mark actions", () => {
  const { ui, source, records, checkpoints } = memory();
  assert.equal(ui.selected, 3);
  records.pop();
  ui.handleInput("m");
  assert.equal(ui.selected, 2);
  assert.equal(source().checkpoints[0].afterEntryId, "usage-2");
  records[2].main = records[2].cost = 40;
  const screen = plain(ui.render(90, 34));
  assert(screen.includes("#3  $40.00"));
  assert(screen.includes("Session $43.00"));
  checkpoints.length = 0;
  assert(!plain(ui.render(90, 34)).includes("Checkpoint: After #3"));
});

test("empty and unknown-cost snapshots stay bounded and show no persistent caveat banner", () => {
  const { ui, records } = memory();
  records[3].missing = true;
  assert(plain(ui.render(90, 34)).includes("+ unknown usage"));
  records.length = 0;
  for (const mode of ["bars", "table"]) {
    ui.mode = mode;
    const lines = ui.render(38, 24);
    assert(lines.length <= 24);
    assert(lines.every((line) => visibleWidth(line) <= 38));
    assert(stripTerminalSequences(lines.at(-1)).startsWith("╰"));
    const screen = plain(lines);
    assert(screen.includes("No activity in this range."));
    assert(screen.includes("Esc close"));
    assert(!screen.includes("unknown usage"));
  }
  assert(plain(ui.render(30, 15)).includes("Cost"));
  assert(!plain(ui.render(30, 15)).includes("mockup"));
});
