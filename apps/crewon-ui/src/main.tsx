import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AgentPlatformAuthGate } from "./components/auth/AgentPlatformAuthGate";
import { DesktopWindowFrame } from "./components/DesktopWindowFrame";
import { StartupBoundary } from "./components/StartupBoundary";
import { Toaster } from "./components/ui/sonner";
import { installDesktopFetch } from "./lib/desktop/desktopFetch";
import { detectRuntimeSurface } from "./lib/platform";
// Captured before the auth gate mounts: extracts a PIM launch token from
// the URL (if present), stores it in sessionStorage, and cleans the URL
// so the token is never bookmarked or shared.
import "./lib/agent-platform/pimLaunchBridge";

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
// Keep HTML paint independent from the external stylesheet transfer.
let startupStylesFailed = false;
await import("./startupStyles").catch(() => {
  startupStylesFailed = true;
});

const WorkspaceApp = lazy(() => import("./WorkspaceApp"));
function StartupStyleFailure(): never {
  throw new Error("startup_styles_unavailable");
}

function CrewonRoot() {
  return (
    <DesktopWindowFrame>
      <StartupBoundary>
        {startupStylesFailed ? (
          <StartupStyleFailure />
        ) : (
          <AgentPlatformAuthGate>
            <Suspense
              fallback={
                <div role="status" className="crewon-startup">
                  正在打开工作台…
                </div>
              }
            >
              <WorkspaceApp />
            </Suspense>
          </AgentPlatformAuthGate>
        )}
      </StartupBoundary>
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
