import { useEffect, type RefObject } from "react";

/** A dialog inside the module, without taking over the host's top layer or focus. */
export function usePluginDialog(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
) {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const document = dialog.ownerDocument;
    const previous = document.activeElement as HTMLElement | null;
    dialog.show();
    const focusTarget =
      dialog.querySelector<HTMLElement>("[data-dialog-autofocus]") ??
      dialog.querySelector<HTMLElement>(
        "input:not(:disabled), textarea:not(:disabled), button:not(:disabled)",
      );
    focusTarget?.focus();
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      // Keep each form's existing cancellation/unknown-write lock policy.
      const Event = document.defaultView!.Event;
      if (dialog.dispatchEvent(new Event("cancel", { cancelable: true })))
        dialog.close();
    };
    dialog.addEventListener("keydown", cancel);
    return () => {
      // React may already have removed the focused field when closing the form.
      const restoreFocus =
        dialog.contains(document.activeElement) ||
        document.activeElement === document.body;
      dialog.removeEventListener("keydown", cancel);
      if (dialog.open) dialog.close();
      // A user who moved to the host keeps focus there when the module closes.
      if (restoreFocus && previous?.isConnected) previous.focus();
    };
  }, [ref, open]);
}
