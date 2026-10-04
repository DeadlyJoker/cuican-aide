import { useEffect, useRef } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { controlThreadWorkspaceId } from "./controlThreadWorkspace";

export function useControlWorkspaceCreationScope(
  identity: object | null,
  workspaceId: string | null | undefined,
) {
  const current = useRef({ identity, workspaceId });
  current.current = { identity, workspaceId };
  return () =>
    current.current.identity === identity &&
    current.current.workspaceId === workspaceId;
}

/** Selecting a persisted conversation follows its owner; choosing a folder never rewrites it. */
export function useControlThreadWorkspaceSelection(input: {
  identity: object | null;
  selectedThread: Thread | null;
  nativeWorkspaceId: string | null;
  available: boolean;
  busy: boolean;
  activate: (workspaceId: string) => Promise<void>;
  clear: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const latest = useRef(input);
  latest.current = input;
  const attempted = useRef<{
    identity: object | null;
    selection: string;
  } | null>(null);
  const threadId = input.selectedThread?.id ?? null;
  const workspaceId = controlThreadWorkspaceId(input.selectedThread);
  useEffect(() => {
    if (!threadId) {
      attempted.current = null;
      return;
    }
    if (!input.available || input.busy) return;
    const selection = JSON.stringify([threadId, workspaceId]);
    if (
      attempted.current?.identity === input.identity &&
      attempted.current.selection === selection
    )
      return;
    attempted.current = { identity: input.identity, selection };
    if (input.nativeWorkspaceId === workspaceId) return;
    const current = latest.current;
    void (
      workspaceId === null ? current.clear() : current.activate(workspaceId)
    ).catch(() => {
      if (
        latest.current.identity === current.identity &&
        latest.current.selectedThread?.id === threadId
      ) {
        latest.current.onError(
          "无法打开此会话所属的工作空间，请检查目录是否仍可用。",
        );
      }
    });
  }, [
    input.identity,
    threadId,
    workspaceId,
    input.available,
    input.busy,
    input.nativeWorkspaceId,
  ]);
}
