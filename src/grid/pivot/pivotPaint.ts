import type { DisplayRows, RowSort } from "../../engine/pivot/display";
import type { PivotResult } from "../../engine/pivot/pivot";
import { fmt } from "../../lib/format";
import { HEAT_CSS, heatIndex, heatIsDark } from "../../theme/palette";
import { GRID } from "../../theme/theme";
import { ARROW_W, drawSortArrow, FONT, FONT_BOLD, PAD, ROW_H } from "../core/gridStyle";

/**
 * Painting one frame of the pivot grid. Everything a frame needs is in a
 * `PivotFrame` snapshot that CanvasPivotGrid builds per draw, so these are
 * plain functions with no grid state of their own.
 */

export const HEADER_ROW_H = 26;
export const INDENT = 16;
export const CARET_W = 16;

// Colors come from the live theme object (light/dark), read on every draw.
const C = GRID;

/** Rectangle of display rows × grid columns (colCount = the Total column), inclusive. */
export interface CellRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface PivotFrame {
  ctx: CanvasRenderingContext2D;
  data: PivotResult;
  rows: DisplayRows;
  // layout (CSS px)
  vw: number;
  vh: number;
  frozenLeft: number;
  colW: number;
  headerH: number;
  footerH: number;
  /** vertical text nudge, see canvasText.ts */
  tn: number;
  // visible window
  firstRow: number;
  visRows: number;
  firstCol: number;
  visCols: number;
  bodyTop: number;
  bodyBottom: number;
  bodyH: number;
  colX: (c: number) => number;
  rowY: (r: number) => number;
  // state
  heatmap: boolean;
  hover: { row: number; col: number } | null;
  linked: { row: number; col: number } | null;
  selection: CellRange | null;
  sort: RowSort | null;
}

/** Everything but the scrollbars and the bottom bar, in paint order. */
export function paintPivot(f: PivotFrame) {
  const { ctx } = f;
  ctx.textBaseline = "middle";

  ctx.save();
  ctx.beginPath();
  ctx.rect(f.frozenLeft, f.bodyTop, f.vw - f.frozenLeft, f.bodyH);
  ctx.clip();
  paintCells(f);
  paintHighlights(f);
  paintGridLines(f);
  ctx.restore();

  paintTree(f);
  paintColHeaders(f);
  paintFooter(f);
  paintCorner(f);
  paintSeparators(f);

  // Cell outlines last, so frozen separators / headers never cover a side.
  ctx.save();
  ctx.beginPath();
  ctx.rect(f.frozenLeft - 1, f.bodyTop - 1, f.vw - f.frozenLeft + 1, f.bodyH + 2);
  ctx.clip();
  paintOutlines(f);
  ctx.restore();
}

function paintCells(f: PivotFrame) {
  const { ctx, data: d, rows } = f;
  const leafLevel = d.levels.length - 1;
  for (let i = 0; i < f.visRows; i++) {
    const r = f.firstRow + i;
    ctx.fillStyle = rows.level[r]! < leafLevel ? C.group : r & 1 ? C.stripe : C.bg;
    ctx.fillRect(f.frozenLeft, f.rowY(r), f.vw - f.frozenLeft, ROW_H);
  }

  ctx.textAlign = "right";
  for (let i = 0; i < f.visRows; i++) {
    const r = f.firstRow + i;
    const k = rows.level[r]!;
    const lv = d.levels[k]!;
    const ri = rows.index[r]!;
    const isGroup = k < leafLevel;
    const y = f.rowY(r);
    const ty = y + ROW_H / 2 + f.tn;
    ctx.font = isGroup ? FONT_BOLD : FONT;
    for (let j = 0; j < f.visCols; j++) {
      const c = f.firstCol + j;
      const x = f.colX(c);
      const isTotal = c === d.colCount;
      const v = isTotal ? lv.totals[ri]! : lv.values[ri * d.colCount + c]!;
      let dark = false;
      if (isTotal) {
        ctx.fillStyle = C.total;
        ctx.fillRect(x, y, f.colW, ROW_H);
      } else if (f.heatmap && v === v) {
        // each level is colored against its own range, so subtotals don't wash out leaves
        const hi = heatIndex(v, lv.min, lv.max);
        ctx.fillStyle = HEAT_CSS[hi]!;
        ctx.fillRect(x, y, f.colW, ROW_H);
        dark = heatIsDark(hi);
      }
      if (v === v) {
        ctx.fillStyle = dark ? C.heatTextDark : C.text;
        if (isTotal && !isGroup) ctx.font = FONT_BOLD;
        ctx.fillText(fmt(v), x + f.colW - PAD, ty);
        if (isTotal && !isGroup) ctx.font = FONT;
      }
    }
  }
}

