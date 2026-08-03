import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AgentPlatformAuthGate } from "./components/auth/AgentPlatformAuthGate";
// Loaded first: the theme-aware neutral scale every other sheet resolves against.
import "./styles/neutral-scale.css";
import "./styles/app.css";
import "./styles/original-shell-overrides.css";
// Loaded last: settles the shared control surface and user appearance vars.
import "./styles/appearance.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AgentPlatformAuthGate>
      <App />
    </AgentPlatformAuthGate>
  </StrictMode>,
);
