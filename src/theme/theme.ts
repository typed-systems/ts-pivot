import { P, setHeatStops } from "./palette";

/**
 * Light / dark theme for the parts CSS can't reach: the canvas grids and the
 * 3D scene. `GRID` and `SCENE` are live objects that the renderers read on every
 * frame; `applyTheme` swaps their contents (and the heat ramp) in place, then
 * the views just redraw.
 */
export type ThemeName = "light" | "dark";

const LIGHT_GRID = {
  bg: "#ffffff",
  stripe: "#fafbfc",
  group: "#f2f3f8",
  header: "#f3f4f7",
  headerText: "#111827",
  text: "#111827",
  muted: "#6b7280",
  nul: "#b6bac4",
  line: "#e7e8ee",
  strong: "#d3d6de",
  total: "#eceefa",
  hover: "rgba(94,110,206,0.10)",
  selection: "rgba(94,110,206,0.16)",
  hoverRow: "#eef0fb",
  loading: "#eef0f5",
  accent: P.purple as string,
  heatTextDark: "#ffffff", // text on the dark end of the heat ramp
  ringOuter: "#111827",
  ringInner: "#ffffff",
};
type GridTheme = typeof LIGHT_GRID;

const DARK_GRID: GridTheme = {
  bg: "#14161d",
  stripe: "#171a22",
  group: "#1d2130",
  header: "#1b1e27",
  headerText: "#e6e8ef",
  text: "#d9dce5",
  muted: "#8b92a3",
  nul: "#545b6b",
  line: "#252937",
  strong: "#323849",
  total: "#20243a",
  hover: "rgba(127,141,230,0.16)",
  selection: "rgba(127,141,230,0.24)",
  hoverRow: "#1f2333",
  loading: "#222634",
  accent: "#7f8de6", // purple, lifted for contrast on dark
  heatTextDark: "#ffffff",
  ringOuter: "#ffffff",
  ringInner: "#111827",
};

const LIGHT_SCENE = {
  floor: "#dfe2ea",
  floorUnlit: false,
  gridCell: "#cdd1db", // division lines: lighter than the section lines
  gridSection: "#b7bcca", // 50% lighter than before (mixed halfway toward the floor colour)
  label: "#111827", // near-black, so the small floor labels stay readable
  labelGroup: "#3f4aa8", // purple, darkened for contrast on the light floor
  backgroundIntensity: 0.55,
  envIntensity: 0.38,
  plainBackground: "#eef0f5",
  shadow: "#1f2340",
  shadowOpacity: 0.28,
  softShadowOpacity: 0.22,
  softShadowGain: 1, // contrast of the soft shadows (higher = darker, crisper core)
  outlineLine: "#111827",
  outlineShell: "#ffffff",
};
type SceneTheme = typeof LIGHT_SCENE;

const DARK_SCENE: SceneTheme = {
  floor: "#0f1117",
  floorUnlit: true, // shown exactly as `floor`; shadows come from the separate shadow layer
  gridCell: "#1d212c",
  gridSection: "#353c4e",
  label: "#c7ccd8",
  labelGroup: "#9aa6f0",
  backgroundIntensity: 0.06,
  envIntensity: 0.3,
  plainBackground: "#12141a",
  shadow: "#000000",
  shadowOpacity: 0.5,
  softShadowOpacity: 1,
  softShadowGain: 2,
  outlineLine: "#ffffff",
  outlineShell: "#ffffff",
};

export const GRID: GridTheme = { ...LIGHT_GRID };
export const SCENE: SceneTheme = { ...LIGHT_SCENE };

export function applyTheme(name: ThemeName) {
  Object.assign(GRID, name === "dark" ? DARK_GRID : LIGHT_GRID);
  Object.assign(SCENE, name === "dark" ? DARK_SCENE : LIGHT_SCENE);
  // Heat ramp starts from the cell background, so low values blend in.
  // Dark: deep teal -> deep purple, so white text keeps >= 6:1 contrast everywhere.
  // Light: grid cells are the ramp mixed 30% toward white, so dense tables stay
  // easy on the eye (dark text everywhere); the 3D bars keep the full colours.
  if (name === "dark") setHeatStops(["#1b1f2b", "#1e6b80", "#4c58c4"]);
  else setHeatStops(["#f7f8fb", P.teal, P.purple], 0.3);
  document.documentElement.dataset.theme = name;
}

// ------------------------------------------------------------------ preference

export type ThemePref = "system" | "light" | "dark";
const KEY = "ts-pivot:theme";
const OLD_KEY = "gpu-pivot:theme"; // name before the rename; read once so a saved choice isn't lost

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

export function saveThemePref(p: ThemePref) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* storage unavailable */
  }
}

export function systemTheme(): ThemeName {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(p: ThemePref): ThemeName {
  return p === "system" ? systemTheme() : p;
}
