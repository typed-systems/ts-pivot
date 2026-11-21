import { snap } from "./canvasText";
import { Scrollbars, type Tracks } from "./scrollbars";

/** Browsers cap element sizes near 16M px; taller content is scaled onto this. */
const MAX_DOM_PX = 15_000_000;

/**
 * The canvas-grid recipe both grids share (after kasouka):
 *
 * - One <canvas> the size of the viewport, laid over (not inside) a scroller
 *   with a big spacer <div>. Scrolling is native (wheel, trackpad, keys); the
 *   scrollbars are drawn on the canvas (scrollbars.ts). The canvas is not sticky
 *   inside the scroller: a sticky element moves by fractional pixels while
 *   scrolling, which made frozen headers shimmer. Pointer events fall through.
 * - Content taller than browsers allow (~16M px) is handled by scaling the DOM
 *   scroll range onto the virtual range (`virtualY`).
 * - Redraws are coalesced into one requestAnimationFrame (`invalidate`).
 *
 * Subclasses lay out their content in `measure`, report it with `setContentSize`,
 * paint a frame in `paint`, and call `start()` at the end of their constructor.
 */
export abstract class CanvasGridBase {
  protected readonly scroller: HTMLDivElement;
  protected readonly ctx: CanvasRenderingContext2D;
  protected readonly bars: Scrollbars;
  private readonly spacer: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ro: ResizeObserver;

  protected dpr = 1;
  /** Viewport size in CSS px. */
  protected vw = 0;
  protected vh = 0;
  /** Full virtual content size in CSS px. */
  protected contentW = 0;
  protected contentH = 0;
  /** Spacer height actually given to the DOM (contentH capped at MAX_DOM_PX). */
  protected domH = 0;

  private raf = 0;
  private dirty = true;
  private destroyed = false;

  constructor(host: HTMLElement) {
    this.scroller = document.createElement("div");
    this.scroller.className = "pg-scroller"; // native bars hidden in CSS; ours are drawn (scrollbars.ts)
    Object.assign(this.scroller.style, { position: "absolute", inset: "0", overflow: "auto" });
    this.spacer = document.createElement("div");
    this.spacer.style.position = "relative";
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      display: "block",
      pointerEvents: "none",
    });
    this.scroller.appendChild(this.spacer);
    host.appendChild(this.scroller);
    host.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D not supported");
    this.ctx = ctx;

    this.scroller.addEventListener("scroll", () => this.invalidate(), { passive: true });
    this.bars = new Scrollbars(
      this.scroller,
      () => this.scrollTracks(),
      () => this.invalidate(),
    );
    this.ro = new ResizeObserver(() => this.resize());
  }

  /** Lay out the content (column widths, sizes); `full` re-measures from scratch. */
  protected abstract measure(full: boolean): void;
  /** Draw one frame; the canvas is already cleared and scaled to CSS px. */
  protected abstract paint(): void;
  /** Where the scrollbars go (the scrollable body). */
  protected abstract scrollTracks(): Tracks;

  /**
   * Size the canvas and start observing. Call last in the subclass constructor,
   * once its own fields exist (they are initialised after this base constructor).
   */
  protected start(fonts: string[]) {
    this.ro.observe(this.scroller);
    this.resize();
    // Canvas text can't reflow on its own: once the web font is ready, re-measure
    // and redraw (the first frames may use the fallback font).
    void Promise.all(fonts.map((f) => document.fonts.load(f))).then(() => {
      if (this.destroyed) return;
      this.measure(true);
      this.invalidate();
    });
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.bars.destroy();
    this.ro.disconnect();
    this.scroller.remove();
    this.canvas.remove();
  }

  invalidate() {
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  /** Set the virtual content size and size the spacer to match. */
  protected setContentSize(w: number, h: number) {
    this.contentW = w;
    this.contentH = h;
    this.domH = Math.min(h, MAX_DOM_PX);
    this.spacer.style.width = `${Math.max(w, 1)}px`;
    this.spacer.style.height = `${Math.max(this.domH, 1)}px`;
  }

  /** DOM scrollTop -> virtual pixel offset (handles >16M px content). */
  protected virtualY(): number {
    const virtMax = Math.max(0, this.contentH - this.vh);
    const domMax = Math.max(0, this.domH - this.vh);
    if (domMax <= 0) return 0;
    return snap(Math.min(virtMax, (this.scroller.scrollTop / domMax) * virtMax), this.dpr);
  }

  /** Virtual y offset -> DOM scrollTop (inverse of `virtualY`). */
  protected scrollToVirtualY(y: number) {
    const virtMax = Math.max(0, this.contentH - this.vh);
    const domMax = Math.max(0, this.domH - this.vh);
    this.scroller.scrollTop = virtMax > 0 ? (Math.min(virtMax, y) / virtMax) * domMax : 0;
  }

  private resize() {
    const w = this.scroller.clientWidth;
    const h = this.scroller.clientHeight;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === this.vw && h === this.vh && dpr === this.dpr) return;
    this.vw = w;
    this.vh = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.measure(false);
    this.invalidate();
  }

  private frame = () => {
    this.raf = 0;
    if (!this.dirty) return;
    this.dirty = false;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paint();
  };
}
