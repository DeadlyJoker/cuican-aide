import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AgentPlatformAuthGate } from "./components/auth/AgentPlatformAuthGate";
import { DesktopWindowFrame } from "./components/DesktopWindowFrame";
import { Toaster } from "./components/ui/sonner";
import { installDesktopFetch } from "./lib/desktop/desktopFetch";
import { detectRuntimeSurface } from "./lib/platform";
import { loadControlApiClient } from "./lib/control-runtime/controlRuntimeBootstrap";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "./lib/agent-platform/agentPlatformClient";
import { DESKTOP_PROVIDER_CHANGED_EVENT } from "./lib/model-provider/providerCredentialStore";
// Captured before the auth gate mounts: extracts a PIM launch token from
// the URL (if present), stores it in sessionStorage, and cleans the URL
// so the token is never bookmarked or shared.
import "./lib/agent-platform/pimLaunchBridge";
import "./styles/tailwind.css";
// Loaded first: the theme-aware neutral scale every other sheet resolves against.
import "./styles/neutral-scale.css";
import "./styles/app.css";
import "./styles/original-shell-overrides.css";
// Loaded last: settles the shared control surface and user appearance vars.
import "./styles/appearance.css";

/*
 * The surface decides whether the shell rounds its own corners, and it is a
 * property of the runtime rather than a user preference. Written here so the
 * first paint is already correct: the appearance pass runs after the local
 * runtime connects, which would pop the corners in on connect and leave them square
 * whenever the connection fails.
 */
document.documentElement.dataset.surface = detectRuntimeSurface();

/*
 * Awaited before the first render, not alongside it: the auth gate fetches on
 * mount, and a packaged build needs the desktop request bridge in place by then or
 * that request is blocked by the webview's CORS rules.
 */
await installDesktopFetch();

type ControlClient = Awaited<ReturnType<typeof loadControlApiClient>>;

function CrewonRoot() {
  const [controlClient, setControlClient] = useState<ControlClient>(null);

  useEffect(() => {
    let active = true;
    let generation = 0;
    const reloadControlClient = () => {
      const requestedGeneration = ++generation;
      void loadControlApiClient().then((client) => {
        if (active && requestedGeneration === generation) {
          setControlClient(client);
        }
      });
    };
    reloadControlClient();
    window.addEventListener(
      AGENT_PLATFORM_SESSION_CHANGED_EVENT,
      reloadControlClient,
    );
    window.addEventListener(
      DESKTOP_PROVIDER_CHANGED_EVENT,
      reloadControlClient,
    );
    return () => {
      active = false;
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        reloadControlClient,
      );
      window.removeEventListener(
        DESKTOP_PROVIDER_CHANGED_EVENT,
        reloadControlClient,
      );
    };
  }, []);

  return (
    <DesktopWindowFrame>
      <AgentPlatformAuthGate>
        <App controlClient={controlClient} />
      </AgentPlatformAuthGate>
      <Toaster closeButton gap={6} offset={52} position="top-right" />
    </DesktopWindowFrame>
  );
}

/*
 * The window frame sits *outside* the auth gate so the login and connecting
 * screens get the same controls and drag region as the workspace. Mounting it
 * per route is what left the login screen with no way to close or move the
 * window.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrewonRoot />
  </StrictMode>,
);
