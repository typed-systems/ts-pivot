import * as duckdb from "@duckdb/duckdb-wasm";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import { Table } from "apache-arrow";

/**
 * DuckDB-WASM runs inside its own Web Worker. Queries are async and results
 * come back as Arrow tables (columnar typed arrays), so the main thread never
 * does the heavy aggregation work.
 *
 * Everything pivots over one table: `facts` (sample data or a loaded file).
 */
export const FACTS = "facts";

interface Duck {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
}
let duckPromise: Promise<Duck> | null = null;

function getDuck(): Promise<Duck> {
  duckPromise ??= (async () => {
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
      eh: { mainModule: ehWasm, mainWorker: ehWorker },
    });
    const worker = new Worker(bundle.mainWorker!);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return { db, conn: await db.connect() };
  })();
  return duckPromise;
}

export async function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
  return (await getDuck()).conn;
}

/**
 * One connection, many multi-statement jobs (pivots use temp tables, loading
 * replaces the fact table). Jobs run strictly one after another.
 */
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job);
  queue = next.catch(() => undefined);
  return next;
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

/**
 * Run SQL through the *pending query* API (`conn.send`). DuckDB-WASM executes
 * it in small steps, polling between them, so `cancelSent()` can stop it
 * part-way, unlike `conn.query`, which runs to completion.
 */
export async function queryCancellable(sql: string, signal?: AbortSignal): Promise<Table> {
  const conn = await getConnection();
  if (signal?.aborted) throw new CancelledError();
  const onAbort = () => void conn.cancelSent();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const reader = await conn.send(sql);
    const batches = [];
    if (reader) for await (const batch of reader) batches.push(batch);
    if (signal?.aborted) throw new CancelledError();
    return new Table(batches);
  } catch (e) {
    if (signal?.aborted) throw new CancelledError();
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

// ------------------------------------------------------------------ schema

export type FieldKind = "dimension" | "measure";
export interface Field {
  name: string;
  type: string; // DuckDB type name
  numeric: boolean;
}
export interface Schema {
  source: string; // human label of what is loaded
  rows: number;
  fields: Field[];
  /** Excel only: all sheet names and the one that is loaded. */
  sheets?: string[];
  sheet?: string;
}

const NUMERIC =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL.*)$/i;

async function describe(source: string): Promise<Schema> {
  const conn = await getConnection();
  const d = await conn.query(`DESCRIBE ${FACTS}`);
  const names = d.getChild("column_name")!;
  const types = d.getChild("column_type")!;
  const fields: Field[] = [];
  for (let i = 0; i < d.numRows; i++) {
    const type = String(types.get(i));
    fields.push({ name: String(names.get(i)), type, numeric: NUMERIC.test(type) });
  }
  const n = await conn.query(`SELECT count(*)::DOUBLE AS n FROM ${FACTS}`);
  return { source, rows: Number(n.getChild("n")!.get(0)), fields };
}

// ------------------------------------------------------------------ loading

/** Synthetic sales fact table, generated entirely inside DuckDB. */
export function loadSampleData(rows: number): Promise<{ schema: Schema; ms: number }> {
  return exclusive(async () => {
    const conn = await getConnection();
    const t0 = performance.now();
    await conn.query(`
    CREATE OR REPLACE TABLE facts AS
    WITH base AS (
      SELECT
        i,
        hash(i)        AS h1,
        hash(i * 7)    AS h2,
        hash(i * 13)   AS h3,
        hash(i * 31)   AS h4,
        hash(i * 101)  AS h5
      FROM range(${Math.floor(rows)}) t(i)
    ), d AS (
      SELECT
        (h1 % 24)::INTEGER                                   AS country_id,
        (h2 % 400)::INTEGER                                  AS product_id,
        DATE '2022-01-01' + (h3 % 1461)::INTEGER             AS dt,
        (h4 % 4)::INTEGER                                    AS channel_id,
        'Customer ' || lpad((h5 % 100000)::VARCHAR, 6, '0')  AS customer,
        1 + (h3 % 20)::INTEGER                               AS units,
        round(5 + (h4 % 50000) / 100.0, 2)                   AS price,
        0.45 + (h1 % 40) / 100.0                             AS cost_ratio
      FROM base
    )
    SELECT
      (['Nordics','Nordics','Nordics','Nordics','DACH','DACH','DACH','Benelux','Benelux','UK & IE','UK & IE','Iberia',
        'Iberia','Italy','France','CEE','CEE','CEE','North America','North America','LATAM','LATAM','APAC','APAC'])[country_id + 1] AS region,
      (['Norway','Sweden','Denmark','Finland','Germany','Austria','Switzerland','Netherlands','Belgium','United Kingdom','Ireland','Spain',
        'Portugal','Italy','France','Poland','Czechia','Hungary','United States','Canada','Brazil','Mexico','Japan','Australia'])[country_id + 1] AS country,
      (['Sensors','Cameras','Lighting','Software','Services','Cables','Mounts','Storage','Compute','Networking','Power','Accessories'])[product_id % 12 + 1] AS category,
      'SKU-' || lpad(product_id::VARCHAR, 4, '0')            AS product,
      (['Direct','Partner','Online','Marketplace'])[channel_id + 1] AS channel,
      year(dt)::VARCHAR                                      AS year,
      year(dt)::VARCHAR || '-Q' || quarter(dt)::VARCHAR      AS quarter,
      strftime(dt, '%Y-%m')                                  AS month,
      customer,
      units,
      round(units * price, 2)                                AS revenue,
      round(units * price * (1 - cost_ratio), 2)             AS profit
    FROM d
  `);
    const ms = performance.now() - t0;
    return { schema: await describe("sample data"), ms };
  });
}

