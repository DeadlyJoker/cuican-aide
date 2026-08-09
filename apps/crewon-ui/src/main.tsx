import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AgentPlatformAuthGate } from "./components/auth/AgentPlatformAuthGate";
import { DesktopWindowFrame } from "./components/DesktopWindowFrame";
import { installDesktopFetch } from "./lib/desktop/desktopFetch";
import { detectRuntimeSurface } from "./lib/platform";
import { loadControlApiClient } from "./lib/control-runtime/controlRuntimeBootstrap";
// Captured before the auth gate mounts: extracts a PIM launch token from
// the URL (if present), stores it in sessionStorage, and cleans the URL
// so the token is never bookmarked or shared.
import "./lib/agent-platform/pimLaunchBridge";
// Loaded first: the theme-aware neutral scale every other sheet resolves against.
import "./styles/neutral-scale.css";
import "./styles/app.css";
import "./styles/original-shell-overrides.css";
// Loaded last: settles the shared control surface and user appearance vars.
import "./styles/appearance.css";

/*
 * The surface decides whether the shell rounds its own corners, and it is a
 * property of the runtime rather than a user preference. Written here so the
 * first paint is already correct: the appearance pass runs after the app-server
 * connects, which would pop the corners in on connect and leave them square
 * whenever the connection fails.
 */
document.documentElement.dataset.surface = detectRuntimeSurface();

/*
 * Awaited before the first render, not alongside it: the auth gate fetches on
 * mount, and a packaged build needs the Tauri-backed fetch in place by then or
 * that request is blocked by the webview's CORS rules.
 */
await installDesktopFetch();
const controlClient = await loadControlApiClient();

/*
 * The window frame sits *outside* the auth gate so the login and connecting
 * screens get the same controls and drag region as the workspace. Mounting it
 * per route is what left the login screen with no way to close or move the
 * window.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesktopWindowFrame>
      <AgentPlatformAuthGate>
        <App controlClient={controlClient} />
      </AgentPlatformAuthGate>
    </DesktopWindowFrame>
  </StrictMode>,
);
