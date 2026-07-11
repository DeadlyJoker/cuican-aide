import { describe, expect, it, vi } from "vitest";

import { createAppCommandShellHandlers } from "./appCommandShellHandlers";

describe("createAppCommandShellHandlers", () => {
  it("switches draft conversations into a selected workspace", () => {
    const setDraftWorkspaceCwd = vi.fn();
    const setSelectedThreadId = vi.fn();
    const setWorkMode = vi.fn();
    const setComposerFocusSignal = vi.fn();
    const handlers = createAppCommandShellHandlers({
      selectThread: vi.fn(),
      sendMessageInNewThread: vi.fn(),
      setComposerFocusSignal,
      setDraftWorkspaceCwd,
      setSelectedThreadId,
      setWorkMode,
      startDraftThread: vi.fn(),
    });

    handlers.changeCommandShellWorkspace(" /repo/frontend ");

    expect(setDraftWorkspaceCwd).toHaveBeenCalledWith("/repo/frontend");
    expect(setSelectedThreadId).toHaveBeenCalledWith(null);
    expect(setWorkMode).toHaveBeenCalledWith("code");
    expect(setComposerFocusSignal).toHaveBeenCalledWith(expect.any(Function));
  });

  it("starts a blank command-shell draft", () => {
    const setWorkMode = vi.fn();
    const startDraftThread = vi.fn();
    const handlers = createAppCommandShellHandlers({
      selectThread: vi.fn(),
      sendMessageInNewThread: vi.fn(),
      setComposerFocusSignal: vi.fn(),
      setDraftWorkspaceCwd: vi.fn(),
      setSelectedThreadId: vi.fn(),
      setWorkMode,
      startDraftThread,
    });

    handlers.startCommandShellDraftThread();

    expect(setWorkMode).toHaveBeenCalledWith("code");
    expect(startDraftThread).toHaveBeenCalledTimes(1);
  });
});
