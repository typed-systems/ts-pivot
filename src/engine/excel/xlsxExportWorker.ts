/// <reference lib="webworker" />
/**
 * Writes the pivot as .xlsx off the main thread (see xlsxExport.ts), posting
 * progress as it goes; the finished file is transferred back, not copied.
 */

import type { DisplayRows } from "../pivot/display";
import type { PivotResult } from "../pivot/pivot";
import { buildPivotXlsx } from "./xlsxExport";

export interface ExportRequest {
  data: PivotResult;
  rows: DisplayRows;
  sheet: string;
}
export type ExportResponse =
  | { kind: "progress"; done: number; total: number }
  | { kind: "done"; bytes: Uint8Array }
  | { kind: "error"; error: string };

self.onmessage = (e: MessageEvent<ExportRequest>) => {
  const post = (m: ExportResponse, transfer: Transferable[] = []) => self.postMessage(m, { transfer });
  try {
    const { data, rows, sheet } = e.data;
    const bytes = buildPivotXlsx(data, rows, {
      sheet,
      onProgress: (p) => post({ kind: "progress", ...p }),
    });
    post({ kind: "done", bytes }, [bytes.buffer]);
  } catch (err) {
    post({ kind: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
