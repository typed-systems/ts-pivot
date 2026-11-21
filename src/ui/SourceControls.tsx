import { useRef } from "react";
import { ACCEPT, type Schema } from "../engine/db/duck";

export const SAMPLE_SIZES = [100_000, 1_000_000, 5_000_000, 10_000_000];

/** Toolbar group for what's loaded: sample size, Open file…, Excel sheet, and a label. */
export function SourceControls({
  sampleRows,
  schema,
  onSample,
  onFile,
  onSheet,
}: {
  sampleRows: number;
  schema: Schema | null;
  onSample: (rows: number) => void;
  onFile: (file: File) => void;
  onSheet: (sheet: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="group">
      <select aria-label="Sample size" value={sampleRows} onChange={(e) => onSample(Number(e.target.value))}>
        {SAMPLE_SIZES.map((n) => (
          <option key={n} value={n}>
            sample · {n.toLocaleString()} rows
          </option>
        ))}
      </select>
      <button type="button" onClick={() => fileInput.current?.click()}>
        Open file…
      </button>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept={ACCEPT}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      {schema?.sheets && schema.sheets.length > 1 && (
        <select aria-label="Sheet" value={schema.sheet} onChange={(e) => onSheet(e.target.value)}>
          {schema.sheets.map((n) => (
            <option key={n} value={n}>
              sheet: {n}
            </option>
          ))}
        </select>
      )}
      <span className="source" title={schema?.source}>
        {schema ? `${schema.source} · ${schema.rows.toLocaleString()} rows` : ""}
      </span>
    </div>
  );
}
