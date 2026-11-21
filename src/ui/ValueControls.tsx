import type { Field } from "../engine/db/duck";
import { AGGS, type Agg, type PivotConfig } from "../engine/pivot/pivot";

/** Toolbar group for what each cell shows: the aggregation and the measure it applies to. */
export function ValueControls({
  config,
  measures,
  onChange,
}: {
  config: PivotConfig;
  /** Numeric fields. */
  measures: Field[];
  onChange: (update: (c: PivotConfig) => PivotConfig) => void;
}) {
  return (
    <div className="group">
      <span className="lbl">Value</span>
      <select
        aria-label="Aggregation"
        value={config.agg}
        onChange={(e) =>
          onChange((c) => ({
            ...c,
            agg: e.target.value as Agg,
            measure: c.measure ?? measures[0]?.name ?? null,
          }))
        }
      >
        {AGGS.map((a) => (
          <option key={a} value={a} disabled={a !== "count" && measures.length === 0}>
            {a}
          </option>
        ))}
      </select>
      <select
        aria-label="Measure"
        value={config.measure ?? ""}
        disabled={config.agg === "count" || measures.length === 0}
        onChange={(e) => onChange((c) => ({ ...c, measure: e.target.value }))}
      >
        {measures.map((m) => (
          <option key={m.name}>{m.name}</option>
        ))}
      </select>
    </div>
  );
}
