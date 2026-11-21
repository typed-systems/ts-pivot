/**
 * Small, iterative .xlsx/.xlsm reader (fflate for the zip, hand-rolled XML scanning).
 *
 * Written instead of using read-excel-file, whose parser recurses once per XML
 * chunk and overflows the call stack on large sheets (~100k+ rows).
 * Everything here is loops and indexOf, so sheet size is limited by memory only.
 *
 * Handles: namespace-prefixed XML, shared strings (incl. rich text), inline strings, numbers, booleans,
 * formula string results, errors (-> null), ISO dates (t="d"), and numbers in
 * date/time formats (-> Date, 1900 and 1904 date systems).
 */
import { strFromU8 as rawStr, unzipSync } from "fflate";

/**
 * Some exporters (e.g. the OpenXML SDK) write the SpreadsheetML namespace with a
 * prefix: <x:sheetData><x:row><x:c>. Strip that prefix so the scanner below only
 * has to know the plain tag names.
 */
function strFromU8(bytes: Uint8Array): string {
  const xml = rawStr(bytes);
  const m = /xmlns:([A-Za-z_][\w.-]*)="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/.exec(
    xml.slice(0, 4096),
  );
  if (!m) return xml;
  const p = m[1]!;
  return xml.split(`<${p}:`).join("<").split(`</${p}:`).join("</");
}

export type Cell = string | number | boolean | Date | null;

export interface Workbook {
  sheets: string[];
  /** Rows of the named sheet (or the first sheet with data). */
  readSheet(name?: string): { sheet: string; rows: Cell[][] };
}

export function openWorkbook(bytes: Uint8Array): Workbook {
  // Only inflate the small metadata parts now; sheets are inflated on demand.
  const meta = unzipSync(bytes, {
    filter: (f) =>
      f.name === "xl/workbook.xml" ||
      f.name === "xl/_rels/workbook.xml.rels" ||
      f.name === "xl/sharedStrings.xml" ||
      f.name === "xl/styles.xml",
  });
  const workbookXml = meta["xl/workbook.xml"];
  if (!workbookXml) throw new Error("Not an .xlsx workbook (xl/workbook.xml is missing).");
  const wb = strFromU8(workbookXml);
  const rels = meta["xl/_rels/workbook.xml.rels"] ? strFromU8(meta["xl/_rels/workbook.xml.rels"]) : "";
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb);

  // sheet name -> zip path
  const relTarget = new Map<string, string>();
  for (const tag of tags(rels, "Relationship")) {
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (id && target) relTarget.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const sheetPaths: { name: string; path: string }[] = [];
  for (const tag of tags(wb, "sheet")) {
    const name = decodeXml(attr(tag, "name") ?? "");
    const rid = attr(tag, "r:id") ?? attr(tag, "id");
    const path = rid ? relTarget.get(rid) : undefined;
    if (name && path) sheetPaths.push({ name, path });
  }
  if (sheetPaths.length === 0) throw new Error("The workbook has no sheets.");

  const shared = meta["xl/sharedStrings.xml"] ? parseSharedStrings(strFromU8(meta["xl/sharedStrings.xml"])) : [];
  const dateStyles = meta["xl/styles.xml"] ? parseDateStyles(strFromU8(meta["xl/styles.xml"])) : new Set<number>();

  const cache = new Map<string, Cell[][]>();
  const load = (path: string) => {
    let rows = cache.get(path);
    if (!rows) {
      const part = unzipSync(bytes, { filter: (f) => f.name === path })[path];
      if (!part) throw new Error(`Sheet part ${path} is missing.`);
      rows = parseSheet(strFromU8(part), shared, dateStyles, date1904);
      cache.clear(); // keep only one parsed sheet in memory
      cache.set(path, rows);
    }
    return rows;
  };

  return {
    sheets: sheetPaths.map((s) => s.name),
    readSheet(name) {
      const pick = sheetPaths.find((s) => s.name === name);
      if (pick) return { sheet: pick.name, rows: load(pick.path) };
      for (const s of sheetPaths) {
        const rows = load(s.path);
        if (rows.some((r) => r.some((c) => c != null && c !== ""))) return { sheet: s.name, rows };
      }
      return { sheet: sheetPaths[0]!.name, rows: load(sheetPaths[0]!.path) };
    },
  };
}

