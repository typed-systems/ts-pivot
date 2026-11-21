/** Fonts and spacing shared by the canvas grids (Geist Mono, as in kasouka; loaded in main.tsx). */
export const FAMILY = `"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
// Regular 400, bold 500 (one step lighter than the usual 600).
export const FONT = `400 12px ${FAMILY}`;
export const FONT_BOLD = `500 12px ${FAMILY}`;
export const ROW_H = 24;
export const PAD = 8;
/** Room a header keeps free for its sort arrow. */
export const ARROW_W = 14;

/** Small filled sort triangle centred at (x, y); fill style must already be set. */
export function drawSortArrow(ctx: CanvasRenderingContext2D, x: number, y: number, dir: "asc" | "desc") {
  ctx.beginPath();
  if (dir === "asc") {
    ctx.moveTo(x - 4, y + 2.5);
    ctx.lineTo(x + 4, y + 2.5);
    ctx.lineTo(x, y - 2.5);
  } else {
    ctx.moveTo(x - 4, y - 2.5);
    ctx.lineTo(x + 4, y - 2.5);
    ctx.lineTo(x, y + 2.5);
  }
  ctx.closePath();
  ctx.fill();
}
