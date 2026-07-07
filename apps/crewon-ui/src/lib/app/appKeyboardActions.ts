type KeyboardShortcutEvent = {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  preventDefault: () => void;
  shiftKey: boolean;
};

export function handleNewThreadShortcutAction(params: {
  event: KeyboardShortcutEvent;
  isSending: boolean;
  startDraftThread: () => void;
}): boolean {
  const { event, isSending, startDraftThread } = params;
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "n"
  ) {
    event.preventDefault();
    if (!isSending) {
      startDraftThread();
    }
    return true;
  }

  return false;
}
