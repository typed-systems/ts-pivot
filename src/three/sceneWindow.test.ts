import { describe, expect, it } from "vitest";
import type { DisplayRows } from "../engine/pivot/display";
import type { PivotResult } from "../engine/pivot/pivot";
import { MAX_COLS, MAX_ROWS, sceneWindow } from "./sceneWindow";

// sceneWindow only reads the row count and the column count.
const data = (colCount: number) => ({ colCount }) as PivotResult;
const rows = (count: number) => ({ count }) as DisplayRows;
const vp = (firstRow: number, rowCount: number, firstCol = 0) => ({ firstRow, rowCount, firstCol, colCount: 8 });

describe("sceneWindow", () => {
  it("is empty without rows", () => {
    expect(sceneWindow(data(3), rows(0), null)).toBeNull();
    expect(sceneWindow(null, rows(5), null)).toBeNull();
  });

  it("starts at the viewport and keeps a layout size rounded up to tens", () => {
    const w = sceneWindow(data(50), rows(1000), vp(100, 33, 5))!;
    expect(w).toMatchObject({ r0: 100, c0: 5, layoutRows: 40, rows: 40, selected: false });
    expect(w.layoutCols).toBe(50);
    expect(w.cols).toBe(45); // what's left to the right of column 5
  });

  it("keeps the layout size near the end, drawing only what's left", () => {
    const w = sceneWindow(data(3), rows(1000), vp(990, 40))!;
    expect(w.layoutRows).toBe(40);
    expect(w.rows).toBe(10);
  });

  it("caps the window at MAX_ROWS × MAX_COLS", () => {
    const w = sceneWindow(data(500), rows(5000), vp(0, 400))!;
    expect(w.layoutRows).toBe(MAX_ROWS);
    expect(w.layoutCols).toBe(MAX_COLS);
  });

  it("uses one column of row totals when there are no column fields", () => {
    const w = sceneWindow(data(0), rows(10), vp(0, 40, 7))!;
    expect(w).toMatchObject({ c0: 0, cols: 1, layoutCols: 1 });
  });

  it("plots exactly a selection, including the Total column", () => {
    const w = sceneWindow(data(4), rows(100), vp(50, 40), { r0: 2, r1: 5, c0: 3, c1: 4 })!;
    expect(w).toMatchObject({ r0: 2, c0: 3, rows: 4, cols: 2, layoutRows: 4, layoutCols: 2, selected: true });
  });
});
