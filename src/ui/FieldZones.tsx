import { type DragEvent, useRef, useState } from "react";
import type { Field } from "../engine/db/duck";
import type { Zone } from "../engine/pivot/config";

export type { Zone };

interface Props {
  fields: Field[];
  rows: string[];
  cols: string[];
  /** Move `name` into `zone` at position `index` (removing it from wherever it was). */
  onMove: (name: string, zone: Zone, index: number) => void;
}

const MIME = "application/x-pivot-field";

/**
 * Drag-and-drop field lists (native HTML5 DnD, no library).
 * Drag between Fields / Rows / Columns, or reorder inside a zone.
 * Double-click a field to add it to Rows; double-click a placed one to remove it.
 */
export function FieldZones({ fields, rows, cols, onMove }: Props) {
  const placed = new Set([...rows, ...cols]);
  const available = fields.map((f) => f.name).filter((n) => !placed.has(n));
  const typeOf = new Map(fields.map((f) => [f.name, f]));

  return (
    <div className="zones">
      <DropZone
        zone="fields"
        label="Fields"
        names={available}
        typeOf={typeOf}
        onMove={onMove}
      />
      <DropZone
        zone="rows"
        label="Rows"
        names={rows}
        typeOf={typeOf}
        onMove={onMove}
      />
      <DropZone
        zone="cols"
        label="Columns"
        names={cols}
        typeOf={typeOf}
        onMove={onMove}
      />
    </div>
  );
}

function DropZone({
  zone,
  label,
  names,
  typeOf,
  onMove,
}: {
  zone: Zone;
  label: string;
  names: string[];
  typeOf: Map<string, Field>;
  onMove: Props["onMove"];
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);

  // Insert position = before the first chip whose centre is right of the pointer.
  const indexAt = (e: DragEvent) => {
    const chips =
      listRef.current?.querySelectorAll<HTMLElement>("[data-chip]") ?? [];
    let i = 0;
    for (const chip of chips) {
      const r = chip.getBoundingClientRect();
      const before =
        e.clientY < r.top
          ? true
          : e.clientY > r.bottom
            ? false
            : e.clientX < r.left + r.width / 2;
      if (before) return i;
      i++;
    }
    return chips.length;
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setInsertAt(indexAt(e));
  };

  const onDrop = (e: DragEvent) => {
    const name = e.dataTransfer.getData(MIME);
    setInsertAt(null);
    if (!name) return;
    e.preventDefault();
    onMove(name, zone, indexAt(e));
  };

  return (
    <fieldset
      aria-label={`${label} fields`}
      className={`zone zone-${zone}${insertAt !== null ? " over" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setInsertAt(null);
      }}
      onDrop={onDrop}
    >
      <span className="zone-label">{label}</span>
      <div className="zone-list" ref={listRef}>
        {names.map((n, i) => {
          const f = typeOf.get(n);
          const activate = () =>
            zone === "fields"
              ? onMove(n, "rows", Number.MAX_SAFE_INTEGER)
              : onMove(n, "fields", 0);
          return (
            <span key={n} className="chip-wrap">
              {insertAt === i && <span className="insert-mark" />}
              <button
                type="button"
                data-chip
                className={`chip${f?.numeric ? " numeric" : ""}`}
                draggable
                title={`${n} · ${f?.type ?? ""}${zone === "fields" ? " — drag to Rows/Columns, or double-click / Enter" : " — drag to move, double-click / Enter to remove"}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(MIME, n);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDoubleClick={activate}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate();
                  }
                }}
              >
                {zone !== "fields" && <span className="chip-ord">{i + 1}</span>}
                {n}
              </button>
            </span>
          );
        })}
        {insertAt === names.length && <span className="insert-mark" />}
        {names.length === 0 && (
          <span className="zone-empty">
            {zone === "fields" ? "all fields placed" : "drop fields here"}
          </span>
        )}
      </div>
    </fieldset>
  );
}
