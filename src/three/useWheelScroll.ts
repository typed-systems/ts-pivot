import { type RefObject, useEffect, useRef } from "react";

/** Wheel distance (px) per row / column when scrolling the table from 3D. */
const WHEEL_ROW_PX = 16;
const WHEEL_COL_PX = 40;

export type ScrollLimits = { maxRow: number; maxCol: number };
export type WheelScrollHandler = (dRows: number, dCols: number, limits: ScrollLimits) => void;

/**
 * Shift + wheel scrolls rows, Alt/Option + wheel scrolls columns; a plain wheel
 * is left alone (it zooms the camera). Caught in the capture phase, before
 * OrbitControls sees it, and flushed once per frame so a fast wheel doesn't
 * rebuild the bars per event. The latest `onScroll` and `limits` are always used.
 */
export function useWheelScroll(
  target: RefObject<HTMLElement | null>,
  onScroll: WheelScrollHandler | undefined,
  limits: ScrollLimits,
) {
  const latest = useRef({ onScroll, limits });
  useEffect(() => {
    latest.current = { onScroll, limits };
  });

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    let accY = 0;
    let accX = 0;
    let dr = 0;
    let dc = 0;
    let raf = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey && !e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const unit = e.deltaMode === 1 ? WHEEL_ROW_PX : e.deltaMode === 2 ? WHEEL_ROW_PX * 20 : 1;
      // macOS turns Shift + wheel into a horizontal scroll, so take whichever axis moved
      const d = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit;
      if (e.altKey) accX += d;
      else accY += d;
      const r = Math.trunc(accY / WHEEL_ROW_PX);
      const c = Math.trunc(accX / WHEEL_COL_PX);
      accY -= r * WHEEL_ROW_PX;
      accX -= c * WHEEL_COL_PX;
      dr += r;
      dc += c;
      if ((dr || dc) && !raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          const [a, b] = [dr, dc];
          dr = dc = 0;
          latest.current.onScroll?.(a, b, latest.current.limits);
        });
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
      cancelAnimationFrame(raf);
    };
  }, [target]);
}
