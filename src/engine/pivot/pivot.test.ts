import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db/duck", () => import("../../test/nodeDuck"));

import { sql } from "../../test/nodeDuck";
import type { Schema } from "../db/duck";
import { configFits, type PivotConfig, runPivot } from "./pivot";

// Dimension names that are also the pivot's internal helper-column names.
const schema: Schema = {
  source: "test",
  rows: 6,
  fields: [
    { name: "lev", type: "VARCHAR", numeric: false },
    { name: "v", type: "VARCHAR", numeric: false },
    { name: "cf", type: "VARCHAR", numeric: false },
    { name: "ri", type: "VARCHAR", numeric: false },
    { name: "ci", type: "VARCHAR", numeric: false },
    { name: "amount", type: "DOUBLE", numeric: true },
  ],
};

beforeAll(async () => {
  await sql(`CREATE OR REPLACE TABLE facts AS SELECT * FROM (VALUES
    ('a', 'x', 'p', 'r1', 'c1', 1.0),
    ('a', 'y', 'q', 'r1', 'c2', 2.0),
    ('a', 'y', 'p', 'r2', 'c1', 3.0),
    ('b', 'x', 'q', 'r2', 'c2', 4.0),
    ('b', 'x', 'p', 'r1', 'c1', 5.0),
    ('b', 'y', 'q', 'r2', 'c2', 6.0)
  ) t(lev, v, cf, ri, ci, amount)`);
});

describe("runPivot", () => {
  it("pivots on fields named like its internal columns (lev, v, cf, ri, ci)", async () => {
    const res = await runPivot({ rows: ["lev", "v"], cols: ["cf"], measure: "amount", agg: "sum" }, schema);
    expect(res).not.toBeNull();
    const r = res!;
    expect(r.grandTotal).toBe(21);
    expect(r.colLabels).toEqual([["p", "q"]]);
    expect(Array.from(r.colTotals)).toEqual([9, 12]);

    const [top, leaf] = r.levels;
    expect(top!.labels).toEqual([["a", "b"]]);
    expect(Array.from(top!.totals)).toEqual([6, 15]);
    expect(Array.from(top!.values)).toEqual([4, 2, 5, 10]); // a:p,q  b:p,q

    expect(leaf!.labels).toEqual([
      ["a", "a", "b", "b"],
      ["x", "y", "x", "y"],
    ]);
    expect(Array.from(leaf!.totals)).toEqual([1, 5, 9, 6]);
    expect(Array.from(top!.childStart!)).toEqual([0, 2, 4]);
  });

  it("works with ri and ci as row and column fields", async () => {
    const r = (await runPivot({ rows: ["ri"], cols: ["ci"], measure: null, agg: "count" }, schema))!;
    expect(r.levels[0]!.labels).toEqual([["r1", "r2"]]);
    expect(r.colLabels).toEqual([["c1", "c2"]]);
    expect(Array.from(r.levels[0]!.values)).toEqual([2, 1, 1, 2]);
    expect(r.grandTotal).toBe(6);
  });
});

describe("configFits", () => {
  const base: PivotConfig = { rows: ["lev", "v"], cols: ["cf"], measure: "amount", agg: "sum" };

  it("accepts a config whose fields all exist", () => {
    expect(configFits(base, schema)).toBe(true);
  });

  it("rejects a config when a later row field is missing", () => {
    expect(configFits({ ...base, rows: ["lev", "segment"] }, schema)).toBe(false);
  });

  it("rejects a config when a column field is missing", () => {
    expect(configFits({ ...base, cols: ["month"] }, schema)).toBe(false);
  });

  it("rejects a missing or non-numeric measure unless agg is count", () => {
    expect(configFits({ ...base, measure: "revenue" }, schema)).toBe(false);
    expect(configFits({ ...base, measure: "lev" }, schema)).toBe(false);
    expect(configFits({ ...base, measure: null, agg: "count" }, schema)).toBe(true);
  });

  it("rejects a config with no row fields", () => {
    expect(configFits({ ...base, rows: [] }, schema)).toBe(false);
  });
});