// ------------------------------------------------------------------ sheet

function parseSheet(xml: string, shared: string[], dateStyles: Set<number>, date1904: boolean): Cell[][] {
  const rows: Cell[][] = [];
  const start = xml.indexOf("<sheetData");
  if (start < 0) return rows;
  let i = start;
  let rowIdx = -1;
  let nextCol = 0;
  let row: Cell[] | null = null;

  for (;;) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    const ch = xml.charCodeAt(lt + 1);
    if (xml.startsWith("</sheetData", lt)) break;

    if (ch === 114 /* r */ && xml.startsWith("<row", lt) && isNameEnd(xml.charCodeAt(lt + 4))) {
      const gt = xml.indexOf(">", lt);
      const tag = xml.slice(lt, gt + 1);
      const r = attr(tag, "r");
      rowIdx = r ? Number(r) - 1 : rowIdx + 1;
      nextCol = 0;
      row = [];
      while (rows.length < rowIdx) rows.push([]);
      rows[rowIdx] = row;
      i = gt + 1;
      continue;
    }

    if (ch === 99 /* c */ && isNameEnd(xml.charCodeAt(lt + 2))) {
      const gt = xml.indexOf(">", lt);
      const tag = xml.slice(lt, gt + 1);
      const ref = attr(tag, "r");
      const col = ref ? colIndex(ref) : nextCol;
      nextCol = col + 1;
      const selfClosing = xml.charCodeAt(gt - 1) === 47; /* / */
      let end = gt + 1;
      let value: Cell = null;
      if (!selfClosing) {
        const close = xml.indexOf("</c>", gt);
        end = close + 4;
        const inner = xml.slice(gt + 1, close);
        value = cellValue(attr(tag, "t"), Number(attr(tag, "s") ?? 0), inner, shared, dateStyles, date1904);
      }
      if (!row) {
        // <c> outside <row>: shouldn't happen, but don't drop data
        rowIdx++;
        row = [];
        rows[rowIdx] = row;
      }
      if (value !== null) row[col] = value;
      i = end;
      continue;
    }
    i = lt + 1;
  }
  // holes -> null
  for (let r = 0; r < rows.length; r++) {
    let a = rows[r];
    if (!a) {
      a = [];
      rows[r] = a;
    }
    for (let c = 0; c < a.length; c++) if (a[c] === undefined) a[c] = null;
  }
  return rows;
}

function cellValue(
  t: string | undefined,
  style: number,
  inner: string,
  shared: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): Cell {
  if (t === "inlineStr") return textOf(inner);
  const v = between(inner, "<v>", "</v>") ?? between(inner, "<v ", "</v>")?.replace(/^[^>]*>/, "");
  if (v == null || (v === "" && t !== "s" && t !== "str")) return t === "s" || t === "str" ? "" : null;
  switch (t) {
    case "s":
      return shared[Number(v)] ?? "";
    case "str":
      return decodeXml(v);
    case "b":
      return v === "1" || v === "true";
    case "e":
      return null; // #N/A, #DIV/0! ...
    case "d": {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? v : d;
    }
    default: {
      const n = Number(v);
      if (Number.isNaN(n)) return decodeXml(v);
      return dateStyles.has(style) ? serialToDate(n, date1904) : n;
    }
  }
}

/** Excel serial day -> UTC Date. */
function serialToDate(serial: number, date1904: boolean): Date {
  // 1900 system: serials from 61 (1900-03-01) on count the nonexistent 1900-02-29,
  // so they use the 1899-12-30 epoch; earlier serials use 1899-12-31.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : serial < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  return new Date(Math.round(epoch + serial * 86_400_000));
}

// ------------------------------------------------------------------ shared strings & styles

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const s = xml.indexOf("<si", i);
    if (s < 0) break;
    const gt = xml.indexOf(">", s);
    if (xml.charCodeAt(gt - 1) === 47) {
      out.push("");
      i = gt + 1;
      continue;
    }
    const e = xml.indexOf("</si>", gt);
    out.push(textOf(xml.slice(gt + 1, e)));
    i = e + 5;
  }
  return out;
}

