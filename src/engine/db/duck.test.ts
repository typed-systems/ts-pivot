import { tableFromArrays, tableToIPC } from "apache-arrow";
import { beforeEach, describe, expect, it } from "vitest";
import { getConnection, sql } from "../../test/nodeDuck";
import { replaceFactsFromArrow } from "./duck";

const ipc = (cols: Record<string, string[] | Float64Array>) => tableToIPC(tableFromArrays(cols), "stream");

async function factsRows(): Promise<string[]> {
  const t = await sql(`SELECT name FROM facts ORDER BY name`);
  const v = t.getChild("name")!;
  return Array.from({ length: t.numRows }, (_, i) => String(v.get(i)));
}

beforeEach(async () => {
  await sql(`CREATE OR REPLACE TABLE facts AS SELECT * FROM (VALUES ('old-a'), ('old-b')) t(name)`);
});

describe("replaceFactsFromArrow", () => {
  it("replaces facts with the new data", async () => {
    await replaceFactsFromArrow(await getConnection(), ipc({ name: ["new"], n: Float64Array.from([1]) }));
    expect(await factsRows()).toEqual(["new"]);
    const tables = await sql(`SELECT table_name FROM duckdb_tables() WHERE table_name = '_facts_stage'`);
    expect(tables.numRows).toBe(0);
  });

  it("keeps the current facts when the insert fails", async () => {
    const conn = await getConnection();
    const failing = {
      query: conn.query,
      insertArrowFromIPCStream: async () => {
        throw new Error("insert failed");
      },
    };
    await expect(replaceFactsFromArrow(failing, ipc({ name: ["new"] }))).rejects.toThrow("insert failed");
    expect(await factsRows()).toEqual(["old-a", "old-b"]);
  });

  it("keeps the current facts when DuckDB rejects the stream", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    // DuckDB "inserts" this without an error and creates no table
    await expect(replaceFactsFromArrow(await getConnection(), garbage)).rejects.toThrow("No data could be read");
    expect(await factsRows()).toEqual(["old-a", "old-b"]);
  });
});
