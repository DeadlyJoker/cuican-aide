import { commandSearchShortcutRequested } from "./commandNavigationKeyboard";
import { useEffect } from "react";

export function useCommandSidebarSearchShortcut({
  available,
  isOpen,
  onClose,
  onOpen,
}: {
  available: boolean;
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
}) {
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (!available || !commandSearchShortcutRequested(event)) return;
      if (
        document.querySelector(
          '[aria-modal="true"]:not([data-command-search-dialog]), [role="menu"][data-state="open"]',
        )
      )
        return;
      event.preventDefault();
      if (isOpen) {
        onClose();
      } else {
        onOpen();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [available, isOpen, onClose, onOpen]);
}
