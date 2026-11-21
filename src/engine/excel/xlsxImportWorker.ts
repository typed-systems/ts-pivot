/// <reference lib="webworker" />
/**
 * Excel (.xlsx / .xlsm) reader, off the main thread.
 *
 * ./xlsxImport.ts reads the workbook (iterative, no recursion, so big sheets are fine),
 * then the sheet is turned into typed Arrow columns and sent back as Arrow IPC
 * bytes (transferred, not copied). DuckDB ingests those directly into `facts`.
 *
 * The opened workbook is kept for the last file, so switching sheets is cheap.
 */

import {
  Bool,
  DateDay,
  Float64,
  Table,
  TimestampMillisecond,
  tableToIPC,
  Utf8,
  type Vector,
  vectorFromArray,
} from "apache-arrow";
import { type Cell, openWorkbook, type Workbook } from "./xlsxImport";

export interface XlsxRequest {
  file: File;
  sheet?: string;
}
export type XlsxResponse =
  | { ok: true; sheets: string[]; sheet: string; rows: number; ipc: Uint8Array }
  | { ok: false; error: string };

let cachedFile: File | null = null;
let cachedBook: Workbook | null = null;

self.onmessage = async (e: MessageEvent<XlsxRequest>) => {
  try {
    const { file, sheet } = e.data;
    if (file !== cachedFile || !cachedBook) {
      cachedBook = null;
      cachedBook = openWorkbook(new Uint8Array(await file.arrayBuffer()));
      cachedFile = file;
    }
    const book = cachedBook;
    const chosen = book.readSheet(sheet);
    const table = sheetToArrow(chosen.rows);
    const ipc = tableToIPC(table, "stream");
    const msg: XlsxResponse = {
      ok: true,
      sheets: book.sheets,
      sheet: chosen.sheet,
      rows: table.numRows,
      ipc,
    };
    (self as DedicatedWorkerGlobalScope).postMessage(msg, [ipc.buffer]);
  } catch (err) {
    const msg: XlsxResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
    (self as DedicatedWorkerGlobalScope).postMessage(msg);
  }
};

/** First non-empty row is the header; every column gets one inferred type. */
function sheetToArrow(data: Cell[][]): Table {
  const start = data.findIndex((r) => r.some((c) => c != null && c !== ""));
  if (start < 0) throw new Error("This sheet is empty.");
  const header = data[start]!;
  const body = data.slice(start + 1).filter((r) => r.some((c) => c != null && c !== ""));
  // A plain loop: `Math.max(...rows)` overflows the call stack on big sheets.
  let width = header.length;
  for (const r of body) if (r.length > width) width = r.length;
  if (body.length === 0) throw new Error("This sheet has a header row but no data rows.");

  const used = new Set<string>();
  const columns: Record<string, Vector> = {};
  for (let c = 0; c < width; c++) {
    let name = String(header[c] ?? "").trim() || `column_${c + 1}`;
    for (let k = 2; used.has(name.toLowerCase()); k++)
      name = `${String(header[c] ?? "").trim() || `column_${c + 1}`}_${k}`;
    used.add(name.toLowerCase());
    columns[name] = toVector(body.map((r) => r[c]));
  }
  return new Table(columns);
}

function toVector(values: (Cell | undefined)[]): Vector {
  const present = values.filter((v) => v != null && v !== "");
  const clean = values.map((v) => (v === "" || v === undefined ? null : v));
  if (present.length > 0 && present.every((v) => typeof v === "number"))
    return vectorFromArray(clean as (number | null)[], new Float64());
  if (present.length > 0 && present.every((v) => typeof v === "boolean"))
    return vectorFromArray(clean as (boolean | null)[], new Bool());
  if (present.length > 0 && present.every((v) => v instanceof Date)) {
    const dates = clean as (Date | null)[];
    // Whole days -> DATE, otherwise TIMESTAMP.
    const dayOnly = dates.every((d) => !d || d.getTime() % 86_400_000 === 0);
    return dayOnly
      ? vectorFromArray(
          dates.map((d) => (d ? d.getTime() : null)),
          new DateDay(),
        )
      : vectorFromArray(
          dates.map((d) => (d ? d.getTime() : null)),
          new TimestampMillisecond(),
        );
  }
  // Mixed or text: keep as strings (dates as ISO dates).
  return vectorFromArray(
    clean.map((v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v))),
    new Utf8(),
  );
}
