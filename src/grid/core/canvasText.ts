/**
 * Vertical text centring for canvas grids.
 *
 * With `textBaseline = "middle"` the em box is centred, not the visible glyphs,
 * so digits and capitals sit a little off. `textNudge` returns the offset that
 * puts the cap-height centre of the current font exactly on the given y.
 * Cached per font string; the cache is cleared when web fonts finish loading.
 */
const cache = new Map<string, number>();
if (typeof document !== "undefined") document.fonts?.addEventListener?.("loadingdone", () => cache.clear());

export function textNudge(ctx: CanvasRenderingContext2D, font: string): number {
  let n = cache.get(font);
  if (n === undefined) {
    ctx.save();
    ctx.font = font;
    ctx.textBaseline = "middle";
    const m = ctx.measureText("H0");
    ctx.restore();
    // glyph spans [-ascent, +descent] around the middle line; shift its centre to 0
    n = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    cache.set(font, n);
  }
  return n;
}

/** Snap a CSS-pixel offset to whole device pixels, so content never sits on a half pixel. */
export function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}
