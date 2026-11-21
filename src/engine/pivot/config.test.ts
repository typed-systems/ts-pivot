import { describe, expect, it } from "vitest";
import type { Schema } from "../db/duck";
import { defaultConfig, moveField } from "./config";
import type { PivotConfig } from "./pivot";

const base: PivotConfig = { rows: ["region", "country"], cols: ["year"], measure: "revenue", agg: "sum" };

describe("moveField", () => {
  it("adds a field from the field list at the drop position", () => {
    expect(moveField(base, "segment", "rows", 1).rows).toEqual(["region", "segment", "country"]);
    expect(moveField(base, "quarter", "cols", 1).cols).toEqual(["year", "quarter"]);
  });

  it("moves a field later in the same list, accounting for its old slot", () => {
    // drop "region" after "country": index 2 in the list as shown, before removal
    expect(moveField(base, "region", "rows", 2).rows).toEqual(["country", "region"]);
  });

  it("moves a field between rows and columns", () => {
    const c = moveField(base, "year", "rows", 0);
    expect(c.rows).toEqual(["year", "region", "country"]);
    expect(c.cols).toEqual([]);
  });

  it("removes a field when dropped on the field list", () => {
    expect(moveField(base, "country", "fields", 0).rows).toEqual(["region"]);
  });

  it("keeps at least one row field", () => {
    const one: PivotConfig = { ...base, rows: ["region"] };
    expect(moveField(one, "region", "fields", 0)).toBe(one);
    expect(moveField(one, "region", "cols", 0)).toBe(one);
  });

  it("returns the same object when nothing changes", () => {
    expect(moveField(base, "region", "rows", 0)).toBe(base);
  });
});

describe("defaultConfig", () => {
  const field = (name: string, type: string, numeric = false) => ({ name, type, numeric });

  it("prefers a text column for rows and the first numeric column as a summed measure", () => {
    const schema: Schema = {
      source: "f",
      rows: 1,
      fields: [field("day", "DATE"), field("amount", "DOUBLE", true), field("store", "VARCHAR")],
    };
    expect(defaultConfig(schema)).toEqual({ rows: ["store"], cols: [], measure: "amount", agg: "sum" });
  });

  it("counts rows when nothing is numeric", () => {
    const schema: Schema = { source: "f", rows: 1, fields: [field("day", "DATE")] };
    expect(defaultConfig(schema)).toEqual({ rows: ["day"], cols: [], measure: null, agg: "count" });
  });
});
