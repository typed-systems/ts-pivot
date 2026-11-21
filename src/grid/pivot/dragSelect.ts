import type { CellRange } from "./pivotPaint";

type Cell = { row: number; col: number };

/** What drag-selection needs to know about the grid it runs in. */
export interface DragSelectHost {
  readonly scroller: HTMLElement;
  /** Body cell under the pointer, or null (headers, tree column, totals row, scrollbars, outside). */
  cellAt(e: MouseEvent): Cell | null;
  /** Body cell under a client point, clamped into the body (for drags past an edge). */
  cellAtClamped(clientX: number, clientY: number): Cell | null;
  /** Scrollable body, in CSS px relative to the scroller. */
  body(): { left: number; top: number; right: number; bottom: number };
  /** The selection changed through the pointer. */
  changed(range: CellRange | null): void;
}

/**
 * Cell selection by press, drag and shift-press, with auto-scroll while the
 * pointer is past an edge of the body. Kept as anchor (where the drag started)
 * and focus (where it is now).
 */
export class DragSelect {
  private sel: { ar: number; ac: number; fr: number; fc: number } | null = null;
  private drag: { id: number; x: number; y: number; raf: number } | null = null;
  /** The last press started a selection, so the click that follows must not clear it. */
  private pressed = false;

  constructor(private host: DragSelectHost) {
    const s = host.scroller;
    s.addEventListener("pointerdown", this.onDown);
    s.addEventListener("pointermove", this.onMove);
    s.addEventListener("pointerup", this.onUp);
    s.addEventListener("pointercancel", this.onUp);
  }

  destroy() {
    this.stopDrag();
    const s = this.host.scroller;
    s.removeEventListener("pointerdown", this.onDown);
    s.removeEventListener("pointermove", this.onMove);
    s.removeEventListener("pointerup", this.onUp);
    s.removeEventListener("pointercancel", this.onUp);
  }

  /** The selected block, normalised (r0 <= r1, c0 <= c1). */
  range(): CellRange | null {
    const s = this.sel;
    if (!s) return null;
    return {
      r0: Math.min(s.ar, s.fr),
      r1: Math.max(s.ar, s.fr),
      c0: Math.min(s.ac, s.fc),
      c1: Math.max(s.ac, s.fc),
    };
  }

  /** Replace the selection from outside; ends any drag. Doesn't call `changed`. */
  set(range: CellRange | null) {
    this.sel = range ? { ar: range.r0, ac: range.c0, fr: range.r1, fc: range.c1 } : null;
    this.stopDrag();
  }

  /** True once after a press that selected cells: the click ending it isn't a "click elsewhere". */
  consumePress(): boolean {
    const p = this.pressed;
    this.pressed = false;
    return p;
  }

  private stopDrag() {
    if (!this.drag) return;
    cancelAnimationFrame(this.drag.raf);
    this.drag = null;
  }

  private onDown = (e: PointerEvent) => {
    this.pressed = false;
    if (e.button !== 0) return;
    const h = this.host.cellAt(e);
    if (!h) return;
    e.preventDefault(); // no text selection while dragging
    this.pressed = true;
    if (e.shiftKey && this.sel) this.sel = { ...this.sel, fr: h.row, fc: h.col };
    else this.sel = { ar: h.row, ac: h.col, fr: h.row, fc: h.col };
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, raf: 0 };
    this.host.scroller.setPointerCapture(e.pointerId);
    this.host.changed(this.range());
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    d.x = e.clientX;
    d.y = e.clientY;
    this.extendTo(d.x, d.y);
    if (!d.raf) d.raf = requestAnimationFrame(this.autoScroll);
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.stopDrag();
    const s = this.host.scroller;
    if (s.hasPointerCapture(e.pointerId)) s.releasePointerCapture(e.pointerId);
  };

  private extendTo(clientX: number, clientY: number) {
    const s = this.sel;
    const c = this.host.cellAtClamped(clientX, clientY);
    if (!s || !c || (c.row === s.fr && c.col === s.fc)) return;
    this.sel = { ...s, fr: c.row, fc: c.col };
    this.host.changed(this.range());
  }

  /** While dragging past an edge of the body, keep scrolling that way. */
  private autoScroll = () => {
    const d = this.drag;
    if (!d) return;
    d.raf = 0;
    const s = this.host.scroller;
    const rect = s.getBoundingClientRect();
    const y = d.y - rect.top;
    const x = d.x - rect.left;
    const b = this.host.body();
    const dy = y < b.top ? y - b.top : y > b.bottom ? y - b.bottom : 0;
    const dx = x < b.left ? x - b.left : x > b.right ? x - b.right : 0;
    if (!dx && !dy) return;
    s.scrollTop += Math.sign(dy) * Math.min(60, Math.abs(dy) / 2 + 4) * (dy ? 1 : 0);
    s.scrollLeft += Math.sign(dx) * Math.min(60, Math.abs(dx) / 2 + 4) * (dx ? 1 : 0);
    this.extendTo(d.x, d.y);
    d.raf = requestAnimationFrame(this.autoScroll);
  };
}
