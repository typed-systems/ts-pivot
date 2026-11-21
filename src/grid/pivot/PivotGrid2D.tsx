import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import type { DisplayRows, RowSort } from "../../engine/pivot/display";
import type { PivotResult } from "../../engine/pivot/pivot";
import { CanvasPivotGrid, type CellRange, type GridHover, type GridViewport } from "./CanvasPivotGrid";

/** Imperative handle, so other views can scroll the table. */
export interface PivotGridApi {
  scrollTo(row: number, col?: number): void;
  /** Clear the cell selection (doesn't call onSelect). */
  clearSelection(): void;
}

interface Props {
  apiRef?: Ref<PivotGridApi>;
  data: PivotResult | null;
  rows: DisplayRows | null;
  heatmap: boolean;
  onViewport?: (vp: GridViewport) => void;
  onSelect?: (range: CellRange | null) => void;
  onHover?: (h: GridHover | null) => void;
  onToggle?: (level: number, index: number) => void;
  onSort?: (target: { by: "label" } | { by: "value"; col: number }) => void;
  sort?: RowSort | null;
  /** Cell to outline (hovered in the 3D view or in this grid). */
  linked?: { row: number; col: number } | null;
  /** Colors come from the live theme; a change just forces a redraw. */
  theme?: string;
}

/**
 * Thin React shell. The grid itself is imperative: React never re-renders on
 * scroll or hover; it only hands over new data/options.
 */
export function PivotGrid2D({
  apiRef,
  data,
  rows,
  heatmap,
  onViewport,
  onSelect,
  onHover,
  onToggle,
  onSort,
  sort = null,
  linked = null,
  theme,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<CanvasPivotGrid | null>(null);
  const prevData = useRef<PivotResult | null>(null);
  const cb = useRef({ onViewport, onSelect, onHover, onToggle, onSort });
  useEffect(() => {
    cb.current = { onViewport, onSelect, onHover, onToggle, onSort };
  });

  useEffect(() => {
    const grid = new CanvasPivotGrid(hostRef.current!, {
      onViewport: (vp) => cb.current.onViewport?.(vp),
      onSelect: (r) => cb.current.onSelect?.(r),
      onHover: (h) => cb.current.onHover?.(h),
      onToggle: (l, i) => cb.current.onToggle?.(l, i),
      onSort: (t) => cb.current.onSort?.(t),
    });
    gridRef.current = grid;
    return () => {
      grid.destroy();
      gridRef.current = null;
      prevData.current = null;
    };
  }, []);

  useImperativeHandle(
    apiRef,
    () => ({
      scrollTo: (r, c) => gridRef.current?.scrollTo(r, c),
      clearSelection: () => gridRef.current?.setSelection(null),
    }),
    [],
  );

  useEffect(() => {
    // New query -> back to top; same query with different open groups -> keep scroll.
    gridRef.current?.setData(data, rows, data !== prevData.current);
    prevData.current = data;
  }, [data, rows]);
  useEffect(() => gridRef.current?.setHeatmap(heatmap), [heatmap]);
  useEffect(() => gridRef.current?.setLinked(linked), [linked]);
  useEffect(() => gridRef.current?.setSort(sort), [sort]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme is the trigger: grid colors come from the mutable GRID theme
  useEffect(() => gridRef.current?.invalidate(), [theme]);

  return <div ref={hostRef} className="grid-host" />;
}
