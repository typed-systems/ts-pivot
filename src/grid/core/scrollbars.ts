import { GRID } from "../../theme/theme";

/**
 * Scrollbars drawn into the grid canvas.
 *
 * Scrolling itself stays native (wheel, trackpad inertia, keyboard, the >16M px
 * scaling all keep working through the hidden scroller); only the bars are
 * ours. Native bars can't be used as-is: macOS overlay scrollbars end up under
 * the overlay canvas, and native bars would run the full height, across the
 * frozen header, totals row and bottom bar. These sit exactly on the scrollable
 * body, follow the theme, and look the same on every OS.
 *
 * The grid supplies the track rectangles (body area) and the visible fraction;
 * positions come straight from the scroller, so they always match.
 */
export interface Track {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Visible share of the content along this axis (0..1). */
  ratio: number;
}

export interface Tracks {
  v: Track | null;
  h: Track | null;
}

/** Hit area / track thickness in CSS px. */
export const SB_SIZE = 12;
const MIN_THUMB = 28;
const THIN = 6;
const WIDE = 8;

type Axis = "v" | "h";

export class Scrollbars {
  private hover: Axis | null = null;
  private drag: { axis: Axis; start: number; pos0: number; id: number } | null = null;
  private justDragged = false;

  constructor(
    private scroller: HTMLElement,
    private tracks: () => Tracks,
    private invalidate: () => void,
  ) {
    scroller.addEventListener("pointerdown", this.onDown);
    scroller.addEventListener("pointermove", this.onDragMove);
    scroller.addEventListener("pointerup", this.onUp);
    scroller.addEventListener("pointercancel", this.onUp);
  }

  destroy() {
    this.scroller.removeEventListener("pointerdown", this.onDown);
    this.scroller.removeEventListener("pointermove", this.onDragMove);
    this.scroller.removeEventListener("pointerup", this.onUp);
    this.scroller.removeEventListener("pointercancel", this.onUp);
  }

  /** Scroller-relative point. */
  private local(e: MouseEvent) {
    const r = this.scroller.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private visible(axis: Axis): Track | null {
    const t = this.tracks()[axis];
    return t && t.ratio < 1 && t.w > 0 && t.h > 0 ? t : null;
  }

  private hitAxis(x: number, y: number): Axis | null {
    for (const axis of ["v", "h"] as const) {
      const t = this.visible(axis);
      if (t && x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) return axis;
    }
    return null;
  }

  /** 0..1 scroll position along an axis. */
  private pos(axis: Axis): number {
    const s = this.scroller;
    const max = axis === "v" ? s.scrollHeight - s.clientHeight : s.scrollWidth - s.clientWidth;
    if (max <= 0) return 0;
    return Math.min(1, Math.max(0, (axis === "v" ? s.scrollTop : s.scrollLeft) / max));
  }

  private setPos(axis: Axis, p: number) {
    const s = this.scroller;
    const q = Math.min(1, Math.max(0, p));
    if (axis === "v") s.scrollTop = q * (s.scrollHeight - s.clientHeight);
    else s.scrollLeft = q * (s.scrollWidth - s.clientWidth);
  }

  /** Thumb start and length along the track. */
  private thumb(axis: Axis, t: Track) {
    const len = axis === "v" ? t.h : t.w;
    const size = Math.min(len, Math.max(MIN_THUMB, len * t.ratio));
    return { start: this.pos(axis) * (len - size), size, len };
  }

  /**
   * Call from the grid's mousemove. Returns true when the pointer is on a bar
   * (or dragging one), so the grid should drop its own cell hover.
   */
  pointer(e: MouseEvent): boolean {
    if (this.drag) return true;
    const { x, y } = this.local(e);
    const axis = this.hitAxis(x, y);
    if (axis !== this.hover) {
      this.hover = axis;
      this.invalidate();
    }
    return axis !== null;
  }

  leave() {
    if (this.hover && !this.drag) {
      this.hover = null;
      this.invalidate();
    }
  }

  /** True once after a press on a bar, so the grid's click handler ignores it. */
  consumeClick(): boolean {
    const v = this.justDragged;
    this.justDragged = false;
    return v;
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = this.local(e);
    const axis = this.hitAxis(x, y);
    this.justDragged = false;
    if (!axis) return;
    const t = this.visible(axis)!;
    e.preventDefault(); // no text selection / focus moves
    const along = axis === "v" ? y - t.y : x - t.x;
    const th = this.thumb(axis, t);
    if (along < th.start || along > th.start + th.size) {
      // Track click: jump so the thumb centres on the pointer, then keep dragging.
      this.setPos(axis, (along - th.size / 2) / Math.max(1, th.len - th.size));
    }
    this.drag = { axis, start: axis === "v" ? e.clientY : e.clientX, pos0: this.pos(axis), id: e.pointerId };
    this.justDragged = true;
    this.scroller.setPointerCapture(e.pointerId);
    this.invalidate();
  };

  private onDragMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const t = this.visible(d.axis);
    if (!t) return;
    const th = this.thumb(d.axis, t);
    const delta = (d.axis === "v" ? e.clientY : e.clientX) - d.start;
    this.setPos(d.axis, d.pos0 + delta / Math.max(1, th.len - th.size));
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (this.scroller.hasPointerCapture(e.pointerId)) this.scroller.releasePointerCapture(e.pointerId);
    const { x, y } = this.local(e);
    this.hover = this.hitAxis(x, y);
    this.invalidate();
  };

  /** Draw both bars; call last in the grid's frame. */
  draw(ctx: CanvasRenderingContext2D) {
    for (const axis of ["v", "h"] as const) {
      const t = this.visible(axis);
      if (!t) continue;
      const active = this.drag?.axis === axis || this.hover === axis;
      const th = this.thumb(axis, t);
      const thick = active ? WIDE : THIN;
      ctx.save();
      if (active) {
        // faint track while hovered or dragged
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = GRID.header;
        ctx.fillRect(t.x, t.y, t.w, t.h);
      }
      ctx.globalAlpha = this.drag?.axis === axis ? 0.75 : active ? 0.6 : 0.4;
      ctx.fillStyle = GRID.muted;
      ctx.beginPath();
      if (axis === "v") {
        const x = t.x + t.w - thick - 2;
        ctx.roundRect(x, t.y + th.start + 2, thick, Math.max(0, th.size - 4), thick / 2);
      } else {
        const y = t.y + t.h - thick - 2;
        ctx.roundRect(t.x + th.start + 2, y, Math.max(0, th.size - 4), thick, thick / 2);
      }
      ctx.fill();
      ctx.restore();
    }
  }
}