function paintHighlights(f: PivotFrame) {
  const { ctx } = f;
  const sel = f.selection;
  if (sel && (sel.r0 !== sel.r1 || sel.c0 !== sel.c1)) {
    const y0 = Math.max(f.bodyTop - ROW_H, f.rowY(sel.r0));
    const y1 = Math.min(f.bodyTop + f.bodyH + ROW_H, f.rowY(sel.r1) + ROW_H);
    ctx.fillStyle = C.selection;
    if (y1 > y0) ctx.fillRect(f.colX(sel.c0), y0, (sel.c1 - sel.c0 + 1) * f.colW, y1 - y0);
  }
  const h = f.hover;
  if (h && h.row >= 0) {
    ctx.fillStyle = C.hover;
    if (h.row >= f.firstRow && h.row < f.firstRow + f.visRows) ctx.fillRect(f.frozenLeft, f.rowY(h.row), f.vw, ROW_H);
    ctx.fillRect(f.colX(h.col), f.bodyTop, f.colW, f.bodyH);
  }
}

/** Body grid lines: one path. */
function paintGridLines(f: PivotFrame) {
  const { ctx } = f;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let j = 0; j <= f.visCols; j++) {
    const x = Math.round(f.colX(f.firstCol + j)) - 0.5;
    ctx.moveTo(x, f.bodyTop);
    ctx.lineTo(x, f.bodyBottom);
  }
  for (let i = 0; i <= f.visRows; i++) {
    const y = Math.round(f.rowY(f.firstRow + i)) - 0.5;
    ctx.moveTo(f.frozenLeft, y);
    ctx.lineTo(f.vw, y);
  }
  ctx.stroke();
}

