import type { DisplayRows } from "../engine/pivot/display";
import type { PivotResult } from "../engine/pivot/pivot";
import type { CellRange, GridViewport } from "../grid/pivot/CanvasPivotGrid";

/** Most bars the scene draws along each axis. */
export const MAX_ROWS = 120;
export const MAX_COLS = 120;

export type SceneWindow = NonNullable<ReturnType<typeof sceneWindow>>;

/**
 * The slice of the pivot shown as bars, starting at the viewport's first row
 * and column. Its layout size stays the same while you scroll (it doesn't
 * shrink near the end and is rounded to tens), so the bars, floor grid and
 * camera don't jump; `rows` / `cols` is what's actually left to draw.
 */
export function sceneWindow(
  data: PivotResult | null,
  rows: DisplayRows | null,
  viewport: GridViewport | null,
  selection: CellRange | null = null,
) {
  if (!data || !rows || rows.count === 0) return null;
  if (selection) {
    // Exactly the selected block (columns may include Total = colCount), capped.
    const r0 = Math.min(selection.r0, rows.count - 1);
    const c0 = Math.min(selection.c0, data.colCount);
    const nr = Math.min(MAX_ROWS, Math.min(selection.r1, rows.count - 1) - r0 + 1);
    const nc = Math.min(MAX_COLS, Math.min(selection.c1, data.colCount) - c0 + 1);
    return { r0, c0, rows: nr, cols: nc, layoutRows: nr, layoutCols: nc, selected: true };
  }
  const nCols = Math.max(1, data.colCount); // no column fields -> one column of row totals
  const r0 = viewport ? Math.min(viewport.firstRow, rows.count - 1) : 0;
  const c0 = viewport && data.colCount > 0 ? Math.min(viewport.firstCol, nCols - 1) : 0;
  const wanted = Math.ceil(Math.max(viewport?.rowCount ?? 40, 40) / 10) * 10;
  const layoutRows = Math.min(MAX_ROWS, rows.count, wanted);
  const layoutCols = Math.min(MAX_COLS, nCols);
  const nr = Math.min(layoutRows, rows.count - r0);
  const nc = Math.min(layoutCols, nCols - c0);
  return { r0, c0, rows: Math.max(0, nr), cols: Math.max(0, nc), layoutRows, layoutCols, selected: false };
}
