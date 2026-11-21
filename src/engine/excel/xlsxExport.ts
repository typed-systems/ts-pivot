/**
 * Pivot -> .xlsx, written by hand (no spreadsheet library): a few small XML parts
 * plus one worksheet streamed into a zip with fflate, so even ~1M rows never
 * sit in memory as one big string. Pure code, runs in xlsxExportWorker.ts.
 *
 * Layout, as you see it in the grid:
 *  - one label column per row field (parents repeated, so Excel filters work),
 *    then one column per pivot column and a Total column;
 *  - multi-level column headers with merged group cells, frozen with the labels;
 *  - rows in the current expand/collapse state and sort order, subtotal rows in
 *    bold, with Excel row outline levels so groups can be folded in Excel too;
 *  - a bold grand-total row at the bottom.
 */
import { strToU8, Zip, ZipDeflate } from "fflate";
import { saveBlob } from "../../lib/saveBlob";
import { cellValue, type DisplayRows, rowPath } from "../pivot/display";
import type { PivotResult } from "../pivot/pivot";

export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLS = 16_384;

export interface ExportProgress {
  done: number;
  total: number;
}

// cellXfs indices (see STYLES)
const S_HEAD = 1; // bold, grey fill, bottom border
const S_HEAD_NUM = 2; // same, right aligned (value column headers)
const S_INT = 3;
const S_INT_BOLD = 4;
const S_DEC = 5;
const S_DEC_BOLD = 6;
const S_BOLD = 7;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD3D6DE"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** Spreadsheet column letters, A..XFD. */
function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// XML 1.0 forbids most control characters, even escaped.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const BAD_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
function esc(s: string): string {
  return s
    .replace(BAD_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Sheet names: max 31 chars, none of : \ / ? * [ ] */
export function sheetName(s: string): string {
  return (
    s
      .replace(/[:\\/?*[\]]/g, " ")
      .trim()
      .slice(0, 31) || "Pivot"
  );
}

export function buildPivotXlsx(
  data: PivotResult,
  rows: DisplayRows,
  opts: { sheet: string; onProgress?: (p: ExportProgress) => void },
): Uint8Array {
  const { config } = data;
  const L = config.rows.length; // label columns
  const nc = data.colCount;
  const H = Math.max(1, data.colLabels.length); // header rows
  const nCols = L + nc + 1; // + Total
  const nRows = H + rows.count + 1; // + grand total
  if (nRows > EXCEL_MAX_ROWS)
    throw new Error(
      `${rows.count.toLocaleString()} rows won't fit in Excel (max ${EXCEL_MAX_ROWS.toLocaleString()}). Collapse some groups first.`,
    );
  if (nCols > EXCEL_MAX_COLS) throw new Error(`${nc.toLocaleString()} columns won't fit in Excel (max 16,384).`);

  const cn: string[] = [];
  for (let c = 0; c < nCols; c++) cn.push(colName(c));
  const deepest = data.levels.length - 1;

  // Whole numbers -> #,##0, anything else (avg, decimals) -> #,##0.00
  let integral = true;
  scan: for (const lv of data.levels) {
    for (const arr of [lv.values, lv.totals])
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i]!;
        if (v === v && v !== Math.round(v)) {
          integral = false;
          break scan;
        }
      }
  }
  const sNum = integral ? S_INT : S_DEC;
  const sNumBold = integral ? S_INT_BOLD : S_DEC_BOLD;

  const out: Uint8Array[] = [];
  let failed: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failed = err;
    else out.push(chunk);
  });
  const small = (name: string, xml: string) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(strToU8(xml), true);
  };

  small(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
  );
  small(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  );
  small(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheetName(opts.sheet))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  );
  small(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  small("xl/styles.xml", STYLES);

  // ---- the worksheet, streamed in chunks of rows
  const sheet = new ZipDeflate("xl/worksheets/sheet1.xml", { level: 1 }); // speed over size
  zip.add(sheet);
  const enc = new TextEncoder();
  let buf = "";
  const flush = (final = false) => {
    sheet.push(enc.encode(buf), final);
    buf = "";
  };

  const str = (c: number, r: number, text: string, s = 0) =>
    `<c r="${cn[c]}${r}" t="inlineStr"${s ? ` s="${s}"` : ""}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
  const num = (c: number, r: number, v: number, s: number) =>
    v === v ? `<c r="${cn[c]}${r}" s="${s}"><v>${v}</v></c>` : "";

  // column widths: labels from a sample, values fixed
  const widths: number[] = [];
  for (let l = 0; l < L; l++) {
    let w = config.rows[l]!.length;
    const labels = data.levels[l]!.labels[l]!;
    const step = Math.max(1, Math.floor(labels.length / 2000));
    for (let i = 0; i < labels.length; i += step) w = Math.max(w, labels[i]!.length);
    widths.push(Math.min(60, w + 2));
  }
  let colsXml = "";
  for (let l = 0; l < L; l++) colsXml += `<col min="${l + 1}" max="${l + 1}" width="${widths[l]}" customWidth="1"/>`;
  colsXml += `<col min="${L + 1}" max="${nCols}" width="${integral ? 14 : 16}" customWidth="1"/>`;

  buf +=
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetPr><outlinePr summaryBelow="0"/></sheetPr>` +
    `<dimension ref="A1:${cn[nCols - 1]}${nRows}"/>` +
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane xSplit="${L}" ySplit="${H}" topLeftCell="${cn[L]}${H + 1}" activePane="bottomRight" state="frozen"/>` +
    `<selection pane="bottomRight" activeCell="${cn[L]}${H + 1}" sqref="${cn[L]}${H + 1}"/>` +
    `</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15" outlineLevelRow="${Math.min(7, Math.max(0, deepest))}"/>` +
    `<cols>${colsXml}</cols><sheetData>`;

  // ---- header rows (merged spans for column groups)
  const merges: string[] = [];
  for (let h = 0; h < H; h++) {
    const r = h + 1;
    buf += `<row r="${r}">`;
    for (let l = 0; l < L; l++) {
      // field names on the last header row; above that, what's being aggregated
      const text =
        h === H - 1 ? config.rows[l]! : h === 0 && l === 0 ? `${config.agg} of ${config.measure ?? "rows"}` : "";
      buf += str(l, r, text, S_HEAD);
    }
    if (nc > 0) {
      const labels = data.colLabels[h]!;
      let c = 0;
      while (c < nc) {
        // a group spans while every label from the top down to this level is the same
        let e = c + 1;
        if (h < H - 1) while (e < nc && data.colLabels.slice(0, h + 1).every((lab) => lab[e] === lab[c])) e++;
        buf += str(L + c, r, labels[c] ?? "", h === H - 1 ? S_HEAD_NUM : S_HEAD);
        for (let k = c + 1; k < e; k++) buf += `<c r="${cn[L + k]}${r}" s="${S_HEAD}"/>`;
        if (e - c > 1) merges.push(`${cn[L + c]}${r}:${cn[L + e - 1]}${r}`);
        c = e;
      }
    }
    buf += h === 0 ? str(L + nc, r, "Total", S_HEAD_NUM) : `<c r="${cn[L + nc]}${r}" s="${S_HEAD}"/>`;
    buf += `</row>`;
  }
  if (H > 1) merges.push(`${cn[L + nc]}1:${cn[L + nc]}${H}`);

  // ---- body
  const total = rows.count;
  const every = Math.max(1000, Math.floor(total / 50));
  for (let i = 0; i < total; i++) {
    const r = H + 1 + i;
    const k = rows.level[i]!;
    const group = k < deepest;
    buf += `<row r="${r}"${k > 0 ? ` outlineLevel="${Math.min(7, k)}"` : ""}>`;
    const path = rowPath(data, rows, i);
    for (let l = 0; l <= k; l++) buf += str(l, r, path[l] ?? "", group ? S_BOLD : 0);
    const s = group ? sNumBold : sNum;
    for (let c = 0; c < nc; c++) buf += num(L + c, r, cellValue(data, rows, i, c), s);
    buf += num(L + nc, r, cellValue(data, rows, i, nc), sNumBold);
    buf += `</row>`;
    if (buf.length > 1 << 20) flush();
    if (i % every === 0) opts.onProgress?.({ done: i, total });
  }

  // ---- grand total
  const rt = nRows;
  buf += `<row r="${rt}">${str(0, rt, "Total", S_BOLD)}`;
  for (let c = 0; c < nc; c++) buf += num(L + c, rt, data.colTotals[c]!, sNumBold);
  buf += `${num(L + nc, rt, data.grandTotal, sNumBold)}</row></sheetData>`;
  if (merges.length)
    buf += `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`;
  buf += `</worksheet>`;
  flush(true);
  zip.end();
  if (failed) throw failed;
  opts.onProgress?.({ done: total, total });

  let size = 0;
  for (const c of out) size += c.length;
  const file = new Uint8Array(size);
  let at = 0;
  for (const c of out) {
    file.set(c, at);
    at += c.length;
  }
  return file;
}

// ------------------------------------------------------------- main thread

/**
 * Build the file in a worker and hand it to the browser as a download.
 * `onProgress` gets 0..1. The data is copied to the worker, so the UI keeps
 * its own arrays.
 */
export function downloadPivotXlsx(
  data: PivotResult,
  rows: DisplayRows,
  fileName: string,
  sheet: string,
  onProgress?: (p: number) => void,
): Promise<void> {
  const worker = new Worker(new URL("./xlsxExportWorker.ts", import.meta.url), { type: "module" });
  return new Promise<void>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<import("./xlsxExportWorker").ExportResponse>) => {
      const m = e.data;
      if (m.kind === "progress") onProgress?.(m.total ? m.done / m.total : 1);
      else {
        worker.terminate();
        if (m.kind === "error") return reject(new Error(m.error));
        const blob = new Blob([m.bytes as BlobPart], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        saveBlob(blob, fileName);
        resolve();
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "export failed"));
    };
    worker.postMessage({ data, rows, sheet });
  });
}
