import type { PivotResult } from "./pivot";

/**
 * Expand/collapse state, keyed by row path so it survives re-queries (changing
 * the measure or aggregation keeps what you had open).
 * A node is expanded when `mode === "expanded"` XOR its key is in `toggled`.
 */
export interface ExpandState {
  mode: "expanded" | "collapsed";
  toggled: ReadonlySet<string>;
}

export const EXPANDED_ALL: ExpandState = { mode: "expanded", toggled: new Set() };
export const COLLAPSED_ALL: ExpandState = { mode: "collapsed", toggled: new Set() };

export function nodeKey(result: PivotResult, level: number, index: number): string {
  const lv = result.levels[level]!;
  let key = "";
  for (let l = 0; l <= level; l++) key += (l ? "\u0001" : "") + lv.labels[l]![index];
  return key;
}

export function toggleKey(state: ExpandState, key: string): ExpandState {
  const toggled = new Set(state.toggled);
  if (!toggled.delete(key)) toggled.add(key);
  return { mode: state.mode, toggled };
}

/**
 * The flattened list of visible rows: group rows (with subtotals) followed by
 * their children when expanded. Two typed arrays, so 100k+ rows stay cheap.
 */
export interface DisplayRows {
  count: number;
  level: Uint8Array;
  index: Int32Array;
  expanded: Uint8Array; // 1 if a group row is open (always 0 for leaves)
}

/**
 * Row order inside each group. `col` is a pivot column index; `colCount` (one
 * past the last) means the row Total column. Siblings are sorted within their
 * parent, so groups stay together (like AG Grid), subtotals sort by their own
 * value, and empty cells always go last.
 */
export type RowSort = { by: "label"; dir: "asc" | "desc" } | { by: "value"; col: number; dir: "asc" | "desc" };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function orderedChildren(result: PivotResult, k: number, from: number, to: number, sort: RowSort | null): Int32Array {
  const ids = new Int32Array(to - from);
  for (let i = 0; i < ids.length; i++) ids[i] = from + i;
  if (!sort || ids.length < 2) return ids;
  const lv = result.levels[k]!;
  const sign = sort.dir === "asc" ? 1 : -1;
  if (sort.by === "label") {
    const labels = lv.labels[k]!;
    return ids.sort((a, b) => sign * collator.compare(labels[a]!, labels[b]!));
  }
  const c = sort.col;
  const key = c >= result.colCount ? (i: number) => lv.totals[i]! : (i: number) => lv.values[i * result.colCount + c]!;
  return ids.sort((a, b) => {
    const va = key(a);
    const vb = key(b);
    if (va !== va) return vb !== vb ? a - b : 1; // NaN last
    if (vb !== vb) return -1;
    return va === vb ? a - b : sign * (va - vb);
  });
}

export function buildDisplay(result: PivotResult, state: ExpandState, sort: RowSort | null = null): DisplayRows {
  const L = result.levels.length;
  const cap = result.levels.reduce((n, lv) => n + lv.count, 0);
  const level = new Uint8Array(cap);
  const index = new Int32Array(cap);
  const expanded = new Uint8Array(cap);
  const checkKeys = state.toggled.size > 0;
  const defaultOpen = state.mode === "expanded";
  let n = 0;

  const isOpen = (k: number, i: number) =>
    checkKeys ? defaultOpen !== state.toggled.has(nodeKey(result, k, i)) : defaultOpen;

  // Explicit stack instead of recursion: each frame walks one sibling list.
  type Frame = { k: number; ids: Int32Array; p: number };
  const stack: Frame[] = [];
  if (result.levels[0]) stack.push({ k: 0, ids: orderedChildren(result, 0, 0, result.levels[0].count, sort), p: 0 });
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    if (top.p >= top.ids.length) {
      stack.pop();
      continue;
    }
    const k = top.k;
    const i = top.ids[top.p++]!;
    level[n] = k;
    index[n] = i;
    if (k < L - 1 && isOpen(k, i)) {
      expanded[n] = 1;
      const cs = result.levels[k]!.childStart!;
      stack.push({ k: k + 1, ids: orderedChildren(result, k + 1, cs[i]!, cs[i + 1]!, sort), p: 0 });
    }
    n++;
  }
  return { count: n, level: level.subarray(0, n), index: index.subarray(0, n), expanded: expanded.subarray(0, n) };
}

/** Value of display row r in column c (c === colCount -> row total). */
export function cellValue(result: PivotResult, rows: DisplayRows, r: number, c: number): number {
  const lv = result.levels[rows.level[r]!]!;
  const i = rows.index[r]!;
  return c >= result.colCount ? lv.totals[i]! : lv.values[i * result.colCount + c]!;
}

export function rowPath(result: PivotResult, rows: DisplayRows, r: number): string[] {
  const lv = result.levels[rows.level[r]!]!;
  const i = rows.index[r]!;
  return lv.labels.map((l) => l[i]!);
}
