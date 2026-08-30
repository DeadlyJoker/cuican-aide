import { useRef, useState } from "react";

import type { CommandScene } from "../scene/sceneCatalog";
import {
  getInitialCapabilityDockOpen,
  getInitialSidebarOpen,
} from "./appUiState";

export function useAppChromeState() {
  const [sidebarOpen, setSidebarOpen] = useState(getInitialSidebarOpen);
  const [capabilityDockOpen, setCapabilityDockOpen] = useState(
    getInitialCapabilityDockOpen,
  );
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [commandScene, setCommandScene] = useState<CommandScene>("office");
  const capabilityDockOpenRef = useRef(capabilityDockOpen);
  const inspectorOpenRef = useRef(inspectorOpen);
  capabilityDockOpenRef.current = capabilityDockOpen;
  inspectorOpenRef.current = inspectorOpen;
  /*
   * The settings and library surfaces auto-hide the workbench and inspector
   * to make room. Snapshot what was open so returning to the chat surface
   * restores exactly what the user had, instead of leaving the panels closed
   * with only a subtle trigger to bring them back. A panel the user closed
   * themselves stays closed.
   */
  const autoClosedRef = useRef({ dock: false, inspector: false });

  const autoCloseChrome = () => {
    autoClosedRef.current = {
      dock: capabilityDockOpenRef.current,
      inspector: inspectorOpenRef.current,
    };
    setCapabilityDockOpen(false);
    setInspectorOpen(false);
  };

  const restoreAutoClosedChrome = () => {
    if (autoClosedRef.current.dock) {
      setCapabilityDockOpen(true);
    }
    if (autoClosedRef.current.inspector) {
      setInspectorOpen(true);
    }
    autoClosedRef.current = { dock: false, inspector: false };
  };

  return {
    autoCloseChrome,
    capabilityDockOpen,
    commandScene,
    inspectorOpen,
    restoreAutoClosedChrome,
    setCapabilityDockOpen,
    setCommandScene,
    setInspectorOpen,
    setSidebarOpen,
    sidebarOpen,
  };
}
