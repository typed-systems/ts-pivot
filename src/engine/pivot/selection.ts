import { cellValue, type DisplayRows, rowPath } from "./display";
import type { PivotResult } from "./pivot";

/** A block of display rows × pivot columns (colCount = the Total column), inclusive. */
export interface CellBlock {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface SelectionStats {
  rows: number;
  cols: number;
  /** "first row path → last row path" (or one path). */
  rowSpan: string;
  colSpan: string;
  /** Non-empty values in the block, and their sum / min / max. */
  n: number;
  sum: number;
  min: number;
  max: number;
  /** Subtotal rows plus rows inside them: the sum counts those values twice. */
  mixed: boolean;
}

/** Summary of the selected cells, as shown in the selection bar. */
export function selectionStats(result: PivotResult, display: DisplayRows, block: CellBlock): SelectionStats {
  const { r0, r1, c0, c1 } = block;
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let minLevel = 99;
  let maxLevel = -1;
  for (let r = r0; r <= r1; r++) {
    const k = display.level[r]!;
    if (k < minLevel) minLevel = k;
    if (k > maxLevel) maxLevel = k;
    for (let c = c0; c <= c1; c++) {
      const v = cellValue(result, display, r, c);
      if (v !== v) continue;
      n++;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const colName = (c: number) => (c >= result.colCount ? "Total" : result.colLabels.map((l) => l[c] ?? "").join(" › "));
  const rowName = (r: number) => rowPath(result, display, r).join(" › ");
  return {
    rows: r1 - r0 + 1,
    cols: c1 - c0 + 1,
    rowSpan: r0 === r1 ? rowName(r0) : `${rowName(r0)} → ${rowName(r1)}`,
    colSpan: c0 === c1 ? colName(c0) : `${colName(c0)} → ${colName(c1)}`,
    n,
    sum,
    min,
    max,
    mixed: minLevel < maxLevel,
  };
}
