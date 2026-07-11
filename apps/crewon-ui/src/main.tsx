import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AgentPlatformAuthGate } from "./components/auth/AgentPlatformAuthGate";
import "./styles/app.css";
import "./styles/original-shell-overrides.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AgentPlatformAuthGate>
      <App />
    </AgentPlatformAuthGate>
  </StrictMode>,
);
