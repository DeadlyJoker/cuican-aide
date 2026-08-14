import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DesktopWindowFrame } from "./components/DesktopWindowFrame";
import { ControlRuntimeUnavailable } from "./components/ControlRuntimeUnavailable";
import { detectRuntimeSurface } from "./lib/platform";
import { loadControlApiClient } from "./lib/control-runtime/controlRuntimeBootstrap";
// Loaded first: the theme-aware neutral scale every other sheet resolves against.
import "./styles/neutral-scale.css";
import "./styles/app.css";
import "./styles/original-shell-overrides.css";
import "./styles/workspace-readonly.css";
// Loaded last: settles the shared control surface and user appearance vars.
import "./styles/appearance.css";

/*
 * The surface decides whether the shell rounds its own corners, and it is a
 * property of the runtime rather than a user preference. Written here so the
 * first paint is already correct before Control settings and React effects
 * hydrate the rest of the shell.
 */
document.documentElement.dataset.surface = detectRuntimeSurface();

// Control must issue a renderer session before any product UI can mount.
const controlClient = await loadControlApiClient();

/*
 * Keep the frame around the unavailable state so desktop window controls remain
 * usable even when Control cannot issue that session.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesktopWindowFrame>
      {controlClient === null ? (
        <ControlRuntimeUnavailable />
      ) : (
        <App controlClient={controlClient} />
      )}
    </DesktopWindowFrame>
  </StrictMode>,
);
