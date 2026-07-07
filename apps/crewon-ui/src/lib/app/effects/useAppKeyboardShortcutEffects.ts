import { useEffect } from "react";

import { handleNewThreadShortcutAction } from "../appKeyboardActions";

export type AppKeyboardShortcutEffectsParams = {
  isSending: boolean;
  startDraftThread: () => void;
};

export function useAppKeyboardShortcutEffects({
  isSending,
  startDraftThread,
}: AppKeyboardShortcutEffectsParams) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      handleNewThreadShortcutAction({
        event,
        isSending,
        startDraftThread,
      });
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSending, startDraftThread]);
}
