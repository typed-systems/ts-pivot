import type { Schema } from "../engine/db/duck";
import type { RawSort } from "../engine/db/raw";
import type { DisplayRows } from "../engine/pivot/display";
import type { PivotResult } from "../engine/pivot/pivot";
import type { GridHover } from "../grid/pivot/CanvasPivotGrid";
import { fmt } from "../lib/format";

/** Footer: the error if there is one; otherwise timings, sizes and the hovered cell. */
export function StatusBar({
  error,
  loadMs,
  isPivot,
  schema,
  rawSort,
  result,
  display,
  hover,
}: {
  error: string | null;
  loadMs: number;
  isPivot: boolean;
  schema: Schema | null;
  rawSort: RawSort | null;
  result: PivotResult | null;
  display: DisplayRows | null;
  hover: GridHover | null;
}) {
  return (
    <footer className="status">
      {error ? (
        <span className="err">{error}</span>
      ) : (
        <>
          <span>load {loadMs.toFixed(0)} ms</span>
          {!isPivot && schema && (
            <span>
              {schema.rows.toLocaleString()} rows × {schema.fields.length} cols
              {rawSort ? ` · sorted by ${rawSort.column} ${rawSort.dir}` : ""}
            </span>
          )}
          {isPivot && result && display && (
            <>
              <span>
                {display.count.toLocaleString()} rows × {result.colCount.toLocaleString()} cols
              </span>
              <span>query {result.queryMs.toFixed(0)} ms</span>
              <span>build {result.buildMs.toFixed(1)} ms</span>
            </>
          )}
          <span className="hover">
            {hover
              ? `${hover.rowPath.join(" › ")}  ×  ${hover.colPath.join(" › ")}  =  ${fmt(hover.value) || "—"}`
              : ""}
          </span>
        </>
      )}
    </footer>
  );
}
