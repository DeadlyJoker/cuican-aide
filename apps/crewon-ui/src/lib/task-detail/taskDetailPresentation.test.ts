import { describe, expect, it } from "vitest";

import type { TaskDetailProjection } from "./taskDetailProjection";
import {
  taskDetailPresentation,
  taskDetailProcessesPresentation,
} from "./taskDetailPresentation";

const projection: TaskDetailProjection = {
  threadId: "thread-1",
  environment: {
    cwd: "/repo/crewon",
    workspaceName: "crewon",
    modelProvider: "openai",
    gitSnapshot: {
      basis: "threadCreationSnapshot",
      branch: "main",
      originUrl: null,
      sha: "abc123",
    },
  },
  status: {
    activeFlags: [],
    basis: "threadStatus",
    errorMessage: null,
    label: "执行中",
    latestTurnId: "turn-1",
    phase: "running",
  },
  changes: {
    basis: "threadRecordedChanges",
    complete: true,
    eventCount: 2,
    fileCount: 1,
    isLiveGitStatus: false,
    paths: ["src/app.ts"],
    recordedAdditions: 4,
    recordedDeletions: 2,
    statusCounts: {
      completed: 1,
      declined: 1,
      failed: 0,
      inProgress: 0,
    },
  },
  subagents: {
    agents: [
      {
        displayName: "安全审查",
        lastActivity: "started",
        message: "raw detail is intentionally not displayed",
        role: "reviewer",
        status: "shutdown",
        threadId: "agent-1",
      },
    ],
    statusCounts: {
      completed: 0,
      errored: 0,
      interrupted: 0,
      notFound: 0,
      pendingInit: 0,
      running: 0,
      shutdown: 1,
      unknown: 0,
    },
    total: 1,
  },
  sources: {
    items: [
      {
        displayName: "brief.md",
        itemId: "user-1",
        kind: "mention",
        reference: "/repo/brief.md",
        turnId: "turn-1",
      },
      {
        displayName: "diagram.png",
        itemId: "user-1",
        kind: "localImage",
        reference: "/tmp/diagram.png",
        turnId: "turn-1",
      },
    ],
    total: 2,
    truncatedCount: 0,
  },
};

describe("taskDetailPresentation", () => {
  it("marks historical facts and offline active status without exposing raw references", () => {
    expect(
      taskDetailPresentation({
        authority: "control",
        connectionState: "disconnected",
        locale: "zh",
        projection,
      }),
    ).toEqual({
      environment: {
        data: {
          branch: { detail: "启动快照", label: "main" },
          changes: null,
          status: { label: "离线快照 · 执行中", tone: "neutral" },
          target: "控制运行时",
          workspace: "crewon · openai · 任务记录 · 离线快照",
        },
        status: "ready",
      },
      agents: {
        data: {
          items: [
            {
              id: "agent-1",
              name: "安全审查",
              role: "reviewer",
              status: "interrupted",
            },
          ],
          summary: "最近记录",
          total: 1,
        },
        status: "ready",
      },
      sources: {
        data: {
          items: [
            {
              detail: "对话引用",
              id: "turn-1:user-1:mention:0",
              kind: "file",
              label: "brief.md",
            },
            {
              detail: "本地图片",
              id: "turn-1:user-1:localImage:1",
              kind: "image",
              label: "diagram.png",
            },
          ],
          total: 2,
        },
        status: "ready",
      },
    });
  });

  it("prefers the current Control workspace branch and keeps zero changes visible", () => {
    const controlProjection: TaskDetailProjection = {
      ...projection,
      environment: { ...projection.environment, gitSnapshot: null },
      changes: {
        ...projection.changes,
        eventCount: 0,
        fileCount: 0,
        paths: [],
        recordedAdditions: 0,
        recordedDeletions: 0,
        statusCounts: {
          completed: 0,
          declined: 0,
          failed: 0,
          inProgress: 0,
        },
      },
    };
    const value = taskDetailPresentation({
      authority: "control",
      connectionState: "connected",
      locale: "zh",
      projection: controlProjection,
      workspaceGit: {
        data: {
          branch: "codex/live-details",
          changes: { additions: 0, deletions: 0, files: 0 },
          head: "0123456789abcdef",
          isGitRepository: true,
          statsComplete: true,
        },
        error: null,
        scopeKey: "workspace:1",
        status: "ready",
      },
    });

    expect(value.environment).toMatchObject({
      status: "ready",
      data: {
        branch: { detail: "当前工作区", label: "codex/live-details" },
        changes: {
          added: 0,
          detail: "当前分支",
          files: 0,
          removed: 0,
        },
      },
    });
  });

  it("distinguishes detached HEAD, non-Git, global workspace data and read failures", () => {
    const present = (
      workspaceGit: Parameters<
        typeof taskDetailPresentation
      >[0]["workspaceGit"],
    ) =>
      taskDetailPresentation({
        authority: "control",
        connectionState: "connected",
        locale: "zh",
        projection,
        workspaceGit,
      }).environment;

    expect(
      present({
        data: {
          branch: null,
          changes: { additions: 2, deletions: 1, files: 1 },
          head: "fedcba9876543210",
          isGitRepository: true,
          statsComplete: true,
        },
        error: null,
        scopeKey: "workspace:1",
        status: "ready",
      }).data?.branch,
    ).toEqual({ detail: "当前工作区", label: "分离头指针 fedcba98" });
    expect(
      present({
        data: {
          branch: null,
          changes: null,
          head: null,
          isGitRepository: false,
          statsComplete: false,
        },
        error: null,
        scopeKey: "workspace:1",
        status: "ready",
      }).data,
    ).toMatchObject({
      branch: { detail: "当前工作区", label: "非 Git 工作区" },
      changes: null,
    });
    expect(
      present({
        data: {
          branch: "codex/partial-stats",
          changes: null,
          head: "a".repeat(40),
          isGitRepository: true,
          statsComplete: false,
        },
        error: null,
        scopeKey: "workspace:1",
        status: "ready",
      }).data,
    ).toMatchObject({
      branch: { detail: "当前工作区", label: "codex/partial-stats" },
      changes: null,
    });
    expect(
      present({
        data: null,
        error: "socket closed",
        scopeKey: "workspace:1",
        status: "error",
      }),
    ).toMatchObject({
      status: "error",
      error: "无法读取当前工作区 Git 信息",
      data: { branch: { detail: "启动快照", label: "main" } },
    });
    expect(
      present({
        data: {
          branch: "wrong-thread",
          changes: { additions: 99, deletions: 99, files: 99 },
          head: null,
          isGitRepository: true,
          statsComplete: true,
        },
        error: null,
        scopeKey: "workspace:1",
        status: "ready",
      }).data,
    ).toMatchObject({
      branch: { detail: "当前工作区", label: "wrong-thread" },
      changes: {
        added: 99,
        detail: "当前分支",
        files: 99,
        removed: 99,
      },
    });
  });
});

describe("taskDetailProcessesPresentation", () => {
  it("keeps Control runtime unavailable and clears forbidden process detail", () => {
    const state = {
      data: [
        {
          command: "pnpm test",
          cpuLabel: null,
          cwdLabel: "ui",
          id: "process-1",
          memoryLabel: null,
          pidLabel: "PID 12",
        },
      ],
      error: null,
      refreshing: false,
      status: "forbidden" as const,
      terminatingIds: [],
      threadId: "thread-1",
    };

    expect(taskDetailProcessesPresentation(state, "zh", false)).toEqual({
      status: "forbidden",
      unavailableReason: "无权查看后台进程信息",
    });
  });
});
