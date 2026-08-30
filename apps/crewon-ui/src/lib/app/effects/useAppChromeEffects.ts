import { useEffect } from "react";

import {
  closeChromeOnEscapeAction,
  closeCrampedInspectorAction,
  closeInspectorFromOutsideTargetAction,
} from "../appViewActions";
import { observeWindowCornerState } from "../../desktop/windowCornerState";

export type AppChromeEffectsParams = {
  capabilityDockOpen: boolean;
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  shouldAutoCloseInspector: (
    sidebarOpen: boolean,
    capabilityDockOpen: boolean,
  ) => boolean;
  sidebarOpen: boolean;
};

export function useAppChromeEffects({
  capabilityDockOpen,
  inspectorOpen,
  setInspectorOpen,
  setSidebarOpen,
  shouldAutoCloseInspector,
  sidebarOpen,
}: AppChromeEffectsParams) {
  // The undecorated window draws its own corners, so the shells need to know
  // when there is no exposed corner left to round.
  useEffect(() => observeWindowCornerState(), []);

  useEffect(() => {
    if (!sidebarOpen && !inspectorOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      closeChromeOnEscapeAction({
        event,
        setInspectorOpen,
        setSidebarOpen,
      });
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inspectorOpen, setInspectorOpen, setSidebarOpen, sidebarOpen]);

  useEffect(() => {
    if (!inspectorOpen) {
      return;
    }

    function handleClick(event: MouseEvent) {
      closeInspectorFromOutsideTargetAction({
        setInspectorOpen,
        target: event.target,
      });
    }

    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [inspectorOpen, setInspectorOpen]);

  useEffect(() => {
    if (!inspectorOpen) {
      return;
    }

    function closeInspectorIfCramped() {
      closeCrampedInspectorAction({
        capabilityDockOpen,
        setInspectorOpen,
        shouldAutoCloseInspector,
        sidebarOpen,
      });
    }

    closeInspectorIfCramped();
    window.addEventListener("resize", closeInspectorIfCramped);
    return () => window.removeEventListener("resize", closeInspectorIfCramped);
  }, [
    capabilityDockOpen,
    inspectorOpen,
    setInspectorOpen,
    shouldAutoCloseInspector,
    sidebarOpen,
  ]);
}
