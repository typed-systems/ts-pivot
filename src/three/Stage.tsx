import { Environment, Grid, Lightformer, RoundedBox } from "@react-three/drei";
import { EffectComposer, N8AO } from "@react-three/postprocessing";
import { memo, type Ref, use, useMemo } from "react";
import * as THREE from "three";
import { SCENE, type ThemeName } from "../theme/theme";
import { SoftShadows, type SoftShadowsHandle } from "./SoftShadows";

export const SHADOW_MODES = ["soft", "sharp"] as const;
export type ShadowMode = (typeof SHADOW_MODES)[number];

/**
 * Look & lighting, after two pmndrs examples:
 *  - environment-blur-and-transitions: HDR environment as a blurred background,
 *    plus a floor that receives soft shadows (see Floor).
 *  - lusion-connectors: glossy material lit by circle Lightformers, N8AO for
 *    ambient occlusion between objects.
 *
 * HDRIs come from @pmndrs/assets as small (~150-250 KB) EXR data-URL modules,
 * loaded on demand, so nothing is fetched from a CDN at runtime.
 */

export const ENVIRONMENTS = ["studio", "sunset", "dawn", "city", "lightformers"] as const;
export type EnvName = (typeof ENVIRONMENTS)[number];

const loaders: Record<Exclude<EnvName, "lightformers">, () => Promise<{ default: string }>> = {
  sunset: () => import("@pmndrs/assets/hdri/sunset.exr"),
  dawn: () => import("@pmndrs/assets/hdri/dawn.exr"),
  city: () => import("@pmndrs/assets/hdri/city.exr"),
  studio: () => import("@pmndrs/assets/hdri/studio.exr"),
};
const cache = new Map<string, Promise<string>>();
function hdri(name: Exclude<EnvName, "lightformers">): Promise<string> {
  let p = cache.get(name);
  if (!p) {
    p = loaders[name]().then((m) => m.default);
    cache.set(name, p);
  }
  return p;
}

/** The Lusion-style rig: circle lights reflected as crisp highlights in glossy bars. */
function Lightformers() {
  return (
    <group rotation={[-Math.PI / 3, 0, 1]}>
      <Lightformer form="circle" intensity={2.5} rotation-x={Math.PI / 2} position={[0, 5, -9]} scale={2} />
      <Lightformer form="circle" intensity={1.2} rotation-y={Math.PI / 2} position={[-5, 1, -1]} scale={2} />
      <Lightformer form="circle" intensity={1.2} rotation-y={Math.PI / 2} position={[-5, -1, -1]} scale={2} />
      <Lightformer form="circle" intensity={1.2} rotation-y={-Math.PI / 2} position={[10, 1, 0]} scale={8} />
    </group>
  );
}

// `theme` is only here so a theme switch re-renders with the new SCENE values.
function HdrEnvironment({ name, blur }: { name: Exclude<EnvName, "lightformers">; blur: number; theme: ThemeName }) {
  const files = use(hdri(name)); // suspends until the EXR module is loaded
  return (
    <Environment
      files={files}
      background
      backgroundBlurriness={blur}
      backgroundIntensity={SCENE.backgroundIntensity}
      environmentIntensity={SCENE.envIntensity}
      resolution={256}
    >
      <Lightformers />
    </Environment>
  );
}

export function StageEnvironment({ env, theme, blur = 0.65 }: { env: EnvName; theme: ThemeName; blur?: number }) {
  if (env === "lightformers")
    return (
      <>
        <color attach="background" args={[SCENE.plainBackground]} />
        <Environment resolution={256} environmentIntensity={SCENE.envIntensity}>
          <Lightformers />
        </Environment>
      </>
    );
  return <HdrEnvironment name={env} blur={blur} theme={theme} />;
}

/**
 * Floor under the bars.
 *
 * - `infinite` (default): a very large ground disc whose edge fades out with a
 *   radial alpha ramp, so it melts into the blurred environment background and
 *   reads as an endless studio floor.
 * - `infinite={false}`: a rounded slab just big enough for the bars and labels.
 *
 * Shadows are drawn by a separate transparent layer just above the floor, so
 * they stay visible under bright environments (a lit floor alone gets washed
 * out by the HDR light). The bars use a patched depth material, so shadows
 * follow the real bar heights.
 *  - `shadows="soft"` (default): accumulated soft shadows with contact
 *    darkening (./SoftShadows.tsx). Call `softRef.current.refresh()` after
 *    the bars change.
 *  - `shadows="sharp"`: one directional light's shadow map on a ShadowMaterial.
 */
