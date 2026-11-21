import type { Schema } from "../db/duck";
import type { PivotConfig } from "./pivot";

/** Where a field sits in the pivot layout. */
export type Zone = "fields" | "rows" | "cols";

/** Starting layout for the generated sample data. */
export const SAMPLE_CONFIG: PivotConfig = {
  rows: ["region", "country"],
  cols: ["year", "quarter"],
  measure: "revenue",
  agg: "sum",
};

/** Sensible starting layout for an arbitrary file. */
export function defaultConfig(schema: Schema): PivotConfig {
  // Prefer a text column for the first row field: dates/timestamps are often unique per row.
  const nonNum = schema.fields.filter((f) => !f.numeric);
  const dims = [...nonNum.filter((f) => /CHAR|TEXT|STRING|BOOL/i.test(f.type)), ...nonNum];
  const nums = schema.fields.filter((f) => f.numeric);
  const firstRow = dims[0] ?? schema.fields[0];
  return {
    rows: firstRow ? [firstRow.name] : [],
    cols: [],
    measure: nums[0]?.name ?? null,
    agg: nums[0] ? "sum" : "count",
  };
}

/**
 * Move a field to `index` in `zone` (or out of the layout, zone "fields").
 * Returns the same config object when nothing changes, or when the move would
 * leave no row field (a pivot needs at least one).
 */
export function moveField(c: PivotConfig, name: string, zone: Zone, index: number): PivotConfig {
  const from: Zone = c.rows.includes(name) ? "rows" : c.cols.includes(name) ? "cols" : "fields";
  const oldIdx = from === "rows" ? c.rows.indexOf(name) : from === "cols" ? c.cols.indexOf(name) : -1;
  let rows = c.rows.filter((d) => d !== name);
  let cols = c.cols.filter((d) => d !== name);
  // Dropping later in the same list: account for the removed original.
  const at = from === zone && oldIdx < index ? index - 1 : index;
  if (zone === "rows") rows = [...rows.slice(0, at), name, ...rows.slice(at)];
  if (zone === "cols") cols = [...cols.slice(0, at), name, ...cols.slice(at)];
  if (rows.length === 0) return c;
  if (rows.join() === c.rows.join() && cols.join() === c.cols.join()) return c;
  return { ...c, rows, cols };
}
