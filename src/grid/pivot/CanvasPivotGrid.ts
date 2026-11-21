import { cellValue, type DisplayRows, type RowSort, rowPath } from "../../engine/pivot/display";
import type { PivotResult } from "../../engine/pivot/pivot";
import { fmt } from "../../lib/format";
import { GRID } from "../../theme/theme";
import { BAR_H, drawBottomBar, scrollPercent } from "../core/bottomBar";
import { CanvasGridBase } from "../core/CanvasGridBase";
import { snap, textNudge } from "../core/canvasText";
import { FONT, FONT_BOLD, PAD, ROW_H } from "../core/gridStyle";
import { SB_SIZE, type Tracks } from "../core/scrollbars";
import { DragSelect } from "./dragSelect";
import { CARET_W, type CellRange, HEADER_ROW_H, INDENT, paintPivot } from "./pivotPaint";

export type { CellRange } from "./pivotPaint";

/**
 * Framework-free, kasouka-style virtualized pivot grid (canvas recipe: see
 * CanvasGridBase; painting: pivotPaint.ts; drag-selection: dragSelect.ts).
 *
 * Frozen tree column (row groups with expand/collapse), multi-level merged
 * column headers, frozen grand-total row. The totals column scrolls with data.
 */

export interface GridViewport {
  firstRow: number; // display row
  rowCount: number;
  firstCol: number;
  colCount: number;
}

export interface GridHover {
  row: number; // display row, -1 = grand-total row
  col: number; // colCount = totals column
  value: number;
  rowPath: string[];
  colPath: string[];
}

type SortTarget = { by: "label" } | { by: "value"; col: number };

export interface GridOptions {
  /** Cells selected by click / drag / shift-click (null = cleared). */
  onSelect?: (range: CellRange | null) => void;
  onViewport?: (vp: GridViewport) => void;
  onHover?: (h: GridHover | null) => void;
  /** Group row (level, index) caret clicked. */
  onToggle?: (level: number, index: number) => void;
  /** Header clicked: the row-label header (corner) or a value column (colCount = Total). */
  onSort?: (target: SortTarget) => void;
}

export class CanvasPivotGrid extends CanvasGridBase {
  private data: PivotResult | null = null;
  private rows: DisplayRows | null = null;
  private heatmap = true;
  private opts: GridOptions;

  // layout
  private frozenLeft = 0;
  private colW = 100;
  private headerH = HEADER_ROW_H;
  private footerH = ROW_H;
  private bottomH = BAR_H; // kasouka-style scroll bar under the totals row

  // interaction
  private hover: { row: number; col: number } | null = null;
  private select: DragSelect;
  /** Current row order, for the header arrows. */
  private sort: RowSort | null = null;
  /** Cell hovered elsewhere (the 3D bars) or here: drawn with an outline. */
  private linked: { row: number; col: number } | null = null;
  private lastVp = "";

  constructor(host: HTMLElement, opts: GridOptions = {}) {
    super(host);
    this.opts = opts;
    this.scroller.addEventListener("mousemove", this.onMove, { passive: true });
    this.scroller.addEventListener("mouseleave", this.onLeave, { passive: true });
    this.scroller.addEventListener("click", this.onClick);
    this.select = new DragSelect({
      scroller: this.scroller,
      cellAt: (e) => {
        if (this.bars.pointer(e)) return null; // scrollbars take their own presses
        const h = this.hitTest(e);
        return h && h.row >= 0 && h.col >= 0 ? { row: h.row, col: h.col } : null;
      },
      cellAtClamped: (x, y) => this.cellAtClamped(x, y),
      body: () => ({ left: this.frozenLeft, top: this.headerH, right: this.vw, bottom: this.bodyBottom() }),
      changed: (range) => {
        this.invalidate();
        this.opts.onSelect?.(range);
      },
    });
    this.start([FONT, FONT_BOLD]);
  }

  override destroy() {
    this.select.destroy();
    super.destroy();
  }

  /**
   * New data and/or new visible rows. `resetScroll` is true for a new query and
   * false for expand/collapse, so toggling a group keeps your place.
   */
  setData(data: PivotResult | null, rows: DisplayRows | null, resetScroll: boolean) {
    const top = this.scroller.scrollTop;
    this.data = data;
    this.rows = rows;
    this.hover = null;
    // Row indices change with any new data, order or open groups.
    this.setSelection(null, true);
    this.measure(resetScroll);
    if (resetScroll) {
      this.scroller.scrollTop = 0;
      this.scroller.scrollLeft = 0;
    } else this.scroller.scrollTop = top;
    this.invalidate();
  }

