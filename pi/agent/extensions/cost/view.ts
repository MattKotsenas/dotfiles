import type { Theme } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { Checkpoint, CostSnapshot } from "./model.ts";

export interface CostActions {
  mark(afterEntryId: string, name: string): void;
  undo(): void;
  footer(id: string | null): void;
}

type Mode = "bars" | "table";
const money = (cost: number) => `$${cost.toFixed(2)}`;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export class CostView {
  mode: Mode = "bars";
  branch = false;
  selected = 0;
  rangeId: string | undefined;
  picking = false;
  checkpointSelection = 0;
  private windowStart: number | undefined;
  private snapshot: CostSnapshot;
  private readonly source: (rangeId?: string) => CostSnapshot;
  private readonly theme: Theme;
  private readonly redraw: () => void;
  private readonly close: () => void;
  private readonly actions: CostActions;

  constructor(
    source: (rangeId?: string) => CostSnapshot,
    theme: Theme,
    redraw: () => void,
    close: () => void,
    actions: CostActions,
  ) {
    this.source = source;
    this.theme = theme;
    this.redraw = redraw;
    this.close = close;
    this.actions = actions;
    this.snapshot = source();
    this.selected = Math.max(0, this.rows().length - 1);
  }

  private refresh() {
    this.snapshot = this.source(this.rangeId);
    if (this.rangeId && !this.snapshot.range) {
      this.rangeId = undefined;
      this.snapshot = this.source();
      this.windowStart = undefined;
    }
    this.selected = Math.max(0, Math.min(this.selected, this.rows().length - 1));
    this.checkpointSelection = Math.min(this.checkpointSelection, this.snapshot.checkpoints.length);
  }

  rows() {
    return this.snapshot.activities.flatMap((item) => {
      if (this.branch && !item.onPath && item.pathMain + item.pathTools + item.pathOther === 0) return [];
      const main = this.branch ? item.pathMain : item.main;
      const tools = this.branch ? item.pathTools : item.tools;
      const other = this.branch ? item.pathOther : item.other;
      return [{ item, index: item.order, main, tools, other, cost: main + tools + other }];
    });
  }

  private since(checkpoint?: Checkpoint) {
    return this.snapshot.total - (checkpoint?.total ?? 0);
  }

  handleInput(data: string) {
    this.refresh();
    const key = (name: KeyId) => matchesKey(data, name);
    if (key("ctrl+c")) return this.close();
    if (key("escape")) {
      if (this.picking) this.picking = false;
      else return this.close();
    } else if (this.picking) {
      const count = this.snapshot.checkpoints.length + 1;
      if (key("up")) this.checkpointSelection = (this.checkpointSelection + count - 1) % count;
      if (key("down")) this.checkpointSelection = (this.checkpointSelection + 1) % count;
      const checkpoint = this.snapshot.checkpoints[this.checkpointSelection - 1];
      if (key("enter")) {
        this.rangeId = checkpoint?.id;
        this.refresh();
        this.selected = Math.max(0, this.rows().length - 1);
        this.windowStart = undefined;
        this.picking = false;
      }
      if (data === "f") this.actions.footer(checkpoint?.id ?? null);
    } else {
      const rows = this.rows();
      const count = rows.length;
      if (key("left") || key("up")) this.selected--;
      if (key("right") || key("down")) this.selected++;
      if (key("home")) this.selected = 0;
      if (key("end")) this.selected = count - 1;
      if (data === "t") this.mode = this.mode === "table" ? "bars" : "table";
      if (data === "p") {
        const index = rows[this.selected]?.index;
        this.branch = !this.branch;
        this.windowStart = undefined;
        this.selected = Math.max(
          0,
          this.rows().findIndex((row) => row.index === index),
        );
      }
      if (data === "c") {
        this.picking = true;
        this.checkpointSelection = 0;
      }
      if (data === "m" && rows[this.selected]) {
        const item = rows[this.selected].item;
        this.actions.mark(item.afterEntryId, `After #${item.order + 1}`);
      }
      if (data === "u") this.actions.undo();
    }
    this.refresh();
    this.redraw();
  }

  invalidate() {}

  render(width: number, height = 30): string[] {
    this.refresh();
    const th = this.theme;
    const w = Math.max(1, width - 4);
    const dim = (text: string) => th.fg("muted", text);
    const accent = (text: string) => th.fg("accent", text);
    const frame = (body: string[]) => {
      const lines = body.map(
        (line) => th.fg("border", "│ ") + truncateToWidth(line, w, "…", true) + th.fg("border", " │"),
      );
      return [
        th.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
        ...lines,
        th.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
      ]
        .slice(0, height)
        .map((line) => truncateToWidth(line, width));
    };
    if (width < 38 || height < 24)
      return frame([accent("Cost"), "Needs at least 38 columns × 24 rows.", dim("Resize or Esc to close.")]);
    const footer = `Footer: ${money(this.snapshot.footerCost)} ${this.snapshot.baseline ? `since ${this.snapshot.baseline.name}` : "session"}`;
    if (this.picking) {
      const choices = [undefined, ...this.snapshot.checkpoints];
      const tail = [
        "",
        ...(this.snapshot.baseline ? wrapTextWithAnsi(dim(footer), w) : []),
        dim("↑/↓ choose · Enter inspect"),
        dim("f footer · Esc back"),
      ];
      const capacity = Math.max(1, height - 4 - tail.length);
      const start = Math.max(0, this.checkpointSelection - capacity + 1);
      return frame([
        accent("Checkpoints"),
        "",
        ...choices.slice(start, start + capacity).map((checkpoint, offset) => {
          const selected = start + offset === this.checkpointSelection;
          const text =
            `${selected ? "›" : " "} ${money(this.since(checkpoint))}  ${checkpoint?.name ?? "Session start"}` +
            (checkpoint?.id === this.snapshot.baseline?.id ? " [footer]" : "");
          return selected ? accent(text) : text;
        }),
        ...tail,
      ]);
    }
    const rows = this.rows();
    const costs = rows.map((row) => row.cost);
    const total = sum(costs);
    const max = Math.max(0, ...costs);
    const active = rows[this.selected];
    const hints = [
      ...wrapTextWithAnsi(dim(`Arrows select · t ${this.mode === "bars" ? "table" : "bars"}`), w),
      ...wrapTextWithAnsi(dim("p path · c checkpoints · m mark · u undo mark"), w),
      dim("Esc close · Home/End first/last"),
    ];
    const summary = `Session ${money(this.snapshot.total)} · Current path ${money(this.snapshot.pathTotal)}`;
    const body = [
      accent("Cost") + dim("   Estimated USD"),
      ...wrapTextWithAnsi(summary, w),
      ...(this.snapshot.range ? [`Since ${this.snapshot.range.name}: ${money(total)}`] : []),
      dim(`Activity · ${this.branch ? "current path" : "all branches"}`),
    ];
    const checkpoint = this.snapshot.checkpoints.find((mark) => mark.after === active?.index);
    const tail = [
      ...(active
        ? [
            accent(`#${active.index + 1}  ${money(active.cost)}${active.item.missing ? " + unknown usage" : ""}`),
            truncateToWidth(active.item.excerpt, w),
            dim(`Model ${money(active.main)} · Tools ${money(active.tools)} · Other ${money(active.other)}`),
          ]
        : []),
      checkpoint ? accent(`Checkpoint: ${checkpoint.name}`) : "",
      ...(this.snapshot.baseline ? [dim(footer)] : []),
      ...hints,
    ];
    // Both bar charts use one column per activity and the same page and gutter.
    const available = Math.max(3, height - 2 - body.length - tail.length - 3);
    const activityHeight = Math.max(1, Math.ceil(available * 0.6));
    const cumulativeHeight = Math.max(1, available - activityHeight);
    const capacity = Math.max(1, w - 7);
    const latestStart = Math.max(0, rows.length - capacity);
    let start = Math.min(this.windowStart ?? latestStart, latestStart);
    if (this.selected < start) start = this.selected;
    if (this.selected >= start + capacity) start = this.selected - capacity + 1;
    this.windowStart = start;
    const page = rows.slice(start, start + capacity);
    const selectedColumn = this.selected - start;
    const plot = (values: number[], base: number, ceiling: number, plotHeight: number, cumulative: boolean) => {
      const blocks = " ▁▂▃▄▅▆▇█";
      return Array.from({ length: plotHeight }, (_, line) => {
        const y = plotHeight - line - 1;
        const axis = line === 0 ? money(ceiling) : y === 0 ? money(base) : "";
        return (
          dim(truncateToWidth(axis, 7, "", true)) +
          values
            .map((value, col) => {
              const units = ceiling > base ? ((value - base) / (ceiling - base)) * plotHeight * 8 : 0;
              const glyph =
                !cumulative && page[col].item.missing
                  ? y === 0
                    ? "?"
                    : " "
                  : y === 0 && value === base
                    ? "·"
                    : blocks[Math.max(0, Math.min(8, Math.ceil(units - y * 8)))];
              const cell = cumulative
                ? accent(glyph)
                : page[col].item.kind === "overhead"
                  ? dim(glyph)
                  : page[col].cost === max && max > 0
                    ? th.fg("warning", glyph)
                    : accent(glyph);
              return col === selectedColumn ? th.inverse(cell) : cell;
            })
            .join("")
        );
      });
    };
    if (this.mode === "bars") {
      body.push(
        ...plot(
          page.map((row) => row.cost),
          0,
          max,
          activityHeight,
          false,
        ),
      );
    } else {
      body.push(dim(`${"Cost".padStart(13)}  ${"Cumulative".padStart(10)}  Prompt / operation`));
      const count = Math.max(1, activityHeight - 1);
      const tableStart = Math.max(start, Math.min(this.selected - Math.floor(count / 2), start + page.length - count));
      let running = sum(costs.slice(0, tableStart));
      const tableRows = rows.slice(tableStart, Math.min(start + page.length, tableStart + count));
      for (const [offset, row] of tableRows.entries()) {
        running += row.cost;
        const label =
          `${tableStart + offset === this.selected ? "›" : " "}${String(row.index + 1).padStart(4)} ` +
          `${(row.item.missing ? "?" : money(row.cost)).padStart(7)}  ${money(running).padStart(10)}  ${row.item.excerpt}`;
        body.push(tableStart + offset === this.selected ? accent(label) : label);
      }
      body.push(...Array.from({ length: Math.max(0, count - tableRows.length) }, () => ""));
    }
    const position = rows.length
      ? `${start > 0 ? "← " : ""}${start + 1}–${Math.min(start + capacity, rows.length)} / ${rows.length}`
      : "No activity in this range.";
    body.push(dim(truncateToWidth(position, w - 1, "", true) + (start + page.length < rows.length ? "→" : " ")));
    const before = sum(costs.slice(0, start));
    let running = before;
    const cumulative = page.map((row) => {
      running += row.cost;
      return running;
    });
    body.push(
      dim(
        active
          ? `Cumulative at #${active.index + 1}: ${money(sum(costs.slice(0, this.selected + 1)))}`
          : "Cumulative: $0.00",
      ),
    );
    body.push(...plot(cumulative, 0, total, cumulativeHeight, true));
    body.push(
      "       " +
        page
          .map((row) => (this.snapshot.checkpoints.some((mark) => mark.after === row.index) ? accent("┊") : " "))
          .join(""),
    );
    body.push(...tail);
    return frame(body);
  }
}
