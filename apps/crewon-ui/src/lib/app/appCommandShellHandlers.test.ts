import { describe, expect, it, vi } from "vitest";

import { createAppCommandShellHandlers } from "./appCommandShellHandlers";

describe("createAppCommandShellHandlers", () => {
  it("starts a Control-owned command-shell draft", () => {
    const setWorkMode = vi.fn();
    const startDraftThread = vi.fn();
    const handlers = createAppCommandShellHandlers({
      selectThread: vi.fn(),
      sendMessageInNewThread: vi.fn(),
      setSelectedThreadId: vi.fn(),
      setWorkMode,
      startDraftThread,
    });

    handlers.startCommandShellDraftThread();

    expect(setWorkMode).toHaveBeenCalledWith("code");
    expect(startDraftThread).toHaveBeenCalledTimes(1);
  });

  it("sends a new task without exposing a local workspace path", () => {
    const sendMessageInNewThread = vi.fn();
    const handlers = createAppCommandShellHandlers({
      selectThread: vi.fn(),
      sendMessageInNewThread,
      setSelectedThreadId: vi.fn(),
      setWorkMode: vi.fn(),
      startDraftThread: vi.fn(),
    });

    handlers.sendCommandShellMessage("Build it");

    expect(sendMessageInNewThread).toHaveBeenCalledWith(
      "Build it",
      undefined,
      null,
    );
  });
});