  /**
   * Scroll so `row` is the first body row and, if given, `col` the first value
   * column. Used when the 3D view drives the table.
   */
  scrollTo(row: number, col?: number) {
    // +half a pixel so rounding the DOM position never lands on the row above
    this.scrollToVirtualY(Math.max(0, row) * ROW_H + 0.5);
    if (col != null) this.scroller.scrollLeft = Math.max(0, col) * this.colW;
  }

  /** Set or clear the selection from outside (e.g. a Clear button). */
  setSelection(range: CellRange | null, emit = false) {
    const had = this.select.range() !== null;
    this.select.set(range);
    this.invalidate();
    if (emit && (had || range)) this.opts.onSelect?.(range);
  }

  setSort(sort: RowSort | null) {
    this.sort = sort;
    this.invalidate();
  }

  setLinked(cell: { row: number; col: number } | null) {
    if (cell?.row === this.linked?.row && cell?.col === this.linked?.col) return;
    this.linked = cell;
    this.invalidate();
  }

  setHeatmap(on: boolean) {
    this.heatmap = on;
    this.invalidate();
  }

  // ---------------------------------------------------------------- layout

  /** Widths from a sample of labels/values: O(sample), not O(rows). */
  protected measure(remeasureWidths: boolean) {
    const d = this.data;
    const rows = this.rows;
    const ctx = this.ctx;
    if (!d || !rows) {
      this.frozenLeft = 0;
      this.setContentSize(0, 0);
      return;
    }
    if (remeasureWidths || this.frozenLeft === 0) {
      // Tree column: widest (indent + caret + label) over a sample of every level.
      ctx.font = FONT_BOLD;
      let tw = ctx.measureText(d.config.rows.join(" › ")).width + PAD * 2;
      d.levels.forEach((lv, k) => {
        const own = lv.labels[k]!;
        const n = own.length;
        const idx = n <= 1500 ? own.keys() : sampleIdx(n);
        ctx.font = k < d.levels.length - 1 ? FONT_BOLD : FONT;
        for (const i of idx) tw = Math.max(tw, k * INDENT + CARET_W + ctx.measureText(own[i]!).width + PAD * 2);
      });
      this.frozenLeft = Math.min(Math.max(140, Math.ceil(tw)), Math.max(200, this.vw * 0.45));

      ctx.font = FONT_BOLD;
      let cw = ctx.measureText(fmt(d.grandTotal)).width;
      for (const lv of d.levels) for (const v of [lv.min, lv.max]) cw = Math.max(cw, ctx.measureText(fmt(v)).width);
      ctx.font = FONT;
      for (const c of d.colCount <= 1500 ? Array.from({ length: d.colCount }, (_, i) => i) : sampleIdx(d.colCount)) {
        cw = Math.max(cw, ctx.measureText(fmt(d.colTotals[c] ?? NaN)).width);
        for (const labels of d.colLabels) cw = Math.max(cw, ctx.measureText(labels[c] ?? "").width * 0.8);
      }
      this.colW = Math.min(180, Math.max(72, Math.ceil(cw) + PAD * 2));
    }

    this.headerH = Math.max(1, d.colLabels.length) * HEADER_ROW_H;
    this.setContentSize(
      this.frozenLeft + (d.colCount + 1) * this.colW,
      this.headerH + rows.count * ROW_H + this.footerH + this.bottomH,
    );
  }

  /** Bottom edge of the scrollable body (the totals row and bottom bar sit below). */
  private bodyBottom(): number {
    return this.vh - this.bottomH - this.footerH;
  }

  // ---------------------------------------------------------------- hit testing

