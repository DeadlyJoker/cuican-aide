import { describe, expect, it, vi } from "vitest";

import { handleNewThreadShortcutAction } from "./appKeyboardActions";

function event(overrides: Partial<Parameters<typeof handleNewThreadShortcutAction>[0]["event"]> = {}) {
  return {
    altKey: false,
    ctrlKey: false,
    key: "n",
    metaKey: true,
    preventDefault: vi.fn(),
    shiftKey: false,
    ...overrides,
  };
}

describe("app keyboard actions", () => {
  it("starts a draft thread for command/control N", () => {
    const startDraftThread = vi.fn();
    const shortcutEvent = event();

    const handled = handleNewThreadShortcutAction({
      event: shortcutEvent,
      isSending: false,
      startDraftThread,
    });

    expect(handled).toBe(true);
    expect(shortcutEvent.preventDefault).toHaveBeenCalledOnce();
    expect(startDraftThread).toHaveBeenCalledOnce();
  });

  it("prevents the shortcut without starting drafts while sending", () => {
    const startDraftThread = vi.fn();
    const shortcutEvent = event({ ctrlKey: true, metaKey: false });

    const handled = handleNewThreadShortcutAction({
      event: shortcutEvent,
      isSending: true,
      startDraftThread,
    });

    expect(handled).toBe(true);
    expect(shortcutEvent.preventDefault).toHaveBeenCalledOnce();
    expect(startDraftThread).not.toHaveBeenCalled();
  });

  it("ignores modified or unrelated keys", () => {
    const startDraftThread = vi.fn();
    const shortcutEvent = event({ altKey: true });

    const handled = handleNewThreadShortcutAction({
      event: shortcutEvent,
      isSending: false,
      startDraftThread,
    });

    expect(handled).toBe(false);
    expect(shortcutEvent.preventDefault).not.toHaveBeenCalled();
    expect(startDraftThread).not.toHaveBeenCalled();
  });
});
