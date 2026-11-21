import { exclusive, FACTS, type Field, getConnection, type Schema } from "./duck";

/**
 * Paged, cached access to the raw `facts` rows for the Data view.
 *
 * Rows are fetched in blocks of BLOCK rows by row number (`rowid` ranges, which
 * DuckDB answers without scanning from the start, unlike OFFSET). Sorting
 * materializes a sorted temp copy once (`_raw`), after which paging is just as
 * cheap. Only the blocks the grid asks for are fetched; an LRU keeps memory flat.
 */
export const BLOCK = 512;
const MAX_BLOCKS = 400; // ~200k cached rows

export type SortDir = "asc" | "desc";
export interface RawSort {
  column: string;
  dir: SortDir;
}

/** One block: display strings per column. */
interface Block {
  text: (string | null)[][]; // [col][row]
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const numFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6, useGrouping: false });

export class RawSource {
  readonly fields: Field[];
  readonly rowCount: number;
  private sort: RawSort | null = null;
  private table = FACTS;
  private blocks = new Map<number, Block>();
  private inflight = new Set<number>();
  private generation = 0;
  /** A sorted copy is being built; requests wait until it exists. */
  private sorting = false;
  /** Called when a block arrives, so the grid can redraw. */
  onBlock: (() => void) | null = null;

  constructor(schema: Schema) {
    this.fields = schema.fields;
    this.rowCount = schema.rows;
  }

  get currentSort(): RawSort | null {
    return this.sort;
  }

  /** Re-sort (null = original file order). Resolves once the sorted copy exists. */
  async setSort(sort: RawSort | null): Promise<number> {
    const gen = ++this.generation;
    this.blocks.clear();
    this.inflight.clear();
    const t0 = performance.now();
    if (!sort) {
      this.table = FACTS;
      this.sort = null;
      this.sorting = false;
      this.onBlock?.();
      return performance.now() - t0;
    }
    // Hold block requests until the sorted copy exists: a block fetched now would
    // read the old table but be cached under the new generation.
    this.sorting = true;
    try {
      await exclusive(async () => {
        const conn = await getConnection();
        await conn.query(
          `CREATE OR REPLACE TEMP TABLE _raw AS SELECT * FROM ${FACTS} ORDER BY ${q(sort.column)} ${sort.dir.toUpperCase()} NULLS LAST`,
        );
      });
      if (gen === this.generation) {
        this.table = "_raw";
        this.sort = sort;
      }
    } finally {
      // On failure, table and sort stay as they were; redraw refetches them.
      if (gen === this.generation) this.sorting = false;
      this.onBlock?.();
    }
    return performance.now() - t0;
  }

  /** Cell text, or undefined while its block is loading (the request is started). */
  cell(row: number, col: number): string | null | undefined {
    const b = Math.floor(row / BLOCK);
    const block = this.blocks.get(b);
    if (!block) {
      this.request(b);
      return undefined;
    }
    // LRU touch
    this.blocks.delete(b);
    this.blocks.set(b, block);
    return block.text[col]![row - b * BLOCK];
  }

  private request(b: number) {
    if (this.sorting || this.inflight.has(b) || b * BLOCK >= this.rowCount) return;
    this.inflight.add(b);
    const gen = this.generation;
    const table = this.table;
    const from = b * BLOCK;
    const to = Math.min(this.rowCount, from + BLOCK) - 1;
    const cols = this.fields
      .map((f) => `${f.numeric ? `TRY_CAST(${q(f.name)} AS DOUBLE)` : `CAST(${q(f.name)} AS VARCHAR)`} AS ${q(f.name)}`)
      .join(", ");
    void exclusive(async () => {
      if (gen !== this.generation) return null;
      const conn = await getConnection();
      return conn.query(`SELECT ${cols} FROM ${table} WHERE rowid BETWEEN ${from} AND ${to} ORDER BY rowid`);
    })
      .then((res) => {
        this.inflight.delete(b);
        if (!res || gen !== this.generation) return;
        const text = this.fields.map((f) => {
          const vec = res.getChild(f.name)!;
          const out = new Array<string | null>(res.numRows);
          for (let i = 0; i < res.numRows; i++) {
            const v = vec.get(i) as unknown;
            out[i] = v == null ? null : f.numeric ? numFmt.format(Number(v)) : String(v);
          }
          return out;
        });
        this.blocks.set(b, { text });
        while (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
        this.onBlock?.();
      })
      .catch(() => this.inflight.delete(b));
  }
}

/** UI callbacks for header sorts. */
export interface SortStatus {
  busy(on: boolean): void;
  sorted(sort: RawSort | null): void;
  failed(error: unknown): void;
}

/**
 * Runs header sorts so overlapping clicks behave: only the latest request may
 * report its result or clear the busy state.
 */
export class SortRequests {
  private seq = 0;

  run(source: Pick<RawSource, "setSort">, next: RawSort | null, status: SortStatus): Promise<void> {
    const id = ++this.seq;
    const latest = () => id === this.seq;
    status.busy(true);
    return source
      .setSort(next)
      .then(() => {
        if (latest()) status.sorted(next);
      })
      .catch((e: unknown) => {
        if (latest()) status.failed(e);
      })
      .finally(() => {
        if (latest()) status.busy(false);
      });
  }
}
