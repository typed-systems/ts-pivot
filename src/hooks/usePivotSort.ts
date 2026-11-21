import { useCallback, useMemo, useState } from "react";
import type { RowSort } from "../engine/pivot/display";
import type { PivotResult } from "../engine/pivot/pivot";

type Dir = "asc" | "desc";
/** Value columns are remembered by their label path (not index), so the sort survives re-queries. */
type SortPref = { by: "label"; dir: Dir } | { by: "value"; key: string; dir: Dir };
export type SortTarget = { by: "label" } | { by: "value"; col: number };

/** Stable identity of a pivot column (its label path); colCount is the Total column. */
export function colKey(r: PivotResult, col: number): string {
  return col >= r.colCount ? "\u0000total" : r.colLabels.map((l) => l[col]).join("\u0001");
}

/**
 * Pivot row sort, kept across re-queries (new measure, expand/collapse, new data)
 * as long as the sorted column still exists.
 * Header click cycle: values desc -> asc -> off; labels asc -> desc -> off.
 */
export function usePivotSort(result: PivotResult | null) {
  const [pref, setPref] = useState<SortPref | null>(null);

  const rowSort = useMemo<RowSort | null>(() => {
    if (!pref || !result) return null;
    if (pref.by === "label") return pref;
    for (let c = 0; c <= result.colCount; c++)
      if (colKey(result, c) === pref.key) return { by: "value", col: c, dir: pref.dir };
    return null; // that column no longer exists
  }, [pref, result]);

  const onSort = useCallback(
    (t: SortTarget) => {
      if (!result) return;
      setPref((cur) => {
        if (t.by === "label") {
          if (cur?.by !== "label") return { by: "label", dir: "asc" };
          return cur.dir === "asc" ? { by: "label", dir: "desc" } : null;
        }
        const key = colKey(result, t.col);
        if (cur?.by !== "value" || cur.key !== key) return { by: "value", key, dir: "desc" };
        return cur.dir === "desc" ? { by: "value", key, dir: "asc" } : null;
      });
    },
    [result],
  );

  return { rowSort, onSort };
}
