import { useEffect, useRef } from "react";
import type { RawSource } from "../../engine/db/raw";
import { CanvasDataGrid } from "./CanvasDataGrid";

/** Thin React shell around the imperative raw-data canvas grid. */
export function DataGrid({
  source,
  onSort,
  theme,
}: {
  source: RawSource | null;
  onSort: (column: string) => void;
  /** Colors come from the live theme; a change just forces a redraw. */
  theme?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<CanvasDataGrid | null>(null);
  const prev = useRef<RawSource | null>(null);
  const sortRef = useRef(onSort);
  useEffect(() => {
    sortRef.current = onSort;
  });

  useEffect(() => {
    const grid = new CanvasDataGrid(hostRef.current!, { onSort: (c) => sortRef.current(c) });
    gridRef.current = grid;
    return () => {
      grid.destroy();
      gridRef.current = null;
      prev.current = null;
    };
  }, []);

  useEffect(() => {
    gridRef.current?.setSource(source, source !== prev.current);
    prev.current = source;
  }, [source]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme is the trigger: grid colors come from the mutable GRID theme
  useEffect(() => gridRef.current?.invalidate(), [theme]);

  return <div ref={hostRef} className="grid-host" />;
}
