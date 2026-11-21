import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fake connection: every SQL string is recorded. Sorts (CREATE ... _raw) wait
 * until the test settles them, so the window while a sort runs can be probed.
 * SELECTs answer with one row per requested rowid, tagged with the table name.
 */
const db = vi.hoisted(() => {
  type Pending = { resolve: () => void; reject: (e: Error) => void };
  const state = {
    log: [] as string[],
    sorts: [] as Pending[],
    reset() {
      state.log = [];
      state.sorts = [];
    },
  };
  const query = (sql: string) => {
    state.log.push(sql);
    if (sql.includes("_raw AS")) return new Promise<void>((resolve, reject) => state.sorts.push({ resolve, reject }));
    const m = /FROM (\w+) WHERE rowid BETWEEN (\d+) AND (\d+)/.exec(sql);
    if (!m) throw new Error(`unexpected SQL: ${sql}`);
    const [, table, from, to] = m;
    const n = Number(to) - Number(from) + 1;
    return Promise.resolve({ numRows: n, getChild: () => ({ get: (i: number) => `${table}:${Number(from) + i}` }) });
  };
  return { state, query };
});

vi.mock("./duck", () => {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    FACTS: "facts",
    getConnection: async () => ({ query: db.query }),
    exclusive<T>(job: () => Promise<T>): Promise<T> {
      const next = queue.then(job);
      queue = next.catch(() => undefined);
      return next;
    },
  };
});

import { type RawSort, RawSource, SortRequests } from "./raw";

const schema = { source: "t", rows: 1000, fields: [{ name: "name", type: "VARCHAR", numeric: false }] };
const flush = () => new Promise((r) => setTimeout(r, 0));
const selects = () => db.state.log.filter((s) => s.startsWith("SELECT"));

/** Read cell (row, 0), letting any request it starts complete. */
async function read(src: RawSource, row: number) {
  const first = src.cell(row, 0);
  if (first !== undefined) return first;
  await flush();
  return src.cell(row, 0);
}

beforeEach(() => db.state.reset());

describe("RawSource sorting", () => {
  it("fetches no rows while a sort is being built, then reads the sorted table", async () => {
    const src = new RawSource(schema);
    const sorting = src.setSort({ column: "name", dir: "asc" });
    await flush();
    expect(db.state.sorts).toHaveLength(1);

    // a redraw (hover, scroll) during the sort
    expect(src.cell(0, 0)).toBeUndefined();
    await flush();
    expect(selects()).toEqual([]);
    expect(src.currentSort).toBeNull();

    db.state.sorts[0]!.resolve();
    await sorting;
    expect(src.currentSort).toEqual({ column: "name", dir: "asc" });
    expect(await read(src, 0)).toBe("_raw:0");
    expect(selects().every((s) => s.includes("FROM _raw"))).toBe(true);
  });

  it("keeps the old sort and table when the sort fails", async () => {
    const src = new RawSource(schema);
    const onBlock = vi.fn();
    src.onBlock = onBlock;
    const sorting = src.setSort({ column: "name", dir: "desc" });
    await flush();
    db.state.sorts[0]!.reject(new Error("out of memory"));

    await expect(sorting).rejects.toThrow("out of memory");
    expect(src.currentSort).toBeNull();
    expect(onBlock).toHaveBeenCalled(); // the grid redraws and refetches
    expect(await read(src, 0)).toBe("facts:0");
  });

  it("applies only the latest of two overlapping sorts", async () => {
    const src = new RawSource(schema);
    const first = src.setSort({ column: "name", dir: "asc" });
    const second = src.setSort({ column: "name", dir: "desc" });
    await flush();
    db.state.sorts[0]!.resolve();
    await first;
    // the first sort finished, but the second is still running: still no fetches
    expect(src.currentSort).toBeNull();
    expect(src.cell(0, 0)).toBeUndefined();
    await flush();
    expect(selects()).toEqual([]);

    db.state.sorts[1]!.resolve();
    await second;
    expect(src.currentSort).toEqual({ column: "name", dir: "desc" });
    expect(await read(src, 0)).toBe("_raw:0");
  });

  it("goes back to file order without waiting", async () => {
    const src = new RawSource(schema);
    const sorting = src.setSort({ column: "name", dir: "asc" });
    await flush();
    db.state.sorts[0]!.resolve();
    await sorting;

    await src.setSort(null);
    expect(src.currentSort).toBeNull();
    expect(await read(src, 600)).toBe("facts:600");
  });
});

describe("SortRequests", () => {
  /** A source whose sorts finish (or fail) when the test says so. */
  function controlledSource() {
    const pending: { resolve: (ms: number) => void; reject: (e: Error) => void }[] = [];
    return {
      pending,
      setSort: () => new Promise<number>((resolve, reject) => pending.push({ resolve, reject })),
    };
  }

  function recorder() {
    const events: string[] = [];
    return {
      events,
      status: {
        busy: (on: boolean) => events.push(on ? "busy" : "idle"),
        sorted: (s: RawSort | null) => events.push(`sorted ${s ? s.dir : "none"}`),
        failed: (e: unknown) => events.push(`failed ${(e as Error).message}`),
      },
    };
  }

  const asc: RawSort = { column: "name", dir: "asc" };
  const desc: RawSort = { column: "name", dir: "desc" };

  it("stays busy until the latest of two quick sorts finishes", async () => {
    const src = controlledSource();
    const { events, status } = recorder();
    const req = new SortRequests();
    const first = req.run(src, asc, status);
    const second = req.run(src, desc, status);

    src.pending[0]!.resolve(1);
    await first;
    expect(events).toEqual(["busy", "busy"]); // the first finishing doesn't clear the overlay

    src.pending[1]!.resolve(1);
    await second;
    expect(events).toEqual(["busy", "busy", "sorted desc", "idle"]);
  });

  it("ignores a superseded sort that fails", async () => {
    const src = controlledSource();
    const { events, status } = recorder();
    const req = new SortRequests();
    const first = req.run(src, asc, status);
    const second = req.run(src, desc, status);
    src.pending[0]!.reject(new Error("old"));
    src.pending[1]!.resolve(1);
    await Promise.all([first, second]);
    expect(events).toEqual(["busy", "busy", "sorted desc", "idle"]);
  });

  it("reports a failure of the latest sort and clears busy", async () => {
    const src = controlledSource();
    const { events, status } = recorder();
    const run = new SortRequests().run(src, asc, status);
    src.pending[0]!.reject(new Error("out of memory"));
    await run;
    expect(events).toEqual(["busy", "failed out of memory", "idle"]);
  });
});