/** Frozen tree column: indent per level, caret on group rows. */
function paintTree(f: PivotFrame) {
  const { ctx, data: d, rows } = f;
  const leafLevel = d.levels.length - 1;
  const w = f.frozenLeft;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, f.bodyTop, w, f.bodyH);
  ctx.clip();
  ctx.textAlign = "left";

  for (let i = 0; i < f.visRows; i++) {
    const r = f.firstRow + i;
    const k = rows.level[r]!;
    const idx = rows.index[r]!;
    const y = f.rowY(r);
    const isGroup = k < leafLevel;
    ctx.fillStyle = isGroup ? C.group : r & 1 ? C.stripe : C.bg;
    ctx.fillRect(0, y, w, ROW_H);
    if (f.hover?.row === r) {
      ctx.fillStyle = C.hover;
      ctx.fillRect(0, y, w, ROW_H);
    }
    const x = PAD + k * INDENT;
    const cy = y + ROW_H / 2;
    if (isGroup) {
      ctx.fillStyle = C.accent;
      ctx.beginPath();
      if (rows.expanded[r]) {
        ctx.moveTo(x, cy - 3);
        ctx.lineTo(x + 8, cy - 3);
        ctx.lineTo(x + 4, cy + 3);
      } else {
        ctx.moveTo(x + 1, cy - 4);
        ctx.lineTo(x + 7, cy);
        ctx.lineTo(x + 1, cy + 4);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.font = isGroup ? FONT_BOLD : FONT;
    ctx.fillStyle = C.text;
    ctx.fillText(d.levels[k]!.labels[k]![idx]!, x + CARET_W, cy + f.tn);
  }

  ctx.strokeStyle = C.line;
  ctx.beginPath();
  for (let i = 0; i <= f.visRows; i++) {
    const y = Math.round(f.rowY(f.firstRow + i)) - 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.restore();
}

function sortedCol(sort: RowSort | null): number {
  return sort?.by === "value" ? sort.col : -2;
}

function paintColHeaders(f: PivotFrame) {
  const { ctx, data: d } = f;
  ctx.save();
  ctx.beginPath();
  ctx.rect(f.frozenLeft, 0, f.vw - f.frozenLeft, f.headerH);
  ctx.clip();
  ctx.fillStyle = C.header;
  ctx.fillRect(f.frozenLeft, 0, f.vw - f.frozenLeft, f.headerH);
  ctx.textBaseline = "middle";

  const levels = d.colLabels.length;
  for (let l = 0; l < levels; l++) {
    const y = l * HEADER_ROW_H;
    const isLeaf = l === levels - 1;
    ctx.font = isLeaf ? FONT : FONT_BOLD;
    // Walk visible columns, emitting merged spans.
    let spanStart = f.firstCol;
    const end = Math.min(d.colCount, f.firstCol + f.visCols);
    for (let c = f.firstCol + 1; c <= end; c++) {
      if (c === end || groupChanged(d.colLabels, l, c)) {
        const x0 = f.colX(spanStart);
        const x1 = f.colX(c);
        const label = d.colLabels[l]![spanStart]!;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y, x1 - x0, HEADER_ROW_H);
        ctx.clip();
        ctx.fillStyle = C.headerText;
        if (isLeaf) {
          const sorted = f.sort && sortedCol(f.sort) === spanStart ? f.sort : null;
          ctx.textAlign = "right";
          ctx.fillStyle = sorted ? C.accent : C.headerText;
          ctx.fillText(label, x1 - PAD - (sorted ? ARROW_W : 0), y + HEADER_ROW_H / 2 + f.tn);
          if (sorted) drawSortArrow(ctx, x1 - PAD - 4, y + HEADER_ROW_H / 2, sorted.dir);
        } else {
          // sticky: outer group labels stay visible while their span scrolls
          ctx.textAlign = "left";
          ctx.fillText(label, Math.max(x0, f.frozenLeft) + PAD, y + HEADER_ROW_H / 2 + f.tn);
        }
        ctx.restore();
        ctx.strokeStyle = C.strong;
        ctx.beginPath();
        ctx.moveTo(Math.round(x1) - 0.5, y);
        ctx.lineTo(Math.round(x1) - 0.5, f.headerH);
        ctx.stroke();
        spanStart = c;
      }
    }
    ctx.strokeStyle = C.strong;
    ctx.beginPath();
    ctx.moveTo(f.frozenLeft, y + HEADER_ROW_H - 0.5);
    ctx.lineTo(f.vw, y + HEADER_ROW_H - 0.5);
    ctx.stroke();
  }

  // totals column header (spans all levels)
  const tc = d.colCount;
  if (tc >= f.firstCol && tc < f.firstCol + f.visCols) {
    const x = f.colX(tc);
    ctx.fillStyle = C.total;
    ctx.fillRect(x, 0, f.colW, f.headerH);
    const sorted = f.sort && sortedCol(f.sort) === tc ? f.sort : null;
    ctx.fillStyle = sorted ? C.accent : C.headerText;
    ctx.font = FONT_BOLD;
    ctx.textAlign = "right";
    ctx.fillText("Total", x + f.colW - PAD - (sorted ? ARROW_W : 0), f.headerH - HEADER_ROW_H / 2 + f.tn);
    if (sorted) drawSortArrow(ctx, x + f.colW - PAD - 4, f.headerH - HEADER_ROW_H / 2, sorted.dir);
  }
  if (f.hover && f.hover.col >= f.firstCol) {
    ctx.fillStyle = C.hover;
    ctx.fillRect(f.colX(f.hover.col), 0, f.colW, f.headerH);
  }
  ctx.restore();
}

/** Frozen grand-total row. */
function paintFooter(f: PivotFrame) {
  const { ctx, data: d } = f;
  const y = f.bodyBottom;
  ctx.save();
  ctx.fillStyle = C.total;
  ctx.fillRect(0, y, f.vw, f.footerH);
  ctx.font = FONT_BOLD;
  ctx.fillStyle = C.headerText;
  ctx.textAlign = "left";
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y, f.frozenLeft, f.footerH);
  ctx.clip();
  const leaves = d.levels[d.levels.length - 1]!.count;
  const label = `Total  (${leaves.toLocaleString()} rows)`;
  ctx.fillText(ctx.measureText(label).width + PAD * 2 <= f.frozenLeft ? label : "Total", PAD, y + ROW_H / 2 + f.tn);
  ctx.restore();
  ctx.beginPath();
  ctx.rect(f.frozenLeft, y, f.vw - f.frozenLeft, f.footerH);
  ctx.clip();
  ctx.textAlign = "right";
  for (let j = 0; j < f.visCols; j++) {
    const c = f.firstCol + j;
    const v = c === d.colCount ? d.grandTotal : d.colTotals[c]!;
    ctx.fillText(fmt(v), f.colX(c) + f.colW - PAD, y + ROW_H / 2 + f.tn);
  }
  ctx.restore();
}

