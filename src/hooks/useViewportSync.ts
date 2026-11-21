import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { DisplayRows } from "../engine/pivot/display";
import type { PivotResult } from "../engine/pivot/pivot";
import type { CellRange, GridViewport } from "../grid/pivot/CanvasPivotGrid";
import type { PivotGridApi } from "../grid/pivot/PivotGrid2D";
import type { ScrollLimits } from "../three/useWheelScroll";

/**
 * Keeps the 3D window and the 2D grid on the same rows and columns.
 *
 * - The grid reports its viewport every scrolled frame; the 3D view only needs
 *   to follow along, so it gets it at most ~8x/sec (trailing edge).
 * - Scrolling from the 3D view (Shift / Alt + wheel) moves the 3D window at
 *   once; the grid, when it's showing, scrolls along and reports the same
 *   viewport back. A selection pins the 3D view.
 * - A new query starts at the top; coming back from 3D-only puts the grid where
 *   the 3D view was scrolled to.
 */
export function useViewportSync({
  grid,
  result,
  display,
  selection,
  gridVisible,
  layout,
}: {
  grid: RefObject<PivotGridApi | null>;
  result: PivotResult | null;
  display: DisplayRows | null;
  selection: CellRange | null;
  /** The pivot grid is on screen (not 3D-only, not the Data view). */
  gridVisible: boolean;
  /** Any value that changes when the pane layout changes. */
  layout: string;
}) {
  const [viewport, setViewport] = useState<GridViewport | null>(null);
  const latest = useRef<GridViewport | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const onGridViewport = useCallback((vp: GridViewport) => {
    latest.current = vp;
    timer.current ??= window.setTimeout(() => {
      timer.current = undefined;
      setViewport(latest.current);
    }, 120);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const scrollFrom3D = useCallback(
    (dRows: number, dCols: number, { maxRow, maxCol }: ScrollLimits) => {
      if (!result || !display || selection) return;
      const base = latest.current ?? { firstRow: 0, rowCount: 40, firstCol: 0, colCount: 8 };
      // (never jump back if the grid is already scrolled past the 3D limit)
      const firstRow = Math.min(Math.max(maxRow, base.firstRow), Math.max(0, base.firstRow + dRows));
      const firstCol = Math.min(Math.max(maxCol, base.firstCol), Math.max(0, base.firstCol + dCols));
      if (firstRow === base.firstRow && firstCol === base.firstCol) return;
      const vp = { ...base, firstRow, firstCol };
      latest.current = vp;
      setViewport(vp);
      grid.current?.scrollTo(firstRow, firstCol);
    },
    [grid, result, display, selection],
  );

  // A new query starts at the top, also while the grid is hidden (3D only).
  // biome-ignore lint/correctness/useExhaustiveDependencies: result is the trigger: a new query scrolls back to the top
  useEffect(() => {
    const vp = latest.current;
    if (vp && (vp.firstRow || vp.firstCol)) {
      latest.current = { ...vp, firstRow: 0, firstCol: 0 };
      setViewport(latest.current);
    }
  }, [result]);

  // Grid shown (again) or its pane resized by a layout change: put it where the
  // 3D view was scrolled to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layout is the trigger: every layout switch re-aligns the grid
  useEffect(() => {
    if (!gridVisible) return;
    const vp = latest.current;
    if (!vp) return;
    const id = requestAnimationFrame(() => grid.current?.scrollTo(vp.firstRow, vp.firstCol));
    return () => cancelAnimationFrame(id);
  }, [grid, gridVisible, layout]);

  return { viewport, onGridViewport, scrollFrom3D };
}
