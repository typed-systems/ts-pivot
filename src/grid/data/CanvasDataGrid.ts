import { BLOCK, type RawSource } from "../../engine/db/raw";
import { GRID } from "../../theme/theme";
import { BAR_H, drawBottomBar, scrollPercent } from "../core/bottomBar";
import { CanvasGridBase } from "../core/CanvasGridBase";
import { snap, textNudge } from "../core/canvasText";
import { ARROW_W, drawSortArrow, FONT, FONT_BOLD, PAD, ROW_H } from "../core/gridStyle";
import { SB_SIZE, type Tracks } from "../core/scrollbars";

/**
 * Raw-data table, same recipe as the pivot grid (see CanvasGridBase).
 * Cells come from a RawSource that pages blocks out of DuckDB on demand; cells
 * whose block is still loading draw as a light placeholder bar.
 * Click a header to sort (asc -> desc -> off).
 */

export interface DataGridOptions {
  onSort?: (column: string) => void;
}

const HEADER_H = 28;

// Colors come from the live theme object (light/dark), read on every draw.
const C = GRID;

export class CanvasDataGrid extends CanvasGridBase {
  private opts: DataGridOptions;
  private src: RawSource | null = null;
  private numW = 60; // row-number column
  private colX: number[] = [];
  private colW: number[] = [];
  private sampled = new Set<number>(); // blocks already used to widen columns
  private hoverRow = -1;
  private hoverHeader = -1;
  private tn = 1; // vertical text nudge, see canvasText.ts

  constructor(host: HTMLElement, opts: DataGridOptions = {}) {
    super(host);
    this.opts = opts;
    this.scroller.addEventListener("mousemove", this.onMove, { passive: true });
    this.scroller.addEventListener("mouseleave", () => {
      this.bars.leave();
      this.hoverRow = this.hoverHeader = -1;
      this.invalidate();
    });
    this.scroller.addEventListener("click", this.onClick);
    this.start([FONT]);
  }

  override destroy() {
    if (this.src) this.src.onBlock = null;
    super.destroy();
  }

  /** New source (new file/sample) -> remeasure and go to the top. */
  setSource(src: RawSource | null, resetScroll: boolean) {
    if (this.src && this.src !== src) this.src.onBlock = null;
    this.src = src;
    if (src) src.onBlock = () => this.invalidate();
    this.sampled.clear();
    this.measure(true);
    if (resetScroll) {
      this.scroller.scrollTop = 0;
      this.scroller.scrollLeft = 0;
    }
    this.invalidate();
  }

  // ---------------------------------------------------------------- layout

  protected measure(fromHeaders: boolean) {
    const src = this.src;
    const ctx = this.ctx;
    if (!src) {
      this.colX = [];
      this.colW = [];
      this.setContentSize(0, 0);
      return;
    }
    if (fromHeaders || this.colW.length !== src.fields.length) {
      ctx.font = FONT;
      this.numW = Math.max(56, Math.ceil(ctx.measureText(String(src.rowCount)).width) + PAD * 2);
      ctx.font = FONT_BOLD;
      // header text + room for the sort arrow
      this.colW = src.fields.map((f) =>
        Math.min(320, Math.max(80, Math.ceil(ctx.measureText(f.name).width) + PAD * 2 + ARROW_W)),
      );
    }
    this.setContentSize(this.layoutColumns(), HEADER_H + src.rowCount * ROW_H + BAR_H);
  }

  /** Column x positions from the widths; returns the total width. */
  private layoutColumns(): number {
    let x = this.numW;
    this.colX = this.colW.map((w) => {
      const at = x;
      x += w;
      return at;
    });
    return x;
  }

  // ---------------------------------------------------------------- events

  private colAt(x: number): number {
    const cx = x + this.scroller.scrollLeft;
    if (x < this.numW) return -1;
    for (let c = 0; c < this.colX.length; c++) if (cx >= this.colX[c]! && cx < this.colX[c]! + this.colW[c]!) return c;
    return -1;
  }

