import { GRID } from "../../theme/theme";
import { textNudge } from "./canvasText";
import { FONT } from "./gridStyle";

/**
 * Bottom bar, after kasouka's: a small progress wheel with the scrolled
 * percentage, then a row count on the left, and free text on the right.
 * Drawn into the grid's canvas, so it costs nothing outside the normal frame.
 */
export const BAR_H = 24;

/** Scrolled share of the vertical range, 0..100 (kasouka's formula). */
export function scrollPercent(scroller: HTMLElement): number {
  const max = scroller.scrollHeight - scroller.clientHeight;
  return scroller.scrollTop > 0 && max > 0 ? Math.round((scroller.scrollTop / max) * 100) : 0;
}

export function drawBottomBar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  percent: number,
  left: string,
  right = "",
) {
  const y = height - BAR_H;
  ctx.save();
  ctx.fillStyle = GRID.header;
  ctx.fillRect(0, y, width, BAR_H);
  ctx.strokeStyle = GRID.strong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(width, y + 0.5);
  ctx.stroke();

  ctx.font = FONT;
  ctx.textBaseline = "middle";
  const mid = y + BAR_H / 2 + textNudge(ctx, FONT);

  // The wheel: a faint full ring plus a round-capped arc for the progress,
  // starting at 12 o'clock (same geometry as kasouka's 24-unit icon at 14 px).
  const size = 14;
  const x0 = 8;
  const cx = x0 + size / 2;
  const cy = y + BAR_H / 2;
  const r = (9 / 24) * size;
  ctx.strokeStyle = GRID.text;
  ctx.lineWidth = (3 / 24) * size;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (percent > 0) {
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (percent / 100) * Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = GRID.text;
  ctx.textAlign = "left";
  const pct = `${percent}%`;
  let x = x0 + size + 4;
  ctx.fillText(pct, x, mid);
  // fixed slot so the row count doesn't jiggle as the percentage changes
  x += Math.max(ctx.measureText("100%").width, ctx.measureText(pct).width) + 16;
  ctx.fillText(left, x, mid);

  if (right) {
    ctx.fillStyle = GRID.muted;
    ctx.textAlign = "right";
    ctx.fillText(right, width - 8, mid);
  }
  ctx.restore();
}
