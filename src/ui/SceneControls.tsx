import type { ColorMode } from "../three/PivotScene3D";
import { ENVIRONMENTS, type EnvName, SHADOW_MODES, type ShadowMode } from "../three/Stage";

/** How the 3D view looks. */
export interface SceneOptions {
  colorMode: ColorMode;
  env: EnvName;
  shadows: ShadowMode;
  /** N8AO ambient occlusion (costly, so off by default). */
  ao: boolean;
}

export const DEFAULT_SCENE: SceneOptions = { colorMode: "heat", env: "studio", shadows: "soft", ao: false };

/** Toolbar controls for the 3D look (bar colors, environment, shadows, AO). */
export function SceneControls({
  value,
  onChange,
}: {
  value: SceneOptions;
  onChange: (patch: Partial<SceneOptions>) => void;
}) {
  return (
    <>
      <select
        aria-label="3D color"
        value={value.colorMode}
        onChange={(e) => onChange({ colorMode: e.target.value as ColorMode })}
      >
        <option value="heat">3D: heat colors</option>
        <option value="series">3D: series colors</option>
        <option value="white">3D: white gloss</option>
      </select>
      <select aria-label="Environment" value={value.env} onChange={(e) => onChange({ env: e.target.value as EnvName })}>
        {ENVIRONMENTS.map((n) => (
          <option key={n} value={n}>
            env: {n}
          </option>
        ))}
      </select>
      <select
        aria-label="Shadows"
        value={value.shadows}
        onChange={(e) => onChange({ shadows: e.target.value as ShadowMode })}
      >
        {SHADOW_MODES.map((n) => (
          <option key={n} value={n}>
            shadows: {n}
          </option>
        ))}
      </select>
      <label className="check">
        <input type="checkbox" checked={value.ao} onChange={(e) => onChange({ ao: e.target.checked })} />
        AO
      </label>
    </>
  );
}