  /** col = -1 means the tree column; row = -1 the grand-total row. */
  private hitTest(e: MouseEvent): { row: number; col: number; x: number } | null {
    const d = this.data;
    const rows = this.rows;
    if (!d || !rows) return null;
    const rect = this.scroller.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < this.headerH || x > this.vw || y > this.vh) return null;
    const col = x < this.frozenLeft ? -1 : Math.floor((x - this.frozenLeft + this.scroller.scrollLeft) / this.colW);
    if (col > d.colCount) return null;
    if (y >= this.vh - this.bottomH) return null;
    if (y >= this.bodyBottom()) return { row: -1, col, x };
    const row = Math.floor((y - this.headerH + this.virtualY()) / ROW_H);
    if (row < 0 || row >= rows.count) return null;
    return { row, col, x };
  }

  /** Cell under a client point, clamped into the body (for drags past the edge). */
  private cellAtClamped(clientX: number, clientY: number): { row: number; col: number } | null {
    const d = this.data;
    const rows = this.rows;
    if (!d || !rows || rows.count === 0) return null;
    const rect = this.scroller.getBoundingClientRect();
    const x = Math.min(this.vw - 1, Math.max(this.frozenLeft, clientX - rect.left));
    const y = Math.min(this.bodyBottom() - 1, Math.max(this.headerH, clientY - rect.top));
    const row = Math.floor((y - this.headerH + this.virtualY()) / ROW_H);
    const col = Math.floor((x - this.frozenLeft + this.scroller.scrollLeft) / this.colW);
    return { row: Math.min(rows.count - 1, Math.max(0, row)), col: Math.min(d.colCount, Math.max(0, col)) };
  }

  /** Sortable header under the pointer: the row-label corner, a leaf column or Total. */
  private headerTarget(e: MouseEvent): SortTarget | null {
    const d = this.data;
    if (!d) return null;
    const rect = this.scroller.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < 0 || y >= this.headerH) return null;
    if (x < this.frozenLeft) return { by: "label" };
    const col = Math.floor((x - this.frozenLeft + this.scroller.scrollLeft) / this.colW);
    if (col === d.colCount) return { by: "value", col }; // Total spans all header rows
    // value columns: only the leaf header row (outer rows are merged groups)
    if (col < d.colCount && y >= this.headerH - HEADER_ROW_H) return { by: "value", col };
    return null;
  }

  /** Scrollable body: below the headers, above the totals row; not over the tree column. */
  protected scrollTracks(): Tracks {
    const d = this.data;
    const rows = this.rows;
    if (!d || !rows) return { v: null, h: null };
    const top = this.headerH;
    const bottom = this.bodyBottom();
    const bodyH = Math.max(0, bottom - top);
    const bodyW = Math.max(0, this.vw - this.frozenLeft);
    const vRatio = bodyH / Math.max(1, rows.count * ROW_H);
    const hRatio = bodyW / Math.max(1, (d.colCount + 1) * this.colW);
    const hasV = vRatio < 1;
    const hasH = hRatio < 1;
    return {
      v: { x: this.vw - SB_SIZE, y: top, w: SB_SIZE, h: bodyH - (hasH ? SB_SIZE : 0), ratio: vRatio },
      h: { x: this.frozenLeft, y: bottom - SB_SIZE, w: bodyW - (hasV ? SB_SIZE : 0), h: SB_SIZE, ratio: hRatio },
    };
  }

  private isGroupRow(r: number): boolean {
    return this.rows!.level[r]! < this.data!.levels.length - 1;
  }

  // ---------------------------------------------------------------- events

  private onMove = (e: MouseEvent) => {
    if (this.bars.pointer(e)) {
      this.scroller.style.cursor = "default";
      if (this.hover) this.onLeave();
      return;
    }
    const h = this.hitTest(e);
    const isGroup = !!h && h.col === -1 && h.row >= 0 && this.isGroupRow(h.row);
    this.scroller.style.cursor = isGroup || this.headerTarget(e) ? "pointer" : "default";
    const cell = h && h.col >= 0 ? { row: h.row, col: h.col } : null;
    if (cell?.row === this.hover?.row && cell?.col === this.hover?.col) return;
    this.hover = cell;
    this.invalidate();
    this.emitHover();
  };

  private onLeave = () => {
    this.bars.leave();
    this.hover = null;
    this.invalidate();
    this.emitHover();
  };

  private onClick = (e: MouseEvent) => {
    if (this.bars.consumeClick()) return;
    // the click ending a cell press or drag (it may land outside the body)
    if (this.select.consumePress()) return;
    const target = this.headerTarget(e);
    if (target) {
      this.opts.onSort?.(target);
      return;
    }
    const h = this.hitTest(e);
    if (h && h.col === -1 && h.row >= 0 && this.isGroupRow(h.row)) {
      const rows = this.rows!;
      this.opts.onToggle?.(rows.level[h.row]!, rows.index[h.row]!);
      return;
    }
    // cells are selected on pointerdown (see DragSelect); a click elsewhere clears
    if (!h || h.row < 0 || h.col < 0) this.setSelection(null, true);
  };

  private emitHover() {
    const d = this.data;
    const rows = this.rows;
    const h = this.hover;
    if (!this.opts.onHover) return;
    if (!d || !rows || !h) return this.opts.onHover(null);
    this.opts.onHover({
      row: h.row,
      col: h.col,
      value: this.valueAt(h.row, h.col),
      rowPath: h.row < 0 ? ["Grand total"] : rowPath(d, rows, h.row),
      colPath: h.col >= d.colCount ? ["Total"] : d.colLabels.map((l) => l[h.col] ?? ""),
    });
  }

  private valueAt(row: number, col: number): number {
    const d = this.data!;
    if (row < 0) return col >= d.colCount ? d.grandTotal : d.colTotals[col]!;
    return cellValue(d, this.rows!, row, col);
  }

  // ---------------------------------------------------------------- drawing

  protected paint() {
    const ctx = this.ctx;
    const { vw, vh } = this;
    ctx.fillStyle = GRID.bg;
    ctx.fillRect(0, 0, vw, vh);
    const d = this.data;
    const rows = this.rows;
    if (!d || !rows) return;

    const sx = snap(this.scroller.scrollLeft, this.dpr);
    const vy = this.virtualY();
    const bodyTop = this.headerH;
    const bodyBottom = this.bodyBottom();
    const bodyH = Math.max(0, bodyBottom - bodyTop);

    const firstRow = Math.max(0, Math.floor(vy / ROW_H));
    const rowOffset = vy - firstRow * ROW_H;
    const visRows = Math.max(0, Math.min(rows.count - firstRow, Math.ceil((bodyH + rowOffset) / ROW_H) + 1));

    const totalCols = d.colCount + 1; // + totals column
    const firstCol = Math.max(0, Math.floor(sx / this.colW));
    const colOffset = sx - firstCol * this.colW;
    const visCols = Math.max(
      0,
      Math.min(totalCols - firstCol, Math.ceil((vw - this.frozenLeft + colOffset) / this.colW) + 1),
    );

    paintPivot({
      ctx,
      data: d,
      rows,
      vw,
      vh,
      frozenLeft: this.frozenLeft,
      colW: this.colW,
      headerH: this.headerH,
      footerH: this.footerH,
      tn: textNudge(ctx, FONT),
      firstRow,
      visRows,
      firstCol,
      visCols,
      bodyTop,
      bodyBottom,
      bodyH,
      colX: (c) => this.frozenLeft + (c - firstCol) * this.colW - colOffset,
      rowY: (r) => bodyTop + (r - firstRow) * ROW_H - rowOffset,
      heatmap: this.heatmap,
      hover: this.hover,
      linked: this.linked,
      selection: this.select.range(),
      sort: this.sort,
    });

    this.bars.draw(ctx);

    const lastRow = Math.min(rows.count, firstRow + Math.max(0, Math.floor((bodyH + rowOffset) / ROW_H)));
    drawBottomBar(
      ctx,
      vw,
      vh,
      scrollPercent(this.scroller),
      `${rows.count.toLocaleString()} rows × ${d.colCount.toLocaleString()} cols`,
      rows.count ? `rows ${(firstRow + 1).toLocaleString()}–${lastRow.toLocaleString()}` : "",
    );

    const key = `${firstRow}:${visRows}:${firstCol}:${visCols}:${rows.count}`;
    if (key !== this.lastVp) {
      this.lastVp = key;
      this.opts.onViewport?.({ firstRow, rowCount: visRows, firstCol, colCount: visCols });
    }
  }
}

/** Indices to measure on a long list: the first 1000, the last 200, and ~300 spread between. */
function sampleIdx(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(1000, n); i++) out.push(i);
  for (let i = Math.max(1000, n - 200); i < n; i++) out.push(i);
  const step = Math.max(1, Math.floor(n / 300));
  for (let i = 1000; i < n - 200; i += step) out.push(i);
  return out;
}