  /** Scrollable body: between the header and the bottom bar, right of the row numbers. */
  protected scrollTracks(): Tracks {
    if (!this.src) return { v: null, h: null };
    const top = HEADER_H;
    const bottom = this.vh - BAR_H;
    const bodyH = Math.max(0, bottom - top);
    const bodyW = Math.max(0, this.vw - this.numW);
    const vRatio = bodyH / Math.max(1, this.src.rowCount * ROW_H);
    const hRatio = bodyW / Math.max(1, this.contentW - this.numW);
    const hasV = vRatio < 1;
    const hasH = hRatio < 1;
    return {
      v: { x: this.vw - SB_SIZE, y: top, w: SB_SIZE, h: bodyH - (hasH ? SB_SIZE : 0), ratio: vRatio },
      h: { x: this.numW, y: bottom - SB_SIZE, w: bodyW - (hasV ? SB_SIZE : 0), h: SB_SIZE, ratio: hRatio },
    };
  }

  private onMove = (e: MouseEvent) => {
    if (this.bars.pointer(e)) {
      this.scroller.style.cursor = "default";
      if (this.hoverRow >= 0 || this.hoverHeader >= 0) {
        this.hoverRow = this.hoverHeader = -1;
        this.invalidate();
      }
      return;
    }
    const r = this.scroller.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const header = y < HEADER_H ? this.colAt(x) : -1;
    const row = y >= HEADER_H && y < this.vh - BAR_H ? Math.floor((y - HEADER_H + this.virtualY()) / ROW_H) : -1;
    this.scroller.style.cursor = header >= 0 ? "pointer" : "default";
    if (header !== this.hoverHeader || row !== this.hoverRow) {
      this.hoverHeader = header;
      this.hoverRow = row;
      this.invalidate();
    }
  };

  private onClick = (e: MouseEvent) => {
    if (this.bars.consumeClick()) return;
    const r = this.scroller.getBoundingClientRect();
    if (e.clientY - r.top >= HEADER_H) return;
    const c = this.colAt(e.clientX - r.left);
    if (c >= 0 && this.src) this.opts.onSort?.(this.src.fields[c]!.name);
  };

  // ---------------------------------------------------------------- drawing

  protected paint() {
    const ctx = this.ctx;
    const { vw, vh } = this;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, vw, vh);
    const src = this.src;
    if (!src) return;

    const sx = snap(this.scroller.scrollLeft, this.dpr);
    const vy = this.virtualY();
    this.tn = textNudge(ctx, FONT);
    const bodyH = vh - HEADER_H - BAR_H;
    const firstRow = Math.max(0, Math.floor(vy / ROW_H));
    const offset = vy - firstRow * ROW_H;
    const visRows = Math.max(0, Math.min(src.rowCount - firstRow, Math.ceil((bodyH + offset) / ROW_H) + 1));
    const rowY = (r: number) => HEADER_H + (r - firstRow) * ROW_H - offset;

    // visible columns
    let c0 = 0;
    while (c0 < this.colX.length && this.colX[c0]! + this.colW[c0]! - sx <= this.numW) c0++;
    let c1 = c0;
    while (c1 < this.colX.length && this.colX[c1]! - sx < vw) c1++;

    this.widenFromLoadedBlocks(src, firstRow, visRows);