export const Floor = memo(function Floor({
  cols,
  rows,
  infinite = true,
  grid = true,
  shadows = "soft",
  softRef,
  theme: _theme,
}: {
  cols: number;
  rows: number;
  infinite?: boolean;
  /** Subtle drei <Grid> on the floor, lined up with the bar cells. */
  grid?: boolean;
  shadows?: ShadowMode;
  softRef?: Ref<SoftShadowsHandle>;
  /** Only used to re-render when the theme changes (colors come from SCENE). */
  theme: ThemeName;
}) {
  const s = Math.max(6, cols, rows);
  const pad = 1.2; // around the bars
  const label = 4.5; // label side margin
  const w = cols + pad + label;
  const d = rows + pad + label;
  const cx = (label - pad) / 2; // shift toward the label sides (+x right, +z front)
  const fade = useFadeTexture();
  const R = Math.max(250, s * 25); // "infinite" radius, well past the camera's far view
  // from back-left, so shadows fall toward the camera and stay visible
  const lightPos: [number, number, number] = [-s * 0.45, s * 1.3, -s * 0.7];
  const soft = shadows === "soft";
  return (
    <>
      <directionalLight
        castShadow={!soft}
        position={lightPos}
        intensity={0.9}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
      >
        <orthographicCamera attach="shadow-camera" args={[-s * 1.4, s * 1.4, s * 1.4, -s * 1.4, 0.1, s * 6]} />
      </directionalLight>

      {infinite ? (
        <mesh rotation-x={-Math.PI / 2} position={[0, -0.001, 0]} raycast={() => null}>
          <circleGeometry args={[R, 96]} />
          {SCENE.floorUnlit ? (
            // Dark theme: unlit, so the floor stays exactly as dark as its colour
            // (a lit floor picks up grey reflections from the studio HDR).
            <meshBasicMaterial color={SCENE.floor} alphaMap={fade} transparent depthWrite={false} />
          ) : (
            <meshStandardMaterial
              color={SCENE.floor}
              roughness={0.92}
              metalness={0}
              alphaMap={fade}
              transparent
              // no depth write, so the grid and shadow layers on top always draw
              depthWrite={false}
            />
          )}
        </mesh>
      ) : (
        <RoundedBox
          args={[w, FLOOR_T, d]}
          radius={0.12}
          smoothness={4}
          position={[cx, -FLOOR_T / 2, cx]}
          raycast={() => null}
        >
          {SCENE.floorUnlit ? (
            <meshBasicMaterial color={SCENE.floor} />
          ) : (
            <meshStandardMaterial color={SCENE.floor} roughness={0.9} metalness={0} />
          )}
        </RoundedBox>
      )}

      {grid && (
        <>
          {/* Two layers with the same reach and fade, so both run out to the horizon
              together: light 1-unit division lines, and stronger 5-unit section lines.
              (Drawn separately because drei fades thin cell lines in a single Grid
              sooner than sections, which made them look like a small patch in the middle.) */}
          <Grid
            // Bars are centred, so cell edges sit on half-units when a count is odd.
            position={[cols % 2 ? 0.5 : 0, 0.004, rows % 2 ? 0.5 : 0]}
            args={infinite ? undefined : [w, d]}
            infiniteGrid={infinite}
            cellSize={1}
            cellThickness={1}
            cellColor={SCENE.gridCell}
            sectionSize={1}
            sectionThickness={1}
            sectionColor={SCENE.gridCell}
            fadeDistance={s * 7}
            fadeStrength={1.5}
            renderOrder={1}
            onUpdate={noDepthWrite}
            raycast={() => null}
          />
          <Grid
            position={[cols % 2 ? 0.5 : 0, 0.005, rows % 2 ? 0.5 : 0]}
            args={infinite ? undefined : [w, d]}
            infiniteGrid={infinite}
            cellSize={5}
            cellThickness={0}
            cellColor={SCENE.gridSection}
            sectionSize={5}
            sectionThickness={1.4}
            sectionColor={SCENE.gridSection}
            fadeDistance={s * 7}
            fadeStrength={1.5}
            renderOrder={2}
            onUpdate={noDepthWrite}
            raycast={() => null}
          />
        </>
      )}

      {/* shadow layer */}
      {soft ? (
        <SoftShadows
          ref={softRef}
          width={infinite ? s * 2.8 : w - 0.1}
          depth={infinite ? s * 2.8 : d - 0.1}
          center={infinite ? [0, 0] : [cx, cx]}
          light={lightPos}
          radius={s * 0.35}
          resolution={s > 40 ? 2048 : 1024}
          color={SCENE.shadow}
          opacity={SCENE.softShadowOpacity}
          gain={SCENE.softShadowGain}
        />
      ) : (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.003, 0]} receiveShadow raycast={() => null}>
          {infinite ? <circleGeometry args={[s * 1.4, 64]} /> : <planeGeometry args={[w - 0.1, d - 0.1]} />}
          <shadowMaterial color={SCENE.shadow} opacity={SCENE.shadowOpacity} transparent depthWrite={false} />
        </mesh>
      )}
    </>
  );
});

const FLOOR_T = 0.35; // slab thickness; its top is at y = 0

/**
 * Floor layers sit a few thousandths apart; with depth writes on, they fight over
 * the same depth values (worse when zoomed out) and the grid flickers. Draw order
 * comes from renderOrder instead.
 */
function noDepthWrite(mesh: THREE.Object3D) {
  const m = (mesh as THREE.Mesh).material as THREE.Material | undefined;
  if (m?.depthWrite) {
    m.depthWrite = false;
    m.needsUpdate = true;
  }
}

/** Radial alpha ramp: opaque in the middle, fading to nothing at the rim. */
function useFadeTexture() {
  return useMemo(() => {
    const size = 256;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "#fff");
    g.addColorStop(0.08, "#fff");
    g.addColorStop(0.35, "#888");
    g.addColorStop(1, "#000");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }, []);
}

/** Screen-space AO, so bars darken where they meet each other and the floor. */
export function Effects({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return (
    <EffectComposer multisampling={4}>
      {/* Full-res on purpose: n8ao's halfRes path uses a multi-render-target
          shim that crashes on current three.js (texture getter returns an array). */}
      <N8AO aoRadius={1} distanceFalloff={1} intensity={3} />
    </EffectComposer>
  );
}
