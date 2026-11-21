import { useEffect, useLayoutEffect, useState } from "react";
import { applyTheme, loadThemePref, resolveTheme, saveThemePref, systemTheme, type ThemePref } from "../theme/theme";

/**
 * The chosen theme (system / light / dark, remembered), the theme in effect, and
 * a cycle action for the toolbar button. Applies the theme to the page and the
 * live GRID / SCENE color objects.
 */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(loadThemePref);
  const [systemDark, setSystemDark] = useState(() => systemTheme() === "dark");

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const theme = pref === "system" ? (systemDark ? "dark" : "light") : resolveTheme(pref);
  // Layout effect: canvases redraw in their (passive) effects, after this has run.
  useLayoutEffect(() => applyTheme(theme), [theme]);

  const cycle = () => {
    const next: ThemePref = pref === "system" ? "light" : pref === "light" ? "dark" : "system";
    setPref(next);
    saveThemePref(next);
  };

  return { theme, pref, cycle };
}
