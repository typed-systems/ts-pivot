// Geist Mono (kasouka's font), bundled locally; troika reads .woff, not .woff2.
import labelFont from "@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff?url";
import { RoundedBoxGeometry } from "@react-three/drei";
import { type ThreeEvent, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { cellValue, type DisplayRows, rowPath } from "../engine/pivot/display";
import type { PivotResult } from "../engine/pivot/pivot";
import type { CellRange, GridHover, GridViewport } from "../grid/pivot/CanvasPivotGrid";
import { HEAT_RGB, heatIndex, P, seriesColor } from "../theme/palette";
import { SCENE, type ThemeName } from "../theme/theme";
import { AxisLabels, type LabelItem } from "./AxisLabels";
import type { SoftShadowsHandle } from "./SoftShadows";
import { Floor, type ShadowMode } from "./Stage";
import { MAX_COLS, MAX_ROWS, sceneWindow } from "./sceneWindow";

/**
 * The pivot's visible window as ONE InstancedMesh of bevelled bars (drei
 * <RoundedBoxGeometry>), plus the hover outline, the floor and axis labels.
 *
 * Bevels stay crisp at any height: bars are not scaled. A tiny vertex-shader
 * patch moves only the top half of the rounded box up by the bar's height
 * (per-instance `aHeight`), so the bevel radius is identical on every bar.
 */

const CAP = MAX_ROWS * MAX_COLS;
const GAP = 0.18;
/** Bar footprint (width = depth). */
const BAR_W = 1 - GAP;
/** Bevel radius as a share of the bar width: always 10 %, whatever GAP/BAR_W is. */
const BEVEL_RATIO = 0.1;
const BEVEL = BAR_W * BEVEL_RATIO;
// Rounded box height in geometry space = minimum bar height. It must exceed two
// bevels, or the top and bottom roundings would overlap on the shortest bars.
const BASE_H = Math.max(0.12, BEVEL * 2.2);
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

export type ColorMode = "series" | "heat" | "white";

export interface BarsProps {
  data: PivotResult | null;
  rows: DisplayRows | null;
  viewport: GridViewport | null;
  heatmap: boolean;
  colorMode: ColorMode;
  onHover?: (h: GridHover | null) => void;
  /** Cell hovered anywhere (grid or here): its bar gets an outline. */
  linked?: { row: number; col: number } | null;
  /** Endless fading ground (default) or a slab sized to the bars. */
  infiniteFloor?: boolean;
  /** Cells selected in the grid: when set, only these are plotted. */
  selection?: CellRange | null;
  /** Accumulated soft shadows (default) or one sharp shadow map. */
  shadows?: ShadowMode;
  theme?: ThemeName;
}

/** Raise the top half of the rounded box by the per-instance height (see header). */
function patchBarShader(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.uniforms.uBaseH = { value: BASE_H };
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nattribute float aHeight;\nuniform float uBaseH;")
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nif (position.y > 0.0) transformed.y += max(aHeight - uBaseH, 0.0);",
    );
}

/**
 * Glossy finish like the white Lusion connectors (metalness 0.2, low roughness),
 * plus a matching depth material so shadows use the real bar heights.
 */
function useBarMaterials() {
  return useMemo(() => {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.12, metalness: 0.2 });
    material.onBeforeCompile = patchBarShader;
    material.customProgramCacheKey = () => "pivot-bar-v2";
    // Plain depth material: current three.js shadow maps use depth textures, not RGBA packing.
    const depth = new THREE.MeshDepthMaterial();
    depth.onBeforeCompile = patchBarShader;
    depth.customProgramCacheKey = () => "pivot-bar-depth-v2";
    return { material, depth };
  }, []);
}

