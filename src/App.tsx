import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadFile, loadSampleData, type Schema } from "./engine/db/duck";
import { type RawSort, RawSource, SortRequests } from "./engine/db/raw";
import { downloadPivotXlsx } from "./engine/excel/xlsxExport";
import { defaultConfig, moveField, SAMPLE_CONFIG, type Zone } from "./engine/pivot/config";
import {
  buildDisplay,
  COLLAPSED_ALL,
  EXPANDED_ALL,
  type ExpandState,
  nodeKey,
  toggleKey,
} from "./engine/pivot/display";
import { configFits, type PivotConfig, type PivotResult, runPivot } from "./engine/pivot/pivot";
import { selectionStats } from "./engine/pivot/selection";
import { DataGrid } from "./grid/data/DataGrid";
import type { CellRange, GridHover } from "./grid/pivot/CanvasPivotGrid";
import { PivotGrid2D, type PivotGridApi } from "./grid/pivot/PivotGrid2D";
import { usePivotSort } from "./hooks/usePivotSort";
import { useTheme } from "./hooks/useTheme";
import { useViewportSync } from "./hooks/useViewportSync";
import { saveBlob } from "./lib/saveBlob";
import type { CaptureHandle } from "./three/Capture";
import { PivotScene3D } from "./three/PivotScene3D";
import { FieldZones } from "./ui/FieldZones";
import { Logo } from "./ui/Logo";
import { DEFAULT_SCENE, SceneControls, type SceneOptions } from "./ui/SceneControls";
import { SelectionBar } from "./ui/SelectionBar";
import { SourceControls } from "./ui/SourceControls";
import { StatusBar } from "./ui/StatusBar";
import { ValueControls } from "./ui/ValueControls";

