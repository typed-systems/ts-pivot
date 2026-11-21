import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { type Ref, Suspense, useRef } from "react";
import { Bars, type BarsProps } from "./Bars";
import { Capture, type CaptureHandle } from "./Capture";
import { Effects, type EnvName, StageEnvironment } from "./Stage";
import { sceneWindow } from "./sceneWindow";
import { useWheelScroll, type WheelScrollHandler } from "./useWheelScroll";

export type { ColorMode } from "./Bars";

/**
 * 3D view of the same pivot: the rows currently visible in the 2D grid, as
 * bars (./Bars.tsx).
 *
 * Look: glossy material, HDR environment with blurred background,
 * a floor with accumulated soft shadows, and N8AO (see ./Stage.tsx).
 */

interface Props extends BarsProps {
  env: EnvName;
  ao: boolean;
  /** Imperative handle for saving the view as an image. */
  captureRef?: Ref<CaptureHandle>;
  /** Scroll the table by whole rows / columns (Shift / Alt + wheel over the 3D view). */
  onScroll?: WheelScrollHandler;
}

const intFmt = new Intl.NumberFormat("en-US");
const fmtInt = (n: number) => intFmt.format(n);

export function PivotScene3D({ env, ao, theme = "light", onScroll, captureRef, ...props }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const win = sceneWindow(props.data, props.rows, props.viewport, props.selection ?? null);
  const total = props.rows?.count ?? 0;
  const nCols = props.data?.colCount ?? 0;
  // Stop where the last full window of bars starts, so the scene never runs half empty.
  useWheelScroll(
    wrap,
    onScroll,
    win && !win.selected
      ? { maxRow: Math.max(0, total - win.layoutRows), maxCol: Math.max(0, nCols - win.layoutCols) }
      : { maxRow: 0, maxCol: 0 },
  );

  return (
    <div ref={wrap} className="scene-wrap">
      <Canvas
        shadows="soft"
        // flat = no tone mapping, so palette colors stay true under the environment light
        flat
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ position: [40, 45, 70], fov: 40, near: 0.5, far: 5000 }}
        gl={{ antialias: false, powerPreference: "high-performance" }}
      >
        <ambientLight intensity={0.12 * Math.PI} />
        <Suspense fallback={null}>
          <StageEnvironment env={env} theme={theme} />
        </Suspense>
        <Bars {...props} theme={theme} />
        <Effects enabled={ao} />
        <Capture ref={captureRef} />
        <OrbitControls makeDefault enableDamping={false} maxPolarAngle={Math.PI / 2.05} />
      </Canvas>
      {win && (
        <div className="scene-hint">
          <span>
            {win.selected && <b>selection · </b>}
            rows {fmtInt(win.r0 + 1)}–{fmtInt(win.r0 + win.rows)} of {fmtInt(total)}
            {(win.selected || nCols > win.cols) && (
              <>
                {" "}
                · cols {fmtInt(win.c0 + 1)}–{fmtInt(win.c0 + win.cols)} of {fmtInt(win.selected ? nCols + 1 : nCols)}
              </>
            )}
          </span>
          {onScroll && !win.selected && (total > win.layoutRows || nCols > win.layoutCols) && (
            <span className="scene-keys">
              {[total > win.layoutRows && "⇧ scroll: rows", nCols > win.layoutCols && "⌥ scroll: columns"]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
