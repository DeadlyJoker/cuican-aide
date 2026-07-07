import { describe, expect, it } from "vitest";

import {
  gitDisconnectedPanel,
  gitLoadingPanel,
  gitMissingWorkspacePanel,
  gitPanel,
  worktreesDisconnectedPanel,
  worktreesLoadingPanel,
  worktreesMissingWorkspacePanel,
  worktreesPanel,
  worktreeSessionActionFailurePanel,
  worktreeSessionActionFailurePanelState,
  worktreeSessionActionInProgressPanel,
  worktreeSessionActionInProgressPanelState,
  worktreeSessionCreateFailureMessage,
  worktreeSessionForkSelectionMessage,
  worktreeSessionMissingWorkspaceMessage,
} from "./settingsWorkspacePanels";

describe("settings workspace panels", () => {
  it("builds git panels", () => {
    expect(gitDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Git",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(gitMissingWorkspacePanel("zh")).toEqual({
      title: "Git",
      subtitle: "未选择工作区",
      error: "当前没有工作区路径，无法读取 Git 状态。",
    });
    expect(gitLoadingPanel("/repo", "en")).toEqual({
      title: "Git",
      subtitle: "/repo",
      body: "Reading Git status...",
    });
    expect(
      gitPanel({
        configRead: null,
        conversationSummary: null,
        cwd: "/repo",
        error: "config failed",
        locale: "en",
        remoteDiff: {
          status: "ready",
          added: 4,
          removed: 1,
          files: 2,
          sha: "abc123",
        },
        selectedThread: null,
      }),
    ).toEqual({
      title: "Git",
      subtitle: "/repo · +4 -1",
      body: [
        "Git workspace",
        "Path: /repo",
        "SHA: abc123",
        "Remote diff: 2 files · +4 -1",
        "Config layers: 0",
      ].join("\n"),
      actions: [{ id: "refresh-git", label: "Refresh Git" }],
      error: "config failed",
    });
  });

  it("builds worktrees panels", () => {
    expect(worktreesDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Worktrees",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(worktreesMissingWorkspacePanel("zh")).toEqual({
      title: "工作树",
      subtitle: "未选择工作区",
      error: "当前没有工作区路径，无法创建工作树会话。",
    });
    expect(worktreesLoadingPanel("/repo", "en")).toEqual({
      title: "Worktrees",
      subtitle: "/repo",
      body: "Reading workspace sessions...",
    });
    expect(
      worktreesPanel({
        conversationSummary: null,
        cwd: "/repo",
        error: "thread read failed",
        locale: "en",
        relatedThreads: [],
        remoteDiff: null,
        selectedThread: null,
      }),
    ).toEqual({
      title: "Worktrees",
      subtitle: "0 sessions · /repo",
      body: [
        "Worktrees",
        "Workspace: /repo",
        "Remote diff: not read",
        "Sessions in workspace: 0",
        "New sessions open an independent conversation in this workspace. Forked sessions keep the current context for parallel exploration.",
      ].join("\n"),
      actions: [
        { id: "create-worktree-session", label: "New session", tone: "primary" },
        { id: "fork-worktree", label: "Fork current session" },
        { id: "refresh-worktrees", label: "Refresh worktrees" },
      ],
      error: "thread read failed",
    });
  });

  it("builds worktree session action panels and messages", () => {
    expect(
      worktreeSessionActionInProgressPanel({
        action: "create",
        cwd: "/repo",
        locale: "en",
      }),
    ).toEqual({
      title: "Worktrees",
      subtitle: "/repo",
      body: "Creating workspace session...",
      error: undefined,
    });
    expect(
      worktreeSessionActionInProgressPanel({
        action: "fork",
        cwd: "/repo",
        locale: "zh",
      }),
    ).toEqual({
      title: "工作树",
      subtitle: "/repo",
      body: "正在分叉当前会话...",
      error: undefined,
    });
    expect(worktreeSessionMissingWorkspaceMessage("en")).toBe(
      "No workspace path is available for creating a session.",
    );
    expect(worktreeSessionForkSelectionMessage("zh")).toBe(
      "请先选择一个可分叉的对话。",
    );
    expect(worktreeSessionCreateFailureMessage("en")).toBe(
      "Unable to create session",
    );
    expect(
      worktreeSessionActionFailurePanel({
        error: null,
        locale: "en",
      }),
    ).toEqual({
      title: "Worktrees",
      error: "Worktree action failed",
    });
    expect(
      worktreeSessionActionFailurePanel({
        error: new Error("denied"),
        locale: "zh",
      }),
    ).toEqual({
      title: "工作树",
      error: "denied",
    });
  });

  it("applies worktree session action panels to current panel state", () => {
    expect(
      worktreeSessionActionInProgressPanelState(
        {
          title: "Worktrees",
          subtitle: "/old",
          body: "Ready",
          actions: [{ id: "refresh-worktrees", label: "Refresh" }],
          error: "old",
        },
        {
          action: "create",
          cwd: "/repo",
          locale: "en",
        },
      ),
    ).toEqual({
      title: "Worktrees",
      subtitle: "/repo",
      body: "Creating workspace session...",
      actions: [{ id: "refresh-worktrees", label: "Refresh" }],
      error: undefined,
    });
    expect(
      worktreeSessionActionInProgressPanelState(null, {
        action: "fork",
        cwd: "/repo",
        locale: "zh",
      }),
    ).toEqual({
      title: "工作树",
      subtitle: "/repo",
      body: "正在分叉当前会话...",
      error: undefined,
    });
    expect(
      worktreeSessionActionFailurePanelState(
        {
          title: "Worktrees",
          subtitle: "/repo",
          body: "Creating workspace session...",
        },
        {
          error: null,
          locale: "en",
        },
      ),
    ).toEqual({
      title: "Worktrees",
      subtitle: "/repo",
      body: "Creating workspace session...",
      error: "Worktree action failed",
    });
    expect(
      worktreeSessionActionFailurePanelState(null, {
        error: new Error("denied"),
        locale: "zh",
      }),
    ).toEqual({
      title: "工作树",
      error: "denied",
    });
  });
});
