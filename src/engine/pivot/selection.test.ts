import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db/duck", () => import("../../test/nodeDuck"));

import { colKey } from "../../hooks/usePivotSort";
import { sql } from "../../test/nodeDuck";
import type { Schema } from "../db/duck";
import { buildDisplay, type DisplayRows, EXPANDED_ALL } from "./display";
import { type PivotResult, runPivot } from "./pivot";
import { selectionStats } from "./selection";

const schema: Schema = {
  source: "t",
  rows: 4,
  fields: [
    { name: "region", type: "VARCHAR", numeric: false },
    { name: "city", type: "VARCHAR", numeric: false },
    { name: "year", type: "VARCHAR", numeric: false },
    { name: "n", type: "DOUBLE", numeric: true },
  ],
};

let result: PivotResult;
let display: DisplayRows;

beforeAll(async () => {
  await sql(`CREATE OR REPLACE TABLE facts AS SELECT * FROM (VALUES
    ('EU', 'Oslo', '2024', 1.0),
    ('EU', 'Rome', '2024', 2.0),
    ('EU', 'Rome', '2025', 4.0),
    ('US', 'Austin', '2025', 8.0)
  ) t(region, city, year, n)`);
  result = (await runPivot({ rows: ["region", "city"], cols: ["year"], measure: "n", agg: "sum" }, schema))!;
  display = buildDisplay(result, EXPANDED_ALL);
  // display rows: 0 EU, 1 EU›Oslo, 2 EU›Rome, 3 US, 4 US›Austin; cols: 0 2024, 1 2025, 2 Total
});

describe("selectionStats", () => {
  it("sums leaf cells and names the spans", () => {
    const s = selectionStats(result, display, { r0: 1, r1: 2, c0: 0, c1: 1 });
    expect(s).toMatchObject({ rows: 2, cols: 2, n: 3, sum: 7, min: 1, max: 4, mixed: false });
    expect(s.rowSpan).toBe("EU › Oslo → EU › Rome");
    expect(s.colSpan).toBe("2024 → 2025");
  });

  it("skips empty cells and flags subtotal rows mixed with their children", () => {
    const s = selectionStats(result, display, { r0: 0, r1: 1, c0: 1, c1: 1 });
    expect(s).toMatchObject({ n: 1, sum: 4, mixed: true }); // EU 2025 = 4, Oslo 2025 empty
  });

  it("names the Total column", () => {
    const s = selectionStats(result, display, { r0: 4, r1: 4, c0: 2, c1: 2 });
    expect(s).toMatchObject({ n: 1, sum: 8, rowSpan: "US › Austin", colSpan: "Total" });
  });
});

describe("colKey", () => {
  it("is the column's label path, so it survives a re-query with other columns", () => {
    expect(colKey(result, 1)).toBe("2025");
    expect(colKey(result, result.colCount)).toBe("\u0000total");
  });
});
