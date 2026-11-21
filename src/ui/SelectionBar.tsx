import type { SelectionStats } from "../engine/pivot/selection";
import { fmt } from "../lib/format";

/** Summary strip for the selected cells, with a Clear button. */
export function SelectionBar({
  stats,
  plotted,
  onClear,
}: {
  stats: SelectionStats;
  /** The 3D view is showing (it plots only the selection). */
  plotted: boolean;
  onClear: () => void;
}) {
  return (
    <div className="selbar" role="status">
      <span className="sel-title">
        Selection · {stats.rows.toLocaleString()} × {stats.cols.toLocaleString()}
      </span>
      <span className="sel-span" title={`${stats.rowSpan}  ×  ${stats.colSpan}`}>
        {stats.rowSpan} <span className="sel-x">×</span> {stats.colSpan}
      </span>
      <span>
        {stats.n.toLocaleString()} values
        {stats.n > 0 && (
          <>
            {" "}
            · sum {fmt(stats.sum)} · avg {fmt(stats.sum / stats.n)} · min {fmt(stats.min)} · max {fmt(stats.max)}
          </>
        )}
        {stats.mixed && <span className="sel-note"> (includes subtotal rows)</span>}
      </span>
      {plotted && (
        <span className="sel-note">
          plotted in 3D
          {stats.rows > 120 || stats.cols > 120 ? " (first 120 × 120)" : ""}
        </span>
      )}
      <button type="button" className="sel-clear" onClick={onClear} title="Clear the selection (Esc)">
        ✕ Clear
      </button>
    </div>
  );
}
