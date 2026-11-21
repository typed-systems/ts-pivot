/**
 * Fast bulk decoding of Arrow Utf8 columns into JS strings.
 *
 * `vector.get(i)` runs a TextDecoder per row, which was ~80% of the pivot build
 * time on 800k-row results. Here each Arrow chunk's byte buffer is decoded once;
 * when it is pure ASCII (byte offsets == character offsets) rows are cheap
 * substrings of that one string. Rows equal to the previous row reuse its string
 * object, so the sorted, highly repetitive outer-level labels (region, country)
 * cost one string per run instead of one per row: a dictionary built on the fly.
 */

interface Utf8Chunk {
  length: number;
  nullCount: number;
  values: Uint8Array;
  valueOffsets: Int32Array;
  getValid(i: number): boolean;
}

const decoder = new TextDecoder();

export function utf8Strings(
  vec: { data: readonly unknown[]; get(i: number): unknown },
  from: number,
  to: number,
  nullLabel = "∅",
): string[] {
  const out = new Array<string>(Math.max(0, to - from));
  let base = 0; // global row index of the current chunk's first row
  for (const raw of vec.data) {
    const chunk = raw as Utf8Chunk;
    const n = chunk.length;
    const lo = Math.max(from, base);
    const hi = Math.min(to, base + n);
    if (lo < hi) decodeChunk(chunk, lo - base, hi - base, out, lo - from, nullLabel);
    base += n;
    if (base >= to) break;
  }
  return out;
}

function decodeChunk(c: Utf8Chunk, i0: number, i1: number, out: string[], o: number, nullLabel: string) {
  const offs = c.valueOffsets;
  const bytes = c.values;
  if (!offs || !bytes) {
    // not a plain Utf8 chunk: fall back to the slow path
    for (let i = i0; i < i1; i++)
      out[o + i - i0] = String((c as unknown as { get(i: number): unknown }).get?.(i) ?? nullLabel);
    return;
  }
  const b0 = offs[i0]!;
  const b1 = offs[i1]!;
  const text = decoder.decode(bytes.subarray(b0, b1));
  const ascii = text.length === b1 - b0;
  const hasNulls = c.nullCount > 0;
  let prev = "";
  let prevStart = -1;
  let prevEnd = -1;
  for (let i = i0; i < i1; i++) {
    if (hasNulls && !c.getValid(i)) {
      out[o + i - i0] = nullLabel;
      prevStart = -1;
      continue;
    }
    const s = offs[i]!;
    const e = offs[i + 1]!;
    // Same bytes as the previous row? Reuse that string (runs are common).
    if (prevStart >= 0 && e - s === prevEnd - prevStart && sameBytes(bytes, s, prevStart, e - s)) {
      out[o + i - i0] = prev;
      continue;
    }
    prev = ascii ? text.slice(s - b0, e - b0) : decoder.decode(bytes.subarray(s, e));
    prevStart = s;
    prevEnd = e;
    out[o + i - i0] = prev;
  }
}

function sameBytes(b: Uint8Array, a0: number, b0: number, len: number): boolean {
  for (let k = 0; k < len; k++) if (b[a0 + k] !== b[b0 + k]) return false;
  return true;
}