export function Bars({
  data,
  rows,
  viewport,
  heatmap,
  colorMode,
  onHover,
  linked,
  selection = null,
  infiniteFloor = true,
  shadows = "soft",
  theme = "light",
}: BarsProps) {
  const soft = useRef<SoftShadowsHandle>(null);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const geo = useRef<THREE.ExtrudeGeometry>(null);
  const { invalidate, camera, controls } = useThree();
  const { material, depth } = useBarMaterials();

  // CPU copies for picking (instances aren't scaled, so the default raycast
  // would only see the base): x, z, height and the cell (row, col) per instance.
  const pick = useMemo(
    () => ({
      x: new Float32Array(CAP),
      z: new Float32Array(CAP),
      h: new Float32Array(CAP),
      r: new Int32Array(CAP),
      c: new Int32Array(CAP),
    }),
    [],
  );
  const heights = useMemo(() => new THREE.InstancedBufferAttribute(new Float32Array(CAP), 1), []);
  // window-local cell (r * cols + c) -> instance index, -1 for empty cells
  const slots = useRef<Int32Array>(new Int32Array(0));
  const outline = useRef<THREE.Group>(null);

  // Which slice of the matrix to show: follows the 2D grid's viewport.
  const win = useMemo(() => sceneWindow(data, rows, viewport, selection), [data, rows, viewport, selection]);

  // Value range of the Total column per level (its values dwarf the cells).
  const totalsRange = useMemo(
    () =>
      (data?.levels ?? []).map((lv) => {
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = 0; i < lv.totals.length; i++) {
          const v = lv.totals[i]!;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        return Number.isFinite(mn) ? { min: mn, max: mx } : { min: 0, max: 0 };
      }),
    [data],
  );

  // Series = top-level column group (e.g. year), assigned in palette order.
  const series = useMemo(() => {
    if (!data) return new Int32Array(0);
    const out = new Int32Array(Math.max(1, data.colCount));
    const top = data.colLabels[0];
    if (!top) return out;
    let g = 0;
    for (let c = 1; c < data.colCount; c++) {
      if (top[c] !== top[c - 1]) g++;
      out[c] = g;
    }
    return out;
  }, [data]);

  // Write instance data straight into GPU buffers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme is the trigger: bar colors come from the mutable SCENE theme
  useLayoutEffect(() => {
    const m = mesh.current;
    const g = geo.current;
    if (!m || !g || !data || !rows || !win) return;
    if (g.getAttribute("aHeight") !== heights) g.setAttribute("aHeight", heights);

    const tmp = new THREE.Object3D();
    const col = new THREE.Color();
    const leafLevel = data.levels.length - 1;
    const maxH = Math.max(5, Math.max(win.layoutRows, win.layoutCols) * 0.35);
    const hArr = heights.array as Float32Array;
    let i = 0;
    const slot = new Int32Array(win.rows * win.cols).fill(-1);
    for (let r = 0; r < win.rows; r++) {
      const dr = win.r0 + r;
      const lv = data.levels[rows.level[dr]!]!;
      const isGroup = rows.level[dr]! < leafLevel;
      const tr = totalsRange[rows.level[dr]!]!;
      for (let c = 0; c < win.cols; c++) {
        const cc = win.c0 + c;
        const v = cellValue(data, rows, dr, data.colCount > 0 ? cc : 0);
        if (v !== v) continue; // empty cell: no bar (grey is a palette color, so don't fake one)
        // the Total column (only in a selection) is scaled against the other totals
        const range = data.colCount > 0 && cc >= data.colCount ? tr : lv;
        const lo = Math.min(0, range.min);
        const span = Math.max(1e-9, range.max - lo);
        const h = BASE_H + ((v - lo) / span) * maxH;
        const x = c - win.layoutCols / 2 + 0.5;
        const z = r - win.layoutRows / 2 + 0.5;
        tmp.position.set(x, BASE_H / 2, z);
        tmp.updateMatrix();
        m.setMatrixAt(i, tmp.matrix);
        hArr[i] = h;
        pick.x[i] = x;
        pick.z[i] = z;
        pick.h[i] = h;
        pick.r[i] = dr;
        pick.c[i] = cc;
        slot[r * win.cols + c] = i;

        if (colorMode === "white") col.set("#ffffff");
        else if (colorMode === "series")
          col.set(seriesColor(series[data.colCount > 0 ? cc : 0] ?? series[series.length - 1]! + 1));
        else if (heatmap) {
          const k = heatIndex(v, range.min, range.max) * 3;
          col.setRGB(HEAT_RGB[k]!, HEAT_RGB[k + 1]!, HEAT_RGB[k + 2]!, THREE.SRGBColorSpace);
        } else col.set(P.purple);
        // group (subtotal) rows read as a darker band
        if (isGroup) col.multiplyScalar(colorMode === "white" ? 0.82 : 0.8);
        m.setColorAt(i, col);
        i++;
      }
    }
    m.count = i;
    slots.current = slot;
    m.instanceMatrix.needsUpdate = true;
    heights.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    soft.current?.refresh(); // shadows blend toward the new bars
    invalidate();
  }, [data, rows, win, heatmap, colorMode, series, heights, pick, invalidate, theme, totalsRange]);

  // Outline the bar of the linked cell (hovered in the grid or here). Imperative:
  // moving one small group is cheaper than re-rendering anything.
  // biome-ignore lint/correctness/useExhaustiveDependencies: heatmap and colorMode rebuild the bars (slots, pick); re-place the outline after them
  useLayoutEffect(() => {
    const g = outline.current;
    if (!g) return;
    let i = -1;
    if (linked && data && win && linked.row >= 0) {
      const col = data.colCount > 0 ? linked.col : 0;
      const lr = linked.row - win.r0;
      const lc = col - win.c0; // the Total column only falls inside a selection window
      if (lr >= 0 && lr < win.rows && lc >= 0 && lc < win.cols) i = slots.current[lr * win.cols + lc] ?? -1;
    }
    g.visible = i >= 0;
    if (i >= 0) {
      const h = pick.h[i]!;
      g.position.set(pick.x[i]!, h / 2, pick.z[i]!);
      g.scale.set(BAR_W + 0.14, h + 0.14, BAR_W + 0.14);
    }
    invalidate();
  }, [linked, data, win, pick, invalidate, heatmap, colorMode]);

  // Picking against the real (tall) bars: ray vs. per-instance AABB.
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const box = new THREE.Box3();
    const hit = new THREE.Vector3();
    const half = BAR_W / 2;
    m.raycast = (raycaster, intersects) => {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < m.count; i++) {
        box.min.set(pick.x[i]! - half, 0, pick.z[i]! - half);
        box.max.set(pick.x[i]! + half, pick.h[i]!, pick.z[i]! + half);
        if (raycaster.ray.intersectBox(box, hit)) {
          const dist = raycaster.ray.origin.distanceTo(hit);
          if (dist < bestD) {
            bestD = dist;
            best = i;
          }
        }
      }
      if (best >= 0) {
        raycaster.ray.at(bestD, hit);
        intersects.push({ distance: bestD, point: hit.clone(), object: m, instanceId: best });
      }
    };
  }, [pick]);

  // Frame the camera when the shape of the window changes.
  const shapeKey = win ? `${win.layoutRows}x${win.layoutCols}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: shapeKey on purpose: reframe only when the window shape changes, not on every new window
  useLayoutEffect(() => {
    if (!win) return;
    const size = Math.max(win.layoutRows, win.layoutCols, 10);
    camera.position.set(size * 1.05, size * 1.15, size * 1.55);
    camera.lookAt(0, 0, 0);
    const ctl = controls as unknown as { target?: THREE.Vector3; update?: () => void } | null;
    ctl?.target?.set(0, 0, 0);
    ctl?.update?.();
    invalidate();
  }, [shapeKey, controls, camera, invalidate]);

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (!data || !rows || !win || e.instanceId == null) return;
    const r = pick.r[e.instanceId]!;
    const c = pick.c[e.instanceId]!;
    onHover?.({
      row: r,
      col: data.colCount > 0 ? c : data.colCount,
      value: cellValue(data, rows, r, data.colCount > 0 ? c : 0),
      rowPath: rowPath(data, rows, r),
      colPath: data.colCount > 0 && c < data.colCount ? data.colLabels.map((l) => l[c] ?? "") : ["Total"],
    });
  };

  // Axis labels: one per bar row and column, all drawn as a single batched mesh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme is the trigger: label colors come from the mutable SCENE theme
  const labels = useMemo((): LabelItem[] => {
    if (!data || !rows || !win) return [];
    const out: LabelItem[] = [];
    // Right (+x) and bottom/front (+z) edges, i.e. the sides facing the default camera.
    const x0 = win.layoutCols / 2 + 0.6;
    const z0 = win.layoutRows / 2 + 0.6;
    for (let r = 0; r < win.rows; r++) {
      const dr = win.r0 + r;
      const k = rows.level[dr]!;
      out.push({
        text: data.levels[k]!.labels[k]![rows.index[dr]!] ?? "",
        x: x0,
        z: r - win.layoutRows / 2 + 0.5,
        turn: 0,
        anchorX: "left",
        color: k < data.levels.length - 1 ? SCENE.labelGroup : SCENE.label,
      });
    }
    if (data.colCount > 0) {
      const leaf = data.colLabels[data.colLabels.length - 1]!;
      for (let c = 0; c < win.cols; c++)
        out.push({
          text: win.c0 + c >= data.colCount ? "Total" : (leaf[win.c0 + c] ?? ""),
          x: c - win.layoutCols / 2 + 0.5,
          z: z0,
          // reads bottom-to-top from the default camera; body extends toward the viewer
          turn: Math.PI / 2,
          anchorX: "right",
          color: SCENE.label,
        });
    }
    return out;
  }, [data, rows, win, theme]); // theme: colors come from SCENE

  if (!data || !rows || !win) return null;

  return (
    <group>
      <instancedMesh
        ref={mesh}
        args={[undefined, material, CAP]}
        customDepthMaterial={depth}
        castShadow
        frustumCulled={false}
        onPointerMove={onMove}
        onPointerOut={() => onHover?.(null)}
      >
        <RoundedBoxGeometry ref={geo} args={[BAR_W, BASE_H, BAR_W]} radius={BEVEL} smoothness={3} bevelSegments={3} />
      </instancedMesh>

      {/* Hover outline: dark edge lines plus a translucent shell, readable on any bar color. */}
      <group ref={outline} visible={false} raycast={() => null}>
        <lineSegments raycast={() => null}>
          <edgesGeometry args={[UNIT_BOX]} />
          <lineBasicMaterial color={SCENE.outlineLine} />
        </lineSegments>
        <mesh raycast={() => null} renderOrder={2}>
          <boxGeometry />
          <meshBasicMaterial color={SCENE.outlineShell} transparent opacity={0.35} depthWrite={false} />
        </mesh>
      </group>

      {/* Floor slab sized to the current window of bars; receives their shadows. */}
      <Floor
        cols={win.layoutCols}
        rows={win.layoutRows}
        infinite={infiniteFloor}
        shadows={shadows}
        softRef={soft}
        theme={theme}
      />

      <AxisLabels items={labels} font={labelFont} />
    </group>
  );
}
