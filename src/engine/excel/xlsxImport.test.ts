import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { type Cell, openWorkbook } from "./xlsxImport";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** A one-sheet workbook. Style 1 is a date (built-in numFmt 14), style 0 is General. */
function workbook(sheetData: string, opts: { date1904?: boolean } = {}): Uint8Array {
  return zipSync({
    "xl/workbook.xml": strToU8(
      `<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        (opts.date1904 ? `<workbookPr date1904="1"/>` : "") +
        `<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `<styleSheet xmlns="${NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="${NS}"><sheetData>${sheetData}</sheetData></worksheet>`),
  });
}

function cells(sheetData: string, opts?: { date1904?: boolean }): Cell[] {
  return openWorkbook(workbook(sheetData, opts)).readSheet().rows[0]!;
}

const day = (s: string) => new Date(`${s}T00:00:00Z`);

describe("openWorkbook cell values", () => {
  it("reads an empty numeric <v></v> as empty, not 0", () => {
    const row = cells(
      `<row r="1"><c r="A1"><v>5</v></c><c r="B1"><v></v></c><c r="C1" t="n"><v></v></c><c r="D1"><v>7</v></c></row>`,
    );
    expect(row).toEqual([5, null, null, 7]);
  });

  it("keeps an empty string cell as an empty string", () => {
    expect(cells(`<row r="1"><c r="A1" t="str"><v></v></c></row>`)).toEqual([""]);
  });

  it("reads 1900-system dates before March 1900 on the right day", () => {
    const row = cells(
      `<row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1" s="1"><v>59</v></c><c r="C1" s="1"><v>60.5</v></c></row>`,
    );
    expect(row[0]).toEqual(day("1900-01-01"));
    expect(row[1]).toEqual(day("1900-02-28"));
    // serial 60 is Excel's nonexistent 1900-02-29; it lands on 03-01, half a day in
    expect(row[2]).toEqual(new Date(Date.UTC(1900, 2, 1, 12)));
  });

  it("reads 1900-system dates from March 1900 on", () => {
    const row = cells(`<row r="1"><c r="A1" s="1"><v>61</v></c><c r="B1" s="1"><v>45658</v></c></row>`);
    expect(row[0]).toEqual(day("1900-03-01"));
    expect(row[1]).toEqual(day("2025-01-01"));
  });

  it("reads 1904-system dates", () => {
    const row = cells(`<row r="1"><c r="A1" s="1"><v>0</v></c><c r="B1" s="1"><v>1</v></c></row>`, { date1904: true });
    expect(row[0]).toEqual(day("1904-01-01"));
    expect(row[1]).toEqual(day("1904-01-02"));
  });
});
