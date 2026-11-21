/**
 * Test stand-in for src/engine/db/duck.ts: the same exports, backed by the
 * synchronous Node build of DuckDB-WASM (no Web Worker, no Vite `?url` imports).
 *
 *   vi.mock("../db/duck", () => import("../../test/nodeDuck"));
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Table } from "apache-arrow";

const require = createRequire(import.meta.url);
type NodeDuckDB = typeof import("@duckdb/duckdb-wasm/blocking");
const duckdb = require("@duckdb/duckdb-wasm/blocking") as NodeDuckDB;
const dist = dirname(require.resolve("@duckdb/duckdb-wasm/blocking"));

export const FACTS = "facts";

type Conn = ReturnType<Awaited<ReturnType<NodeDuckDB["createDuckDB"]>>["connect"]>;
let connPromise: Promise<Conn> | null = null;

async function conn(): Promise<Conn> {
  connPromise ??= (async () => {
    const db = await duckdb.createDuckDB(
      {
        mvp: { mainModule: join(dist, "duckdb-mvp.wasm"), mainWorker: "" },
        eh: { mainModule: join(dist, "duckdb-eh.wasm"), mainWorker: "" },
      },
      new duckdb.VoidLogger(),
      duckdb.NODE_RUNTIME,
    );
    await db.instantiate();
    return db.connect();
  })();
  return connPromise;
}

/** Async-shaped connection, like AsyncDuckDBConnection for the calls the app makes. */
export async function getConnection() {
  const c = await conn();
  return {
    query: async (sql: string): Promise<Table> => c.query(sql) as unknown as Table,
    insertArrowFromIPCStream: async (buffer: Uint8Array, options: { name: string; create: boolean }) =>
      c.insertArrowFromIPCStream(buffer, options),
  };
}

/** Run SQL directly (test setup). */
export async function sql(text: string): Promise<Table> {
  return (await getConnection()).query(text);
}

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

export async function queryCancellable(text: string, signal?: AbortSignal): Promise<Table> {
  if (signal?.aborted) throw new CancelledError();
  const res = await sql(text);
  if (signal?.aborted) throw new CancelledError();
  return res;
}