type View = "2d" | "3d" | "split";
type Mode = "pivot" | "data";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App() {
  const [sampleRows, setSampleRows] = useState(1_000_000);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [loading, setLoading] = useState<string | null>("Starting DuckDB…");
  const [loadMs, setLoadMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [config, setConfig] = useState<PivotConfig>(SAMPLE_CONFIG);
  const [result, setResult] = useState<PivotResult | null>(null);
  const [expand, setExpand] = useState<ExpandState>(EXPANDED_ALL);
  const [mode, setMode] = useState<Mode>("pivot");
  const [view, setView] = useState<View>("split");
  const [sorting, setSorting] = useState(false);
  const [rawSort, setRawSort] = useState<RawSort | null>(null);
  const [heatmap, setHeatmap] = useState(true);
  const [scene, setScene] = useState<SceneOptions>(DEFAULT_SCENE);
  const [hover, setHover] = useState<GridHover | null>(null);
  const [pending, setPending] = useState(false);
  const [dragFile, setDragFile] = useState(false);
  const seq = useRef(0);
  const sortRequests = useRef(new SortRequests()); // overlapping header sorts: latest wins
  const lastFile = useRef<File | null>(null); // for switching Excel sheets
  const { theme, pref: themePref, cycle: cycleTheme } = useTheme();

  // ---------------------------------------------------------------- data source

  const loadSample = useCallback((rows: number) => {
    setSampleRows(rows);
    setLoading(`Generating ${rows.toLocaleString()} rows in DuckDB…`);
    loadSampleData(rows)
      .then(({ schema, ms }) => {
        setLoadMs(ms);
        setSchema(schema);
        setConfig((c) => (configFits(c, schema) ? c : SAMPLE_CONFIG));
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(null));
  }, []);

  const openFile = useCallback((file: File, sheet?: string) => {
    lastFile.current = file;
    setLoading(`Loading ${file.name}${sheet ? ` › ${sheet}` : ""}…`);
    loadFile(file, sheet)
      .then(({ schema, ms }) => {
        setLoadMs(ms);
        setSchema(schema);
        setConfig(defaultConfig(schema));
        setExpand(EXPANDED_ALL);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(null));
  }, []);

  useEffect(() => loadSample(1_000_000), [loadSample]);

  // ---------------------------------------------------------------- pivot

  // Re-run whenever config/schema changes. runPivot cancels the in-flight query.
  useEffect(() => {
    if (!schema || config.rows.length === 0) return;
    const id = ++seq.current;
    setPending(true);
    runPivot(config, schema)
      .then((r) => {
        if (!r || id !== seq.current) return;
        setResult(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (id === seq.current) setError(String(e));
      })
      .finally(() => {
        if (id === seq.current) setPending(false);
      });
  }, [config, schema]);

  const { rowSort, onSort } = usePivotSort(result);
  const display = useMemo(() => (result ? buildDisplay(result, expand, rowSort) : null), [result, expand, rowSort]);

  const onToggle = useCallback(
    (level: number, index: number) => {
      if (result) setExpand((s) => toggleKey(s, nodeKey(result, level, index)));
    },
    [result],
  );

  const onMoveField = useCallback((name: string, zone: Zone, index: number) => {
    setConfig((c) => moveField(c, name, zone, index));
  }, []);

  // ---------------------------------------------------------------- selection
  // Cells dragged out in the grid. While there is one, the 3D view plots only
  // those cells. Row indices are display rows, so any new data, order or
  // open/closed group clears it.
  const gridApi = useRef<PivotGridApi>(null);
  const [selection, setSelection] = useState<CellRange | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: display is the trigger: new rows, order or open groups clear the selection
  useEffect(() => setSelection(null), [display]);
  const clearSelection = useCallback(() => {
    setSelection(null);
    gridApi.current?.clearSelection();
  }, []);
  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, clearSelection]);

  const selStats = useMemo(
    () => (selection && result && display ? selectionStats(result, display, selection) : null),
    [selection, result, display],
  );

  const { viewport, onGridViewport, scrollFrom3D } = useViewportSync({
    grid: gridApi,
    result,
    display,
    selection,
    gridVisible: mode === "pivot" && view !== "3d",
    layout: `${mode}:${view}`,
  });

  // ---------------------------------------------------------------- file drop

  // Listen on window rather than on the app root: the drop target is the whole page
  // (a mouse-only shortcut for the file picker in SourceControls), so no element
  // needs a handler. A depth counter tracks enter/leave pairs across child
  // elements, which is more reliable than relatedTarget (often null in Safari).
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragFile(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragFile(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault(); // allow dropping
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragFile(false);
      const f = e.dataTransfer?.files[0];
      if (f) {
        e.preventDefault(); // don't let the browser navigate to the file
        openFile(f);
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [openFile]);

  // ---------------------------------------------------------------- raw data view

  const measures = schema?.fields.filter((f) => f.numeric) ?? [];
  const hasGroups = (result?.levels.length ?? 0) > 1;
  // Raw rows of whatever is loaded; a new source per load (new file/sample/sheet).
  const raw = useMemo(() => (schema ? new RawSource(schema) : null), [schema]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: raw is the trigger: a new data source resets the header sort
  useEffect(() => setRawSort(null), [raw]);

  // Header click: asc -> desc -> original order.
  const onRawSort = useCallback(
    (column: string) => {
      if (!raw) return;
      const cur = raw.currentSort;
      const next: RawSort | null =
        cur?.column !== column ? { column, dir: "asc" } : cur.dir === "asc" ? { column, dir: "desc" } : null;
      void sortRequests.current.run(raw, next, {
        busy: setSorting,
        sorted: setRawSort,
        failed: (e) => setError(String(e)),
      });
    },
    [raw],
  );

  // ---------------------------------------------------------------- export

  const [exporting, setExporting] = useState<string | null>(null);
  // File name stem from what's loaded: "sales.xlsx › Q1" -> "sales"
  const fileBase = useCallback(
    () =>
      (schema?.source ?? "")
        .replace(/ › .*$/, "")
        .replace(/\.[^.]+$/, "")
        .replace(/[^\w.-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "pivot",
    [schema],
  );

  // Download the pivot as .xlsx, as shown (open groups, sort order).
  const exportXlsx = useCallback(() => {
    if (!result || !display || !schema) return;
    const what = result.config.agg === "count" ? "count" : `${result.config.agg} of ${result.config.measure}`;
    setExporting("Writing .xlsx… 0%");
    downloadPivotXlsx(result, display, `${fileBase()}-pivot.xlsx`, what, (p) =>
      setExporting(`Writing .xlsx… ${Math.round(p * 100)}%`),
    )
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setExporting(null));
  }, [result, display, schema, fileBase]);

  // Save the 3D view as a PNG (as on screen, at the screen's pixel density).
  const sceneCapture = useRef<CaptureHandle>(null);
  const exportPng = useCallback(() => {
    sceneCapture.current
      ?.capture()
      .then((blob) => saveBlob(blob, `${fileBase()}-3d.png`))
      .catch((e: unknown) => setError(errorText(e)));
  }, [fileBase]);

  const busy = exporting ?? loading ?? (sorting ? "Sorting…" : pending && mode === "pivot" ? "Pivoting…" : null);
  const isPivot = mode === "pivot";
  // Shared hover: the grid outlines the cell of a hovered bar and vice versa.
  const linkedCell = useMemo(() => (hover ? { row: hover.row, col: hover.col } : null), [hover]);

  return (
    <div className="app">
      <header className="toolbar">
        <Logo />

        <div className="seg mode" role="tablist" aria-label="Show">
          {(["pivot", "data"] as const).map((m) => (
            <button
              type="button"
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "on" : ""}
              onClick={() => setMode(m)}
            >
              {m === "pivot" ? "Pivot" : "Data"}
            </button>
          ))}
        </div>

        <SourceControls
          sampleRows={sampleRows}
          schema={schema}
          onSample={loadSample}
          onFile={(f) => openFile(f)}
          onSheet={(sheet) => lastFile.current && openFile(lastFile.current, sheet)}
        />

        {isPivot && (
          <>
            <ValueControls config={config} measures={measures} onChange={setConfig} />

            <div className="group">
              <button type="button" disabled={!hasGroups} onClick={() => setExpand(EXPANDED_ALL)}>
                Expand all
              </button>
              <button type="button" disabled={!hasGroups} onClick={() => setExpand(COLLAPSED_ALL)}>
                Collapse all
              </button>
              <button
                type="button"
                disabled={!result || !display || !!exporting}
                onClick={exportXlsx}
                title="Download the pivot as shown (open groups, sort order) as an Excel file"
              >
                ⤓ .xlsx
              </button>
              {view !== "2d" && (
                <button
                  type="button"
                  disabled={!result}
                  onClick={exportPng}
                  title="Download the 3D view as a PNG image"
                >
                  ⤓ .png
                </button>
              )}
            </div>

            <div className="group">
              <label className="check">
                <input type="checkbox" checked={heatmap} onChange={(e) => setHeatmap(e.target.checked)} />
                Heatmap
              </label>
              {view !== "2d" && <SceneControls value={scene} onChange={(p) => setScene((s) => ({ ...s, ...p }))} />}
            </div>

            <div className="seg">
              {(["2d", "split", "3d"] as const).map((v) => (
                <button type="button" key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                  {v.toUpperCase()}
                </button>
              ))}
            </div>
          </>
        )}

        <button
          type="button"
          className={`theme-btn${isPivot ? "" : " push"}`}
          onClick={cycleTheme}
          title="Theme: system → light → dark"
          aria-label={`Theme: ${themePref}`}
        >
          {themePref === "system" ? "◐ auto" : themePref === "light" ? "☀ light" : "☾ dark"}
        </button>
      </header>

      {schema && isPivot && (
        <FieldZones fields={schema.fields} rows={config.rows} cols={config.cols} onMove={onMoveField} />
      )}

      <main className={`views view-${isPivot ? view : "data"}`}>
        {!isPivot && (
          <section className="pane pane-data">
            <DataGrid source={raw} onSort={onRawSort} theme={theme} />
          </section>
        )}
        <section className="pane pane-2d">
          <PivotGrid2D
            apiRef={gridApi}
            onSelect={setSelection}
            data={result}
            rows={display}
            heatmap={heatmap}
            onViewport={onGridViewport}
            onHover={setHover}
            onToggle={onToggle}
            onSort={onSort}
            sort={rowSort}
            linked={linkedCell}
            theme={theme}
          />
        </section>
        {isPivot && view !== "2d" && (
          <section className="pane pane-3d">
            <PivotScene3D
              data={result}
              rows={display}
              viewport={viewport}
              heatmap={heatmap}
              colorMode={scene.colorMode}
              env={scene.env}
              ao={scene.ao}
              shadows={scene.shadows}
              onScroll={scrollFrom3D}
              captureRef={sceneCapture}
              selection={selection}
              onHover={setHover}
              linked={linkedCell}
              theme={theme}
            />
          </section>
        )}
        {busy && <div className="busy">{busy}</div>}
        {dragFile && <div className="file-drop">Drop a Parquet, CSV, JSON or Excel (.xlsx) file</div>}
      </main>

      {isPivot && selStats && <SelectionBar stats={selStats} plotted={view !== "2d"} onClear={clearSelection} />}

      <StatusBar
        error={error}
        loadMs={loadMs}
        isPivot={isPivot}
        schema={schema}
        rawSort={rawSort}
        result={result}
        display={display}
        hover={hover}
      />
    </div>
  );
}