/** Top-left corner: row field names (sortable by label) and column field names. */
function paintCorner(f: PivotFrame) {
  const { ctx, data: d } = f;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, f.frozenLeft, f.headerH);
  ctx.clip();
  ctx.fillStyle = C.header;
  ctx.fillRect(0, 0, f.frozenLeft, f.headerH);
  ctx.font = FONT_BOLD;
  const rowsLabel = d.config.rows.join(" › ");
  const rowsEnd = PAD + ctx.measureText(rowsLabel).width;
  // column field names, one per header level, right-aligned
  ctx.textAlign = "right";
  ctx.fillStyle = C.muted;
  const last = d.config.cols.length - 1;
  d.config.cols.forEach((name, l) => {
    const text = `${name} →`;
    if (l === last && f.frozenLeft - PAD - ctx.measureText(text).width < rowsEnd + 12) return;
    ctx.fillText(text, f.frozenLeft - PAD, l * HEADER_ROW_H + HEADER_ROW_H / 2 + f.tn);
  });
  ctx.textAlign = "left";
  const byLabel = f.sort?.by === "label" ? f.sort : null;
  ctx.fillStyle = byLabel ? C.accent : C.headerText;
  ctx.fillText(rowsLabel, PAD, f.headerH - HEADER_ROW_H / 2 + f.tn);
  if (byLabel) drawSortArrow(ctx, rowsEnd + 10, f.headerH - HEADER_ROW_H / 2, byLabel.dir);
  ctx.restore();
}

/** Lines between the frozen parts (tree column, header, totals row) and the body. */
function paintSeparators(f: PivotFrame) {
  const { ctx } = f;
  ctx.strokeStyle = C.strong;
  ctx.beginPath();
  ctx.moveTo(f.frozenLeft - 0.5, 0);
  ctx.lineTo(f.frozenLeft - 0.5, f.vh);
  ctx.moveTo(0, f.bodyTop - 0.5);
  ctx.lineTo(f.vw, f.bodyTop - 0.5);
  ctx.moveTo(0, f.bodyBottom + 0.5);
  ctx.lineTo(f.vw, f.bodyBottom + 0.5);
  ctx.stroke();
}

/**
 * 1 px outlines for the linked (hovered elsewhere) and the selected cell, drawn
 * exactly on the cell's own grid lines, so every side is the same crisp 1 px.
 */
function paintOutlines(f: PivotFrame) {
  const { ctx } = f;
  const linked = f.linked;
  if (linked && linked.row >= f.firstRow && linked.row < f.firstRow + f.visRows) {
    const x0 = Math.round(f.colX(linked.col)) - 0.5;
    const x1 = Math.round(f.colX(linked.col) + f.colW) - 0.5;
    const y0 = Math.round(f.rowY(linked.row)) - 0.5;
    const y1 = Math.round(f.rowY(linked.row) + ROW_H) - 0.5;
    ctx.strokeStyle = C.ringOuter;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
  const sel = f.selection;
  if (sel) {
    // one 1 px frame around the whole block (the clip keeps it inside the body)
    const x0 = Math.round(f.colX(sel.c0)) - 0.5;
    const x1 = Math.round(f.colX(sel.c1) + f.colW) - 0.5;
    const y0 = Math.round(f.rowY(sel.r0)) - 0.5;
    const y1 = Math.round(f.rowY(sel.r1) + ROW_H) - 0.5;
    // dark line on the cell edges plus a light one just inside, so the block
    // reads on any heat colour (a single accent line got lost on blue cells)
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.ringOuter;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = C.ringInner;
    ctx.strokeRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2);
  }
}

/** True if any label at levels 0..level differs from the previous index. */
function groupChanged(labels: string[][], level: number, i: number): boolean {
  for (let l = 0; l <= level; l++) {
    const arr = labels[l]!;
    if (arr[i] !== arr[i - 1]) return true;
  }
  return false;
}
