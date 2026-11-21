import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Geist Mono, the font kasouka uses, bundled locally (no Google Fonts request).
// Weights: 400 = regular text, 500 = bold (one step lighter than the usual 600).
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./styles.css";
import { applyTheme, loadThemePref, resolveTheme } from "./theme/theme";

// Apply the saved theme before the first paint (no light flash in dark mode).
applyTheme(resolveTheme(loadThemePref()));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
