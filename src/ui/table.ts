import { c, padEnd, padStart, termWidth, truncate, visibleWidth } from "./theme.js";

export interface Column {
  header: string;
  align?: "left" | "right";
  /** Minimum width this column may be shrunk to when the table is too wide. */
  min?: number;
  /** Hard cap on the column width. */
  max?: number;
  /** Drop this column entirely when the width budget is below this many cells. */
  hideBelow?: number;
}

export interface TableOptions {
  /** Total width budget; defaults to the terminal width. */
  width?: number;
  /** Indentation prefix for every line. */
  indent?: string;
}

const B = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", t: "┬", b: "┴", l: "├", r: "┤", x: "┼" };

/** Render a light box-drawing table, shrinking the widest columns to fit the terminal. */
export function renderTable(allColumns: Column[], allRows: string[][], opts: TableOptions = {}): string {
  const indent = opts.indent ?? "";
  const budget = (opts.width ?? termWidth()) - visibleWidth(indent);
  const keep = allColumns.map((col) => !(col.hideBelow && budget < col.hideBelow));
  const columns = allColumns.filter((_, i) => keep[i]);
  const rows = allRows.map((r) => r.filter((_, i) => keep[i]));
  const widths = columns.map((col, i) => {
    let w = visibleWidth(col.header);
    for (const r of rows) w = Math.max(w, visibleWidth(r[i] ?? ""));
    return col.max ? Math.min(w, col.max) : w;
  });
  // borders: 1 + per column (2 padding + 1 separator)
  const overhead = 1 + columns.length * 3;
  let total = widths.reduce((a, b) => a + b, 0) + overhead;
  while (total > budget) {
    let idx = -1;
    let best = 0;
    widths.forEach((w, i) => {
      const min = columns[i].min ?? Math.min(6, visibleWidth(columns[i].header));
      if (w > min && w > best) {
        best = w;
        idx = i;
      }
    });
    if (idx < 0) break;
    widths[idx]--;
    total--;
  }
  // Still too wide at minimum widths: keep shrinking the widest column (never past 1).
  while (total > budget) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i] <= 1) break;
    widths[i]--;
    total--;
  }
  const d = (s: string) => c.dim(s);
  const line = (l: string, m: string, r: string) => indent + d(l + widths.map((w) => B.h.repeat(w + 2)).join(m) + r);
  const cell = (s: string, i: number) => {
    const t = truncate(s, widths[i]);
    return columns[i].align === "right" ? padStart(t, widths[i]) : padEnd(t, widths[i]);
  };
  const row = (cells: string[]) => indent + d(B.v) + cells.map((s, i) => ` ${cell(s, i)} `).join(d(B.v)) + d(B.v);
  const out = [
    line(B.tl, B.t, B.tr),
    row(columns.map((col) => c.bold(col.header))),
    line(B.l, B.x, B.r),
    ...rows.map((r) => row(columns.map((_, i) => r[i] ?? ""))),
    line(B.bl, B.b, B.br),
  ];
  return out.join("\n");
}
