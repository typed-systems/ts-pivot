const full = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const frac = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Cell formatting. Called only for visible cells, so Intl cost is fine. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return "";
  return Math.abs(v) >= 1000 ? full.format(v) : frac.format(v);
}

export function fmtCompact(v: number): string {
  return Number.isFinite(v) ? compact.format(v) : "–";
}
