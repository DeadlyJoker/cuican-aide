import React from "react";
import { createRoot } from "react-dom/client";
import {
  initializeShortDramaPreviewSurface,
  ShortDramaPluginPreview,
} from "../../apps/crewon-ui/src/components/app/ShortDramaPluginPreview";
import { getInitialTheme } from "../../apps/crewon-ui/src/lib/theme";
import { readLocalAppearance } from "../../apps/crewon-ui/src/lib/appearance/localAppearanceStore";
import { setAppliedAppearance } from "../../apps/crewon-ui/src/lib/appearance/appearanceRuntime";
import {
  resolveThemeMode,
  systemPrefersDark,
} from "../../apps/crewon-ui/src/lib/appearance/applyAppearance";
import "../../apps/crewon-ui/src/styles/tailwind.css";
import "../../apps/crewon-ui/src/styles/neutral-scale.css";
import "../../apps/crewon-ui/src/styles/app.css";
import "../../apps/crewon-ui/src/styles/original-shell-overrides.css";
import "../../apps/crewon-ui/src/styles/team-workspace.css";
import "../../apps/crewon-ui/src/styles/appearance.css";
import referenceImage from "./assets/crewon-krea2-reference.png";

initializeShortDramaPreviewSurface();
const appearance = readLocalAppearance();
const themeOverride = new URLSearchParams(window.location.search).get("theme");
if (appearance) setAppliedAppearance(appearance);
document.documentElement.dataset.theme =
  appearance && themeOverride !== "light" && themeOverride !== "dark"
    ? resolveThemeMode(appearance.themeMode, systemPrefersDark())
    : getInitialTheme();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ShortDramaPluginPreview referenceImage={referenceImage} />
  </React.StrictMode>,
);
