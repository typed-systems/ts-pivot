import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db/duck", () => import("../../test/nodeDuck"));

import { sql } from "../../test/nodeDuck";
import type { Schema } from "../db/duck";
import { buildDisplay, EXPANDED_ALL } from "../pivot/display";
import { type PivotResult, runPivot } from "../pivot/pivot";
import { buildPivotXlsx } from "./xlsxExport";

const DEPTH = 10; // deeper than Excel's 7 outline levels
const dims = Array.from({ length: DEPTH }, (_, i) => `d${i}`);
const schema: Schema = {
  source: "test",
  rows: 2,
  fields: [
    ...dims.map((name) => ({ name, type: "VARCHAR", numeric: false })),
    { name: "n", type: "DOUBLE", numeric: true },
  ],
};

let result: PivotResult;

beforeAll(async () => {
  const row = (tag: string, n: number) => `(${dims.map((d) => `'${tag}${d}'`).join(", ")}, ${n})`;
  await sql(
    `CREATE OR REPLACE TABLE facts AS SELECT * FROM (VALUES ${row("a", 1)}, ${row("b", 2)}) t(${dims.join(", ")}, n)`,
  );
  result = (await runPivot({ rows: dims, cols: [], measure: "n", agg: "sum" }, schema))!;
});

function sheetXml(data: PivotResult): string {
  const bytes = buildPivotXlsx(data, buildDisplay(data, EXPANDED_ALL), { sheet: "Pivot" });
  const files = unzipSync(bytes);
  const name = Object.keys(files).find((f) => /^xl\/worksheets\/.*\.xml$/.test(f))!;
  return strFromU8(files[name]!);
}

describe("buildPivotXlsx", () => {
  it("keeps row outline levels within Excel's 0..7 limit", () => {
    const xml = sheetXml(result);
    const levels = [...xml.matchAll(/<row [^>]*outlineLevel="(\d+)"/g)].map((m) => Number(m[1]));
    expect(levels.length).toBeGreaterThan(0);
    expect(Math.max(...levels)).toBe(7);

    const sheetMax = Number(/outlineLevelRow="(\d+)"/.exec(xml)![1]);
    expect(sheetMax).toBe(7);
  });

  it("writes every row, including those past level 7", () => {
    const xml = sheetXml(result);
    // header + 2 * DEPTH display rows + grand total
    expect(xml.match(/<row /g)!.length).toBe(1 + 2 * DEPTH + 1);
    expect(xml).toContain("ad9");
    expect(xml).toContain("bd9");
  });
});
