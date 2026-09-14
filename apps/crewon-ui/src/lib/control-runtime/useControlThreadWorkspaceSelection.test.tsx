// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { controlThreadSummary } from "./controlThreadRuntime";
import { useControlThreadWorkspaceSelection } from "./useControlThreadWorkspaceSelection";
import type { ThreadView } from "@crewon/contracts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("follows the selected conversation owner and clears activation for old unbound conversations", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const activate = vi.fn(async () => undefined);
  const clear = vi.fn(async () => undefined);
  const onError = vi.fn();
  const identity = {};
  function Probe({
    threadId,
    workspaceId,
    activeWorkspaceId,
  }: {
    threadId: string | null;
    workspaceId: string | null;
    activeWorkspaceId: string | null;
  }) {
    const selectedThread = threadId
      ? controlThreadSummary({
          threadId,
          workspaceId,
          title: threadId,
          status: "active",
          revision: 1,
          lastMessageSequence: 0,
          createdAt: "2026-09-14T00:00:00Z",
          updatedAt: "2026-09-14T00:00:00Z",
          archivedAt: null,
          deletedAt: null,
          forkedFromThreadId: null,
          forkedThroughHistorySequence: null,
        } as ThreadView)
      : null;
    useControlThreadWorkspaceSelection({
      identity,
      selectedThread,
      nativeWorkspaceId: activeWorkspaceId,
      available: true,
      busy: false,
      activate,
      clear,
      onError,
    });
    return null;
  }
  try {
    await act(async () =>
      root.render(
        <Probe
          threadId="thread-a"
          workspaceId="workspace-a"
          activeWorkspaceId="workspace-b"
        />,
      ),
    );
    expect(activate).toHaveBeenCalledExactlyOnceWith("workspace-a");
    await act(async () =>
      root.render(
        <Probe
          threadId="thread-old"
          workspaceId={null}
          activeWorkspaceId="workspace-a"
        />,
      ),
    );
    expect(clear).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        <Probe
          threadId={null}
          workspaceId={null}
          activeWorkspaceId="workspace-b"
        />,
      ),
    );
    expect(clear).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
