/**
 * Project palette, in assignment order. Categorical series take colors in this
 * order (and wrap). Shared by the 2D grid, the 3D view and the UI chrome.
 */
export const PALETTE = [
  { name: "Purple", hex: "#5e6ece" },
  { name: "Orange", hex: "#e89d55" },
  { name: "Pink", hex: "#f1cac2" },
  { name: "Teal", hex: "#52b3cc" },
  { name: "Yellow", hex: "#edc95c" },
  { name: "Green", hex: "#67b385" },
  { name: "Grey", hex: "#bfc2c8" },
  { name: "Red", hex: "#dd635b" },
  { name: "Dark Grey", hex: "#97a2b2" },
] as const;

export const P = {
  purple: "#5e6ece",
  orange: "#e89d55",
  pink: "#f1cac2",
  teal: "#52b3cc",
  yellow: "#edc95c",
  green: "#67b385",
  grey: "#bfc2c8",
  red: "#dd635b",
  darkGrey: "#97a2b2",
} as const;

export function seriesColor(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]!.hex;
}

const hexToRgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

/**
 * Sequential heat ramp built from the palette (light: near-white -> Teal -> Purple).
 * Precomputed into a 256-entry LUT for both CSS (2D) and sRGB floats (3D).
 * `setHeatStops` rebuilds it in place, e.g. for the dark theme. `gridLighten`
 * mixes only the grid's cell colours toward white (0..1); the 3D bars keep the
 * full-strength ramp.
 */
export const HEAT_RGB = new Float32Array(256 * 3); // sRGB 0..1
export const HEAT_CSS: string[] = new Array(256);
const heatLightText = new Uint8Array(256); // 1 where light text reads better than dark

export function setHeatStops(hexStops: string[], gridLighten = 0) {
  const stops = hexStops.map(hexToRgb);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    const a = stops[k]!;
    const b = stops[k + 1]!;
    const rgb = [0, 1, 2].map((j) => a[j]! + (b[j]! - a[j]!) * f);
    HEAT_RGB.set(
      rgb.map((v) => v / 255),
      i * 3,
    );
    const cell = rgb.map((v) => v + (255 - v) * gridLighten);
    HEAT_CSS[i] = `rgb(${cell.map((v) => Math.round(v)).join(",")})`;
    // WCAG contrast on the cell colour: whichever of white / near-black text reads better.
    const L = luminance(cell);
    heatLightText[i] = 1.05 / (L + 0.05) >= (L + 0.05) / (luminance([17, 24, 39]) + 0.05) ? 1 : 0;
  }
}

/** WCAG relative luminance of an sRGB 0..255 triple. */
function luminance(rgb: number[]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
}
setHeatStops(["#f7f8fb", P.teal, P.purple]);

/** Map a value into the LUT index given a [min, max] domain. */
export function heatIndex(v: number, min: number, max: number): number {
  if (!(max > min)) return 128;
  const t = (v - min) / (max - min);
  return t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0;
}

/** True when light text has more contrast than dark text on this heat color. */
export function heatIsDark(i: number): boolean {
  return heatLightText[i] === 1;
}