    // ---- body
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEADER_H, vw, bodyH);
    ctx.clip();
    for (let i = 0; i < visRows; i++) {
      const r = firstRow + i;
      ctx.fillStyle = r === this.hoverRow ? C.hoverRow : r & 1 ? C.stripe : C.bg;
      ctx.fillRect(0, rowY(r), vw, ROW_H);
    }
    ctx.textBaseline = "middle";
    for (let c = c0; c < c1; c++) {
      const f = src.fields[c]!;
      const x = this.colX[c]! - sx;
      const w = this.colW[c]!;
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(x, this.numW), HEADER_H, w, bodyH);
      ctx.clip();
      ctx.textAlign = f.numeric ? "right" : "left";
      for (let i = 0; i < visRows; i++) {
        const r = firstRow + i;
        const y = rowY(r);
        const t = src.cell(r, c);
        if (t === undefined) {
          ctx.fillStyle = C.loading;
          ctx.fillRect(x + PAD, y + 8, Math.min(w - PAD * 2, 48), ROW_H - 16);
        } else {
          ctx.fillStyle = t === null ? C.nul : C.text;
          ctx.fillText(t ?? "null", f.numeric ? x + w - PAD : x + PAD, y + ROW_H / 2 + this.tn);
        }
      }
      ctx.restore();
    }
    // lines
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    for (let c = c0; c <= c1 && c <= this.colX.length; c++) {
      const xx = Math.round((c < this.colX.length ? this.colX[c]! : this.contentW) - sx) - 0.5;
      if (xx < this.numW) continue;
      ctx.moveTo(xx, HEADER_H);
      ctx.lineTo(xx, vh - BAR_H);
    }
    for (let i = 0; i <= visRows; i++) {
      const y = Math.round(rowY(firstRow + i)) - 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(Math.min(vw, this.contentW - sx), y);
    }
    ctx.stroke();

    // frozen row numbers
    ctx.fillStyle = C.header;
    ctx.fillRect(0, HEADER_H, this.numW, bodyH);
    ctx.fillStyle = C.muted;
    ctx.textAlign = "right";
    for (let i = 0; i < visRows; i++) {
      const r = firstRow + i;
      ctx.fillText(String(r + 1), this.numW - PAD, rowY(r) + ROW_H / 2 + this.tn);
    }
    ctx.restore();

    this.paintHeader(src, c0, c1, sx);
    this.bars.draw(ctx);

    const lastRow = Math.min(src.rowCount, firstRow + Math.max(0, Math.floor((bodyH + offset) / ROW_H)));
    drawBottomBar(
      ctx,
      vw,
      vh,
      scrollPercent(this.scroller),
      `${src.rowCount.toLocaleString()} rows`,
      src.rowCount ? `rows ${(firstRow + 1).toLocaleString()}–${lastRow.toLocaleString()}` : "",
    );
  }

  /** Widen columns (grow-only) from each newly loaded block, like kasouka. */
  private widenFromLoadedBlocks(src: RawSource, firstRow: number, visRows: number) {
    const ctx = this.ctx;
    let grew = false;
    ctx.font = FONT;
    for (let i = 0; i < visRows; i += 64) {
      const r = firstRow + i;
      const b = Math.floor(r / BLOCK);
      if (this.sampled.has(b) || src.cell(r, 0) === undefined) continue;
      this.sampled.add(b);
      for (let c = 0; c < src.fields.length; c++) {
        for (let k = r; k < Math.min(r + 64, src.rowCount); k++) {
          const t = src.cell(k, c);
          if (!t) continue;
          const w = Math.min(320, Math.ceil(ctx.measureText(t).width) + PAD * 2);
          if (w > this.colW[c]!) {
            this.colW[c] = w;
            grew = true;
          }
        }
      }
    }
    if (grew) this.setContentSize(this.layoutColumns(), this.contentH);
  }

  private paintHeader(src: RawSource, c0: number, c1: number, sx: number) {
    const ctx = this.ctx;
    const { vw, vh } = this;
    ctx.fillStyle = C.header;
    ctx.fillRect(0, 0, vw, HEADER_H);
    ctx.font = FONT_BOLD;
    const sort = src.currentSort;
    for (let c = c0; c < c1; c++) {
      const f = src.fields[c]!;
      const x = this.colX[c]! - sx;
      const w = this.colW[c]!;
      if (x + w <= this.numW) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(x, this.numW), 0, w, HEADER_H);
      ctx.clip();
      if (c === this.hoverHeader) {
        ctx.fillStyle = C.hover;
        ctx.fillRect(x, 0, w, HEADER_H);
      }
      const sorted = sort?.column === f.name;
      ctx.fillStyle = sorted ? C.accent : C.text;
      ctx.textAlign = f.numeric ? "right" : "left";
      ctx.fillText(f.name, f.numeric ? x + w - PAD - ARROW_W : x + PAD, HEADER_H / 2 + this.tn);
      if (sort && sorted)
        drawSortArrow(ctx, x + w - PAD - 5, HEADER_H / 2 + (sort.dir === "asc" ? -0.5 : 0.5), sort.dir);
      ctx.restore();
    }
    ctx.fillStyle = C.header;
    ctx.fillRect(0, 0, this.numW, HEADER_H);
    ctx.fillStyle = C.muted;
    ctx.textAlign = "right";
    ctx.fillText("#", this.numW - PAD, HEADER_H / 2 + this.tn);

    ctx.strokeStyle = C.strong;
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H - 0.5);
    ctx.lineTo(vw, HEADER_H - 0.5);
    ctx.moveTo(this.numW - 0.5, 0);
    ctx.lineTo(this.numW - 0.5, vh - BAR_H);
    for (let c = c0; c < c1; c++) {
      const xx = Math.round(this.colX[c]! + this.colW[c]! - sx) - 0.5;
      if (xx <= this.numW) continue;
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, HEADER_H);
    }
    ctx.stroke();
  }
}
