import { useState } from "react";

import { getInitialSidebarOpen } from "./appUiState";

export function useAppChromeState() {
  const [sidebarOpen, setSidebarOpen] = useState(getInitialSidebarOpen);
  const [capabilityDockOpen, setCapabilityDockOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  return {
    capabilityDockOpen,
    inspectorOpen,
    setCapabilityDockOpen,
    setInspectorOpen,
    setSidebarOpen,
    sidebarOpen,
  };
}
