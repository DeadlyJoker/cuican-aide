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
    const setDraftWorkspaceCwd = vi.fn();
    const startDraftThread = vi.fn();
    const handlers = createAppCommandShellHandlers({
      selectThread: vi.fn(),
      sendMessageInNewThread: vi.fn(),
      setComposerFocusSignal: vi.fn(),
      setDraftWorkspaceCwd,
      setSelectedThreadId: vi.fn(),
      setWorkMode,
      startDraftThread,
    });

    handlers.startCommandShellDraftThread();

    expect(setWorkMode).toHaveBeenCalledWith("code");
    expect(setDraftWorkspaceCwd).toHaveBeenCalledWith(null);
    expect(startDraftThread).toHaveBeenCalledTimes(1);
  });

  it("forwards the selected workspace when sending a new task", () => {
    const sendMessageInNewThread = vi.fn();
    const handlers = createAppCommandShellHandlers({
      selectThread: vi.fn(),
      sendMessageInNewThread,
      setComposerFocusSignal: vi.fn(),
      setDraftWorkspaceCwd: vi.fn(),
      setSelectedThreadId: vi.fn(),
      setWorkMode: vi.fn(),
      startDraftThread: vi.fn(),
    });

    handlers.sendCommandShellMessage("Build it", undefined, "/repo/frontend");

    expect(sendMessageInNewThread).toHaveBeenCalledWith(
      "Build it",
      undefined,
      "/repo/frontend",
    );
  });
});