/** Concatenate all <t> runs, skipping phonetic (<rPh>) runs. */
function textOf(inner: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const t = inner.indexOf("<t", i);
    if (t < 0) break;
    const next = inner.charCodeAt(t + 2);
    if (next !== 62 /* > */ && next !== 32 /* space */) {
      i = t + 2;
      continue;
    }
    const gt = inner.indexOf(">", t);
    const rph = inner.lastIndexOf("<rPh", t);
    const rphEnd = rph >= 0 ? inner.indexOf("</rPh>", rph) : -1;
    const e = inner.indexOf("</t>", gt);
    if (inner.charCodeAt(gt - 1) !== 47 && !(rph >= 0 && rphEnd > t)) out += inner.slice(gt + 1, e);
    i = e < 0 ? gt + 1 : e + 4;
  }
  return decodeXml(out);
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56,
  57, 58,
]);

/** Indices into cellXfs whose number format is a date/time format. */
function parseDateStyles(xml: string): Set<number> {
  const custom = new Map<number, string>();
  for (const tag of tags(xml, "numFmt")) {
    const id = Number(attr(tag, "numFmtId"));
    custom.set(id, decodeXml(attr(tag, "formatCode") ?? ""));
  }
  const out = new Set<number>();
  const xfs = between(xml, "<cellXfs", "</cellXfs>");
  if (!xfs) return out;
  let idx = 0;
  for (const tag of tags(xfs, "xf")) {
    const id = Number(attr(tag, "numFmtId") ?? 0);
    const code = custom.get(id);
    if (code !== undefined ? isDateFormat(code) : BUILTIN_DATE_FORMATS.has(id)) out.add(idx);
    idx++;
  }
  return out;
}

function isDateFormat(code: string): boolean {
  const c = code
    .replace(/"[^"]*"/g, "") // quoted literals
    .replace(/\[[^\]]*\]/g, "") // [Red], [$-409], [h] handled as h below
    .replace(/\\./g, "") // escaped chars
    .toLowerCase();
  if (c === "general" || c === "@") return false;
  return /[dmyhs]/.test(c) && !/^[#0.,%e+\-\s]*$/.test(c);
}

// ------------------------------------------------------------------ tiny XML helpers

function isNameEnd(code: number) {
  return code === 32 || code === 62 || code === 47 || code === 9 || code === 10 || code === 13;
}

/** All start tags `<name ...>` (also self-closing) in a string. */
function* tags(xml: string, name: string): Generator<string> {
  const open = `<${name}`;
  let i = 0;
  for (;;) {
    const s = xml.indexOf(open, i);
    if (s < 0) return;
    if (!isNameEnd(xml.charCodeAt(s + open.length))) {
      i = s + open.length;
      continue;
    }
    const e = xml.indexOf(">", s);
    yield xml.slice(s, e + 1);
    i = e + 1;
  }
}

function attr(tag: string, name: string): string | undefined {
  let i = 0;
  for (;;) {
    const at = tag.indexOf(`${name}=`, i);
    if (at < 0) return undefined;
    const prev = tag.charCodeAt(at - 1);
    if (prev === 32 || prev === 9 || prev === 10 || prev === 13) {
      const q = tag[at + name.length + 1];
      const end = tag.indexOf(q!, at + name.length + 2);
      return tag.slice(at + name.length + 2, end);
    }
    i = at + 1;
  }
}

function between(s: string, a: string, b: string): string | undefined {
  const i = s.indexOf(a);
  if (i < 0) return undefined;
  const j = s.indexOf(b, i + a.length);
  return j < 0 ? undefined : s.slice(i + a.length, j);
}

function colIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s: string): string {
  if (s.indexOf("&") < 0 && s.indexOf("_x") < 0) return s;
  return s
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) =>
      e[0] === "#"
        ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
        : (ENTITIES[e] ?? m),
    )
    .replace(/_x([0-9a-fA-F]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}
