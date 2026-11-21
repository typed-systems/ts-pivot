import { CancelledError, exclusive, FACTS, queryCancellable, type Schema } from "../db/duck";
import { utf8Strings } from "./arrowStrings";

export const AGGS = ["sum", "avg", "count", "min", "max"] as const;
export type Agg = (typeof AGGS)[number];

export interface PivotConfig {
  rows: string[]; // at least one; order = grouping hierarchy
  cols: string[]; // may be empty -> only a totals column
  measure: string | null; // null only allowed with count
  agg: Agg;
}

/**
 * One level of the row hierarchy (level k groups by rows[0..k]).
 * Nodes are sorted by their label path, so the children of node i at level k
 * are the contiguous range childStart[i] .. childStart[i+1] at level k+1.
 */
export interface RowLevel {
  count: number;
  /** labels[l][i] for l = 0..k: the path of node i */
  labels: string[][];
  /** row-major count * colCount, NaN where empty */
  values: Float64Array;
  totals: Float64Array;
  /** for levels below the deepest: count + 1 offsets into the next level */
  childStart: Int32Array | null;
  /** value range at this level (cells, or totals if there are no columns) */
  min: number;
  max: number;
}

export interface PivotResult {
  config: PivotConfig;
  colCount: number;
  /** colLabels[level][col] */
  colLabels: string[][];
  levels: RowLevel[]; // levels.length === config.rows.length
  colTotals: Float64Array;
  grandTotal: number;
  queryMs: number;
  buildMs: number;
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

function validate(c: PivotConfig, schema: Schema) {
  const names = new Set(schema.fields.map((f) => f.name));
  for (const d of [...c.rows, ...c.cols]) if (!names.has(d)) throw new Error(`unknown field ${d}`);
  if (c.rows.length === 0) throw new Error("need at least one row field");
  if (c.agg !== "count") {
    const m = schema.fields.find((f) => f.name === c.measure);
    if (!m) throw new Error("pick a measure");
    if (!m.numeric) throw new Error(`${c.agg} needs a numeric measure`);
  }
}

/** True if `validate` accepts the config for this schema (every named field exists, measure fits the agg). */
export function configFits(c: PivotConfig, schema: Schema): boolean {
  try {
    validate(c, schema);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- scheduling

let generation = 0;
let running: AbortController | null = null;

/**
 * Last request wins: a newer call cancels the pivot that is currently running
 * inside DuckDB (via the pending-query API) and skips any queued ones.
 * Resolves to null for superseded requests.
 */
export function runPivot(config: PivotConfig, schema: Schema): Promise<PivotResult | null> {
  const gen = ++generation;
  running?.abort();
  return exclusive(async () => {
    if (gen !== generation) return null;
    const ctl = new AbortController();
    running = ctl;
    try {
      return await runPivotNow(config, schema, ctl.signal);
    } catch (e) {
      if (e instanceof CancelledError) return null;
      throw e;
    } finally {
      if (running === ctl) running = null;
    }
  });
}

// ------------------------------------------------------------- the query

async function runPivotNow(config: PivotConfig, schema: Schema, signal: AbortSignal): Promise<PivotResult> {
  validate(config, schema);
  // Every statement goes through the cancellable path, so a newer request can
  // stop this one at any stage.
  const run = (sql: string) => queryCancellable(sql, signal);
  const { rows: R, cols: C, measure, agg } = config;
  const L = R.length;

  const aggExpr = agg === "count" ? "count(*)::DOUBLE" : `${agg}(${q(measure!)})::DOUBLE`;

  // Grouping sets: every row prefix, with and without the column dims, plus
  // column totals and the grand total. DuckDB computes them all in one pass.
  const sets = new Map<string, string[]>();
  const add = (s: string[]) => sets.set(s.join("\u0000"), s);
  for (let k = 1; k <= L; k++) {
    add([...R.slice(0, k), ...C]);
    add(R.slice(0, k));
  }
  add(C);
  add([]);
  const groupingSets = [...sets.values()].map((s) => `(${s.map(q).join(", ")})`).join(", ");

  const levExpr = R.map((d) => `(1 - GROUPING(${q(d)}))`).join(" + ");
  const colFull = C.length ? `(GROUPING(${C.map(q).join(", ")}) = 0)::INTEGER` : "0";
  const all = [...R, ...C];

  const t0 = performance.now();
  await run(
    `CREATE OR REPLACE TEMP TABLE _pv AS
     SELECT ${all.map(q).join(", ")},
            ${aggExpr} AS __pvt_v,
            (${levExpr})::INTEGER AS __pvt_lev,
            ${colFull} AS __pvt_cf
     FROM ${FACTS}
     GROUP BY GROUPING SETS (${groupingSets})`,
  );

  // Row keys per level. Dimension values keep their native type, so numbers and
  // dates sort naturally; NULL only means "rolled up" inside a matching level.
  const rcols = R.map(q).join(", ");
  await run(`
    CREATE OR REPLACE TEMP TABLE _rk AS
    SELECT ${rcols}, __pvt_lev,
           (row_number() OVER (PARTITION BY __pvt_lev ORDER BY ${rcols} NULLS LAST) - 1)::INTEGER AS __pvt_ri
    FROM (SELECT DISTINCT ${rcols}, __pvt_lev FROM _pv WHERE __pvt_lev > 0)
  `);
  if (C.length) {
    const ccols = C.map(q).join(", ");
    await run(`
      CREATE OR REPLACE TEMP TABLE _ck AS
      SELECT ${ccols}, 1 AS __pvt_cf,
             (row_number() OVER (ORDER BY ${ccols} NULLS LAST) - 1)::INTEGER AS __pvt_ci
      FROM (SELECT DISTINCT ${ccols} FROM _pv WHERE __pvt_cf = 1)
    `);
  }

  const label = (d: string) => `coalesce(${q(d)}::VARCHAR, '∅') AS ${q(d)}`;
  const rk = await run(`SELECT __pvt_lev, __pvt_ri, ${R.map(label).join(", ")} FROM _rk ORDER BY __pvt_lev, __pvt_ri`);
  const ck = C.length ? await run(`SELECT ${C.map(label).join(", ")} FROM _ck ORDER BY __pvt_ci`) : null;

  // Pure equi-joins (hash joins). IS NOT DISTINCT FROM lets a rolled-up NULL
  // match the NULL in the same-level key, and real NULL values still work.
  const rowJoin = R.map((d) => `p.${q(d)} IS NOT DISTINCT FROM rk.${q(d)}`).join(" AND ");
  const colJoin = C.map((d) => `p.${q(d)} IS NOT DISTINCT FROM ck.${q(d)}`).join(" AND ");
  const cells = await run(`
    SELECT p.__pvt_lev AS __pvt_lev,
           coalesce(rk.__pvt_ri, -1)::INTEGER AS __pvt_ri,
           ${C.length ? "coalesce(ck.__pvt_ci, -1)::INTEGER" : "-1::INTEGER"} AS __pvt_ci,
           p.__pvt_v AS __pvt_v
    FROM _pv p
    LEFT JOIN _rk rk ON p.__pvt_lev = rk.__pvt_lev AND ${rowJoin}
    ${C.length ? `LEFT JOIN _ck ck ON p.__pvt_cf = ck.__pvt_cf AND ${colJoin}` : ""}
  `);
  const queryMs = performance.now() - t0;
  if (signal.aborted) throw new CancelledError();

  // ---- Arrow columns -> typed arrays (no per-row objects)
  const t1 = performance.now();
  const colCount = ck ? ck.numRows : 0;
  const colLabels = ck ? C.map((d) => strings(ck.getChild(d)!, 0, colCount)) : [];

  const rkLev = rk.getChild("__pvt_lev")!.toArray() as Int32Array;
  const levels: RowLevel[] = [];
  let start = 0;
  for (let k = 1; k <= L; k++) {
    let end = start;
    while (end < rkLev.length && rkLev[end] === k) end++;
    const count = end - start;
    levels.push({
      count,
      labels: R.slice(0, k).map((d) => strings(rk.getChild(d)!, start, end)),
      values: new Float64Array(count * colCount).fill(NaN),
      totals: new Float64Array(count).fill(NaN),
      childStart: null,
      min: Infinity,
      max: -Infinity,
    });
    start = end;
  }

  const colTotals = new Float64Array(colCount).fill(NaN);
  let grandTotal = NaN;
  const cLev = cells.getChild("__pvt_lev")!.toArray() as Int32Array;
  const cRi = cells.getChild("__pvt_ri")!.toArray() as Int32Array;
  const cCi = cells.getChild("__pvt_ci")!.toArray() as Int32Array;
  const vVec = cells.getChild("__pvt_v")!;
  const vArr = vVec.toArray() as Float64Array;
  for (let i = 0; i < cRi.length; i++) {
    const v = vVec.isValid(i) ? vArr[i]! : NaN;
    const k = cLev[i]!;
    const r = cRi[i]!;
    const c = cCi[i]!;
    if (k > 0 && r >= 0) {
      const lv = levels[k - 1]!;
      if (c >= 0) lv.values[r * colCount + c] = v;
      else lv.totals[r] = v;
    } else if (c >= 0) colTotals[c] = v;
    else grandTotal = v;
  }

  for (let k = 0; k < L; k++) {
    const lv = levels[k]!;
    const src = colCount > 0 ? lv.values : lv.totals;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < src.length; i++) {
      const v = src[i]!;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    lv.min = Number.isFinite(mn) ? mn : 0;
    lv.max = Number.isFinite(mx) ? mx : 0;
    if (k < L - 1) lv.childStart = childOffsets(lv, levels[k + 1]!);
  }

  return {
    config,
    colCount,
    colLabels,
    levels,
    colTotals,
    grandTotal,
    queryMs,
    buildMs: performance.now() - t1,
  };
}

/** Two-pointer pass: both levels are sorted by path, children are contiguous. */
function childOffsets(parent: RowLevel, child: RowLevel): Int32Array {
  const out = new Int32Array(parent.count + 1);
  const depth = parent.labels.length;
  let j = 0;
  for (let i = 0; i < parent.count; i++) {
    out[i] = j;
    while (j < child.count && samePrefix(parent, i, child, j, depth)) j++;
  }
  out[parent.count] = j;
  return out;
}

function samePrefix(a: RowLevel, i: number, b: RowLevel, j: number, depth: number): boolean {
  for (let l = 0; l < depth; l++) if (a.labels[l]![i] !== b.labels[l]![j]) return false;
  return true;
}

function strings(vec: { data: readonly unknown[]; get(i: number): unknown }, from: number, to: number): string[] {
  return utf8Strings(vec, from, to);
}
