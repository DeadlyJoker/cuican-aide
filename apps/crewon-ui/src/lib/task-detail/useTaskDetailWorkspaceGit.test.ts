import { describe, expect, it, vi } from "vitest";

import {
  createTaskDetailWorkspaceGitRequestController,
  isTaskDetailWorkspaceGitPermissionError,
  summarizeTaskDetailWorkspaceGit,
  taskDetailWorkspaceGitStateForContext,
  taskDetailWorkspaceGitStateForRefresh,
  type TaskDetailWorkspaceGitClient,
  type TaskDetailWorkspaceGitState,
} from "./useTaskDetailWorkspaceGit";

type GitSummaryResponse = Awaited<
  ReturnType<TaskDetailWorkspaceGitClient["readSandboxGitSummary"]>
>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function gitSummary(branch: string, additions: number): GitSummaryResponse {
  return {
    additions,
    branch,
    changedFiles: 1,
    cwd: `/workspace/${branch}`,
    deletions: 1,
    head: branch.repeat(40).slice(0, 40),
    isGitRepository: true,
    statsComplete: true,
  };
}

describe("task detail workspace Git", () => {
  it("uses authoritative branch-wide statistics without accepting diff text", () => {
    expect(
      summarizeTaskDetailWorkspaceGit({
        additions: 21_744,
        branch: "codex/task-detail",
        changedFiles: 437,
        deletions: 1_211_153,
        head: "0".repeat(40),
        isGitRepository: true,
        statsComplete: true,
      }),
    ).toEqual({
      branch: "codex/task-detail",
      changes: {
        additions: 21_744,
        deletions: 1_211_153,
        files: 437,
      },
      head: "0".repeat(40),
      isGitRepository: true,
      statsComplete: true,
    });
  });

  it("keeps a clean repository as an authoritative zero-change result", () => {
    expect(
      summarizeTaskDetailWorkspaceGit({
        additions: 0,
        branch: "main",
        changedFiles: 0,
        deletions: 0,
        head: null,
        isGitRepository: true,
        statsComplete: true,
      }),
    ).toMatchObject({
      changes: { additions: 0, deletions: 0, files: 0 },
    });
  });

  it("does not present incomplete statistics as exact branch changes", () => {
    expect(
      summarizeTaskDetailWorkspaceGit({
        additions: null,
        branch: null,
        changedFiles: null,
        deletions: null,
        head: null,
        isGitRepository: true,
        statsComplete: false,
      }).changes,
    ).toBeNull();
  });

  it("keeps the global current-workspace result across task navigation", () => {
    const current = {
      data: {
        branch: "main",
        changes: { additions: 5, deletions: 1, files: 2 },
        head: null,
        isGitRepository: true as const,
        statsComplete: true,
      },
      error: null,
      scopeKey: "workspace:4",
      status: "ready" as const,
    };

    expect(
      taskDetailWorkspaceGitStateForContext({
        available: true,
        open: true,
        scopeKey: "workspace:4",
        state: current,
      }),
    ).toBe(current);
  });

  it("clears workspace data synchronously when the panel or authority is unavailable", () => {
    const current = {
      data: {
        branch: "private-workspace",
        changes: { additions: 5, deletions: 1, files: 2 },
        head: null,
        isGitRepository: true as const,
        statsComplete: true,
      },
      error: null,
      scopeKey: "workspace:4",
      status: "ready" as const,
    };

    expect(
      taskDetailWorkspaceGitStateForContext({
        available: false,
        open: true,
        scopeKey: "workspace:5",
        state: current,
      }),
    ).toEqual({
      data: null,
      error: null,
      scopeKey: "workspace:5",
      status: "unavailable",
    });
    expect(
      taskDetailWorkspaceGitStateForContext({
        available: true,
        open: false,
        scopeKey: "workspace:5",
        state: current,
      }),
    ).toMatchObject({ data: null, status: "idle" });
  });

  it("clears stale data synchronously when the workspace revision changes", () => {
    expect(
      taskDetailWorkspaceGitStateForContext({
        available: true,
        open: true,
        scopeKey: "workspace:next",
        state: {
          data: {
            branch: "stale",
            changes: { additions: 1, deletions: 0, files: 1 },
            head: null,
            isGitRepository: true,
            statsComplete: true,
          },
          error: null,
          scopeKey: "workspace:previous",
          status: "ready",
        },
      }),
    ).toEqual({
      data: null,
      error: null,
      scopeKey: "workspace:next",
      status: "loading",
    });
  });

  it("keeps the last exact result visible while refreshing the same workspace", () => {
    const current = {
      data: {
        branch: "main",
        changes: { additions: 7, deletions: 2, files: 3 },
        head: "a".repeat(40),
        isGitRepository: true as const,
        statsComplete: true,
      },
      error: null,
      scopeKey: "workspace:4",
      status: "ready" as const,
    };

    expect(
      taskDetailWorkspaceGitStateForRefresh(current, "workspace:4"),
    ).toEqual({ ...current, status: "loading" });
    expect(
      taskDetailWorkspaceGitStateForRefresh(current, "workspace:5"),
    ).toEqual({
      data: null,
      error: null,
      scopeKey: "workspace:5",
      status: "loading",
    });
  });

  it("does not let a late workspace A response overwrite workspace B", async () => {
    const workspaceA = deferred<GitSummaryResponse>();
    const workspaceB = deferred<GitSummaryResponse>();
    const client: TaskDetailWorkspaceGitClient = {
      readSandboxGitSummary: vi
        .fn()
        .mockReturnValueOnce(workspaceA.promise)
        .mockReturnValueOnce(workspaceB.promise),
    };
    const controller = createTaskDetailWorkspaceGitRequestController();
    let state: TaskDetailWorkspaceGitState = {
      data: null,
      error: null,
      scopeKey: "workspace:A",
      status: "idle",
    };
    const publish = (
      updater: (
        current: TaskDetailWorkspaceGitState,
      ) => TaskDetailWorkspaceGitState,
    ) => {
      state = updater(state);
    };

    const stopWorkspaceA = controller.refresh({
      client,
      publish,
      scopeKey: "workspace:A",
    });
    expect(state).toMatchObject({ scopeKey: "workspace:A", status: "loading" });

    stopWorkspaceA();
    controller.refresh({
      client,
      publish,
      scopeKey: "workspace:B",
    });
    expect(state).toEqual({
      data: null,
      error: null,
      scopeKey: "workspace:B",
      status: "loading",
    });

    // Model an abort-uncooperative transport: A still resolves after B starts.
    workspaceA.resolve(gitSummary("stale-a", 99));
    await workspaceA.promise;
    await Promise.resolve();
    expect(state).toEqual({
      data: null,
      error: null,
      scopeKey: "workspace:B",
      status: "loading",
    });

    workspaceB.resolve(gitSummary("fresh-b", 7));
    await workspaceB.promise;
    await Promise.resolve();
    expect(state).toMatchObject({
      data: {
        branch: "fresh-b",
        changes: { additions: 7, deletions: 1, files: 1 },
      },
      scopeKey: "workspace:B",
      status: "ready",
    });
  });

  it("keeps same-scope data visible while an asynchronous refresh loads", async () => {
    const refresh = deferred<GitSummaryResponse>();
    const client: TaskDetailWorkspaceGitClient = {
      readSandboxGitSummary: vi.fn(() => refresh.promise),
    };
    const controller = createTaskDetailWorkspaceGitRequestController();
    const previousData = {
      branch: "main",
      changes: { additions: 7, deletions: 2, files: 3 },
      head: "a".repeat(40),
      isGitRepository: true,
      statsComplete: true,
    } as const;
    let state: TaskDetailWorkspaceGitState = {
      data: previousData,
      error: "old error",
      scopeKey: "workspace:same",
      status: "ready",
    };

    controller.refresh({
      client,
      publish: (updater) => {
        state = updater(state);
      },
      scopeKey: "workspace:same",
    });

    expect(state).toEqual({
      data: previousData,
      error: null,
      scopeKey: "workspace:same",
      status: "loading",
    });

    refresh.resolve(gitSummary("main", 11));
    await refresh.promise;
    await Promise.resolve();
    expect(state).toMatchObject({
      data: {
        branch: "main",
        changes: { additions: 11, deletions: 1, files: 1 },
      },
      scopeKey: "workspace:same",
      status: "ready",
    });
  });

  it("keeps the last exact same-scope result when a refresh fails", async () => {
    const refresh = deferred<GitSummaryResponse>();
    const client: TaskDetailWorkspaceGitClient = {
      readSandboxGitSummary: vi.fn(() => refresh.promise),
    };
    const controller = createTaskDetailWorkspaceGitRequestController();
    const previousData = {
      branch: "main",
      changes: { additions: 7, deletions: 2, files: 3 },
      head: "a".repeat(40),
      isGitRepository: true,
      statsComplete: true,
    } as const;
    let state: TaskDetailWorkspaceGitState = {
      data: previousData,
      error: null,
      scopeKey: "workspace:same",
      status: "ready",
    };

    controller.refresh({
      client,
      publish: (updater) => {
        state = updater(state);
      },
      scopeKey: "workspace:same",
    });
    refresh.reject(new Error("transport unavailable"));
    await expect(refresh.promise).rejects.toThrow("transport unavailable");
    await Promise.resolve();

    expect(state).toEqual({
      data: previousData,
      error: "transport unavailable",
      scopeKey: "workspace:same",
      status: "error",
    });
  });

  it("recognizes permission failures without hiding ordinary failures", () => {
    expect([
      isTaskDetailWorkspaceGitPermissionError({ status: 403 }),
      isTaskDetailWorkspaceGitPermissionError(new Error("401 Unauthorized")),
      isTaskDetailWorkspaceGitPermissionError(new Error("socket closed")),
    ]).toEqual([true, true, false]);
  });
});
