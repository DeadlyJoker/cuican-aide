import { useEffect, useRef, useState } from "react";

export type TaskDetailWorkspaceGitClient = {
  readSandboxGitSummary(
    threadId: null,
    options?: { signal?: AbortSignal },
  ): Promise<{
    additions: number | null;
    branch: string | null;
    changedFiles: number | null;
    cwd: string;
    deletions: number | null;
    head: string | null;
    isGitRepository: boolean;
    statsComplete: boolean;
  }>;
};

export type TaskDetailWorkspaceGitData = Readonly<{
  branch: string | null;
  changes: Readonly<{
    additions: number;
    deletions: number;
    files: number;
  }> | null;
  head: string | null;
  isGitRepository: boolean;
  statsComplete: boolean;
}>;

export type TaskDetailWorkspaceGitState = Readonly<{
  data: TaskDetailWorkspaceGitData | null;
  error: string | null;
  scopeKey: string;
  status: "idle" | "loading" | "ready" | "error" | "forbidden" | "unavailable";
}>;

type TaskDetailWorkspaceGitStateUpdater = (
  current: TaskDetailWorkspaceGitState,
) => TaskDetailWorkspaceGitState;

type TaskDetailWorkspaceGitStatePublisher = (
  updater: TaskDetailWorkspaceGitStateUpdater,
) => void;

function initialState(
  status: TaskDetailWorkspaceGitState["status"],
  scopeKey: string,
): TaskDetailWorkspaceGitState {
  return { data: null, error: null, scopeKey, status };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTaskDetailWorkspaceGitPermissionError(
  error: unknown,
): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : null;
  return (
    status === 401 ||
    status === 403 ||
    /(?:\b40[13]\b|forbidden|permission denied|access denied|unauthori[sz]ed)/iu.test(
      errorText(error),
    )
  );
}

export function summarizeTaskDetailWorkspaceGit(view: {
  additions: number | null;
  branch: string | null;
  changedFiles: number | null;
  deletions: number | null;
  head: string | null;
  isGitRepository: boolean;
  statsComplete: boolean;
}): TaskDetailWorkspaceGitData {
  const changes =
    view.isGitRepository === true &&
    view.statsComplete &&
    view.changedFiles !== null &&
    view.additions !== null &&
    view.deletions !== null
      ? {
          additions: view.additions,
          deletions: view.deletions,
          files: view.changedFiles,
        }
      : null;
  return {
    branch: view.branch,
    changes,
    head: view.head,
    isGitRepository: view.isGitRepository,
    statsComplete: view.statsComplete,
  };
}

export function taskDetailWorkspaceGitStateForContext({
  available,
  open,
  scopeKey,
  state,
}: {
  available: boolean;
  open: boolean;
  scopeKey: string;
  state: TaskDetailWorkspaceGitState;
}): TaskDetailWorkspaceGitState {
  if (!open) return initialState("idle", scopeKey);
  if (!available) return initialState("unavailable", scopeKey);
  return state.scopeKey === scopeKey
    ? state
    : initialState("loading", scopeKey);
}

export function taskDetailWorkspaceGitStateForRefresh(
  current: TaskDetailWorkspaceGitState,
  scopeKey: string,
): TaskDetailWorkspaceGitState {
  return current.scopeKey === scopeKey && current.data !== null
    ? { ...current, error: null, status: "loading" }
    : initialState("loading", scopeKey);
}

/**
 * Owns the lifetime of the single in-flight workspace Git request. Keeping the
 * generation check beside the AbortController is intentional: some transports
 * can still resolve after an abort, and that stale result must never cross a
 * workspace boundary.
 */
export function createTaskDetailWorkspaceGitRequestController(): {
  invalidate(): void;
  refresh(input: {
    client: TaskDetailWorkspaceGitClient;
    publish: TaskDetailWorkspaceGitStatePublisher;
    scopeKey: string;
  }): () => void;
} {
  let activeController: AbortController | null = null;
  let generation = 0;

  const invalidate = () => {
    generation += 1;
    activeController?.abort();
    activeController = null;
  };

  return {
    invalidate,
    refresh: ({ client, publish, scopeKey }) => {
      invalidate();
      const requestGeneration = generation;
      const controller = new AbortController();
      activeController = controller;

      publish((current) =>
        taskDetailWorkspaceGitStateForRefresh(current, scopeKey),
      );

      void client
        .readSandboxGitSummary(null, { signal: controller.signal })
        .then((response) => {
          if (controller.signal.aborted || generation !== requestGeneration) {
            return;
          }
          publish(() => ({
            data: summarizeTaskDetailWorkspaceGit(response),
            error: null,
            scopeKey,
            status: "ready",
          }));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || generation !== requestGeneration) {
            return;
          }
          const permissionDenied =
            isTaskDetailWorkspaceGitPermissionError(error);
          publish((current) =>
            permissionDenied
              ? initialState("forbidden", scopeKey)
              : {
                  data: current.scopeKey === scopeKey ? current.data : null,
                  error: errorText(error),
                  scopeKey,
                  status: "error",
                },
          );
        });

      return () => {
        controller.abort();
        if (activeController === controller) {
          activeController = null;
        }
      };
    },
  };
}

/**
 * Reads the current workspace's branch-wide Git summary. It is intentionally
 * global: task-attributed edits come from durable Thread file-change records.
 */
export function useTaskDetailWorkspaceGit({
  client,
  enabled,
  open,
  refreshKey,
  workspaceScopeKey,
}: {
  client: TaskDetailWorkspaceGitClient | null | undefined;
  enabled: boolean;
  open: boolean;
  refreshKey?: string | number | null;
  workspaceScopeKey?: string | number | null;
}): TaskDetailWorkspaceGitState {
  const scopeKey = String(workspaceScopeKey ?? "workspace");
  const [state, setState] = useState<TaskDetailWorkspaceGitState>(() =>
    initialState("idle", scopeKey),
  );
  const requestControllerRef = useRef<ReturnType<
    typeof createTaskDetailWorkspaceGitRequestController
  > | null>(null);
  if (requestControllerRef.current === null) {
    requestControllerRef.current =
      createTaskDetailWorkspaceGitRequestController();
  }

  useEffect(() => {
    const requestController = requestControllerRef.current;
    if (requestController === null) return;

    if (!open) {
      requestController.invalidate();
      setState(initialState("idle", scopeKey));
      return;
    }
    if (!enabled || !client) {
      requestController.invalidate();
      setState(initialState("unavailable", scopeKey));
      return;
    }

    return requestController.refresh({
      client,
      publish: setState,
      scopeKey,
    });
  }, [client, enabled, open, refreshKey, scopeKey]);

  return taskDetailWorkspaceGitStateForContext({
    available: enabled && client !== null && client !== undefined,
    open,
    scopeKey,
    state,
  });
}
