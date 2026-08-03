import { describe, expect, it, vi } from "vitest";

import {
  commandShellWorkspaceUrl,
  createAppCommandShellHandlers,
} from "./appCommandShellHandlers";

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

  it("starts an explicitly workspace-less command-shell draft", () => {
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

    handlers.startCommandShellDraftThread(null);

    expect(setWorkMode).toHaveBeenCalledWith("code");
    expect(setDraftWorkspaceCwd).toHaveBeenCalledWith(null);
    expect(startDraftThread).toHaveBeenCalledTimes(1);
  });

  it("keeps the current workspace when starting a new command-shell draft", () => {
    const setDraftWorkspaceCwd = vi.fn();
    const handlers = createAppCommandShellHandlers({
      selectThread: vi.fn(),
      sendMessageInNewThread: vi.fn(),
      setComposerFocusSignal: vi.fn(),
      setDraftWorkspaceCwd,
      setSelectedThreadId: vi.fn(),
      setWorkMode: vi.fn(),
      startDraftThread: vi.fn(),
    });

    handlers.startCommandShellDraftThread(" /repo/frontend ");

    expect(setDraftWorkspaceCwd).toHaveBeenCalledWith("/repo/frontend");
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

describe("commandShellWorkspaceUrl", () => {
  it("restores the workspace without dropping unrelated search params", () => {
    expect(
      commandShellWorkspaceUrl(
        "http://127.0.0.1:5175/?cwd=%2Frepo%2Fold&teamCwd=%2Frepo%2Fteam#view-team",
        " /repo/frontend ",
      ),
    ).toBe(
      "/?cwd=%2Frepo%2Ffrontend&teamCwd=%2Frepo%2Fteam#view-command",
    );
  });

  it("requires an explicit empty workspace", () => {
    expect(
      commandShellWorkspaceUrl(
        "http://127.0.0.1:5175/?cwd=%2Frepo%2Ffrontend&teamCwd=%2Frepo%2Fteam#view-team",
        null,
      ),
    ).toBe("/?cwd=&teamCwd=%2Frepo%2Fteam#view-command");
  });
});