/**
 * Load a user file. The browser File is registered as a lazily-read handle
 * (no upfront copy into WASM memory), then materialized into `facts`.
 */
export const EXCEL = /\.(xlsx|xlsm)$/i;
export const ACCEPT = ".parquet,.csv,.tsv,.txt,.json,.ndjson,.jsonl,.xlsx,.xlsm";

export function loadFile(file: File, sheet?: string): Promise<{ schema: Schema; ms: number }> {
  if (EXCEL.test(file.name)) return loadExcel(file, sheet);
  if (/\.xls$/i.test(file.name))
    return Promise.reject(new Error("Old .xls files aren't supported. Save the workbook as .xlsx and open that."));
  return exclusive(async () => {
    const { db, conn } = await getDuck();
    const t0 = performance.now();
    const name = file.name.replace(/[^\w.-]/g, "_");
    await db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    const lower = name.toLowerCase();
    const reader = lower.endsWith(".parquet")
      ? "read_parquet"
      : lower.endsWith(".json") || lower.endsWith(".ndjson") || lower.endsWith(".jsonl")
        ? "read_json_auto"
        : "read_csv_auto";
    await conn.query(`CREATE OR REPLACE TABLE ${FACTS} AS SELECT * FROM ${reader}('${name.replace(/'/g, "''")}')`);
    const ms = performance.now() - t0;
    return { schema: await describe(file.name), ms };
  });
}

// ------------------------------------------------------------------ Excel

let xlsxWorker: Worker | null = null;

/** Parse in a worker (see xlsxWorker.ts), then load the Arrow bytes into DuckDB. */
function parseExcel(file: File, sheet?: string): Promise<{ sheets: string[]; sheet: string; ipc: Uint8Array }> {
  xlsxWorker ??= new Worker(new URL("../excel/xlsxImportWorker.ts", import.meta.url), { type: "module" });
  const w = xlsxWorker;
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<import("../excel/xlsxImportWorker").XlsxResponse>) => {
      const r = e.data;
      if (r.ok) resolve(r);
      else reject(new Error(`Couldn't read ${file.name}: ${r.error}`));
    };
    w.onerror = (e) => reject(new Error(`Couldn't read ${file.name}: ${e.message}`));
    w.postMessage({ file, sheet });
  });
}

/** The connection calls `replaceFactsFromArrow` needs. */
export interface ArrowLoader {
  query(sql: string): Promise<unknown>;
  insertArrowFromIPCStream(buffer: Uint8Array, options: { name: string; create: boolean }): Promise<void>;
}

/**
 * Replace `facts` with an Arrow IPC stream. The data goes into a staging table
 * first, so if the insert fails the current `facts` stays loaded and usable.
 */
export async function replaceFactsFromArrow(conn: ArrowLoader, ipc: Uint8Array): Promise<void> {
  const STAGE = "_facts_stage";
  await conn.query(`DROP TABLE IF EXISTS ${STAGE}`);
  try {
    await conn.insertArrowFromIPCStream(ipc, { name: STAGE, create: true });
  } catch (e) {
    await conn.query(`DROP TABLE IF EXISTS ${STAGE}`).catch(() => {});
    throw e;
  }
  // A stream DuckDB can't read may "insert" without error and create nothing.
  const staged = (await conn.query(
    `SELECT 1 FROM duckdb_tables() WHERE table_name = '${STAGE}' AND NOT temporary`,
  )) as { numRows: number };
  if (staged.numRows === 0) throw new Error("No data could be read from the sheet.");
  // Swap in one transaction: if anything fails, the old facts table is kept.
  await conn.query("BEGIN TRANSACTION");
  try {
    await conn.query(`DROP TABLE IF EXISTS ${FACTS}`);
    await conn.query(`ALTER TABLE ${STAGE} RENAME TO ${FACTS}`);
    await conn.query("COMMIT");
  } catch (e) {
    await conn.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

function loadExcel(file: File, sheet?: string): Promise<{ schema: Schema; ms: number }> {
  return exclusive(async () => {
    const conn = await getConnection();
    const t0 = performance.now();
    const parsed = await parseExcel(file, sheet);
    await replaceFactsFromArrow(conn, parsed.ipc);
    const ms = performance.now() - t0;
    const label = parsed.sheets.length > 1 ? `${file.name} › ${parsed.sheet}` : file.name;
    const schema = await describe(label);
    return { schema: { ...schema, sheets: parsed.sheets, sheet: parsed.sheet }, ms };
  });
}
