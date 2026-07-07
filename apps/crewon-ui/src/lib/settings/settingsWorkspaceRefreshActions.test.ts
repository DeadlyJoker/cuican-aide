import type { ConfigReadResponse } from "@crewon-protocol/v2/ConfigReadResponse";
import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { GitDiffToRemoteResponse } from "@crewon-protocol/GitDiffToRemoteResponse";
import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  refreshGitSettingsPanelAction,
  refreshWorktreesSettingsPanelAction,
  type RefreshGitSettingsPanelParams,
} from "./settingsWorkspaceRefreshActions";

type SettingsWorkspaceRefreshClient = NonNullable<
  RefreshGitSettingsPanelParams["client"]
>;

function configRead(): ConfigReadResponse {
  return {
    config: {
      approval_policy: "on-request",
      approvals_reviewer: null,
      compact_prompt: null,
      desktop: null,
      developer_instructions: null,
      forced_chatgpt_workspace_id: null,
      forced_login_method: null,
      instructions: null,
      model: "gpt-5-codex",
      model_auto_compact_token_limit: null,
      model_auto_compact_token_limit_scope: null,
      model_context_window: null,
      model_provider: "openai",
      model_reasoning_effort: null,
      model_reasoning_summary: null,
      model_verbosity: null,
      review_model: null,
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: null,
      service_tier: null,
      tools: null,
      web_search: null,
      analytics: null,
    },
    layers: [],
    origins: {},
  } as ConfigReadResponse;
}

function diffResponse(diff = "diff --git a/a.ts b/a.ts\n+added\n-removed\n") {
  return {
    diff,
    sha: "abc123",
  } satisfies GitDiffToRemoteResponse;
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    agentNickname: null,
    agentRole: null,
    clientVersion: "test",
    createdAt: 1,
    cwd: "/repo",
    ephemeral: false,
    forkedFromId: null,
    gitInfo: {
      branch: "main",
      originUrl: "git@example.com:repo.git",
      sha: "abc123",
    },
    id: "thread-1",
    modelProvider: "openai",
    name: "Main task",
    parentThreadId: null,
    path: null,
    preview: "Main preview",
    sessionId: "session-1",
    source: "unknown",
    status: { type: "idle" },
    threadSource: null,
    turns: [],
    updatedAt: 10,
    ...overrides,
  };
}

function conversationSummary(): ConversationSummary {
  return {
    cliVersion: "test",
    conversationId: "thread-1",
    cwd: "/repo",
    gitInfo: {
      branch: "summary-branch",
      origin_url: "git@example.com:summary.git",
      sha: "summary-sha",
    },
    modelProvider: "openai",
    path: "/thread",
    preview: "Summary",
    source: "unknown",
    timestamp: null,
    updatedAt: null,
  };
}

function baseClient(
  overrides: Partial<SettingsWorkspaceRefreshClient> = {},
): SettingsWorkspaceRefreshClient {
  return {
    async getGitDiffToRemote() {
      return diffResponse();
    },
    async listThreads() {
      return [thread()];
    },
    async readConfig() {
      return configRead();
    },
    ...overrides,
  };
}

function panelSink() {
  let panel: CapabilityPanel | null = null;
  const panels: Array<CapabilityPanel | null> = [];
  return {
    get panel() {
      return panel;
    },
    get panels() {
      return panels;
    },
    setCapabilityPanel: (
      panelOrUpdater:
        | CapabilityPanel
        | null
        | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
    ) => {
      panel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(panel)
          : panelOrUpdater;
      panels.push(panel);
    },
  };
}

function baseParams(
  overrides: Partial<RefreshGitSettingsPanelParams> = {},
): RefreshGitSettingsPanelParams {
  const sink = panelSink();
  return {
    client: baseClient(),
    connectionHint: "Disconnected",
    conversationSummary: conversationSummary(),
    isConnected: true,
    locale: "en",
    resolveBackendCwd: async () => "/repo",
    selectedThread: thread(),
    setCapabilityPanel: sink.setCapabilityPanel,
    ...overrides,
  };
}

describe("settings workspace refresh actions", () => {
  it("shows git disconnected panel without resolving cwd", async () => {
    const sink = panelSink();
    let resolvedCwd = false;

    await refreshGitSettingsPanelAction(
      baseParams({
        isConnected: false,
        resolveBackendCwd: async () => {
          resolvedCwd = true;
          return "/repo";
        },
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    );

    expect(resolvedCwd).toBe(false);
    expect(sink.panel).toEqual({
      error: "Local app-server is not connected",
      subtitle: "Disconnected",
      title: "Git",
    });
  });

  it("shows git missing workspace panel when cwd cannot resolve", async () => {
    const sink = panelSink();

    await refreshGitSettingsPanelAction(
      baseParams({
        resolveBackendCwd: async () => "",
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    );

    expect(sink.panel).toEqual({
      error: "No workspace path is available for reading Git status.",
      subtitle: "No workspace selected",
      title: "Git",
    });
  });

  it("loads git diff and config into the git panel", async () => {
    const sink = panelSink();
    const calls: string[] = [];

    await refreshGitSettingsPanelAction(
      baseParams({
        client: baseClient({
          async getGitDiffToRemote(cwd) {
            calls.push(`diff:${cwd}`);
            return diffResponse();
          },
          async readConfig(cwd) {
            calls.push(`config:${cwd}`);
            return configRead();
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    );

    expect(calls.sort()).toEqual(["config:/repo", "diff:/repo"]);
    expect(sink.panels[0]).toEqual({
      body: "Reading Git status...",
      subtitle: "/repo",
      title: "Git",
    });
    expect(sink.panel).toMatchObject({
      actions: [{ id: "refresh-git", label: "Refresh Git" }],
      subtitle: "/repo · +1 -1",
      title: "Git",
    });
    expect(sink.panel?.body).toContain("Remote diff: 1 files · +1 -1");
    expect(sink.panel?.body).toContain("Sandbox: workspace-write");
  });

  it("loads worktrees, filters related threads, and merges refreshed threads", async () => {
    const sink = panelSink();
    let currentThreads = [thread({ id: "existing", name: "Existing" })];
    const refreshedThreads = [
      thread({ id: "thread-2", name: "Related 2", updatedAt: 20 }),
      thread({ id: "thread-3", cwd: "/other", name: "Other", updatedAt: 30 }),
      thread({ id: "thread-1", name: "Related 1", updatedAt: 10 }),
    ];

    await refreshWorktreesSettingsPanelAction({
      ...baseParams({
        client: baseClient({
          async listThreads(archived) {
            expect(archived).toBe(false);
            return refreshedThreads;
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
      currentThreads,
      setThreads: (updater) => {
        currentThreads = updater(currentThreads);
      },
    });

    expect(currentThreads.map((candidate) => candidate.id)).toEqual([
      "thread-1",
      "thread-3",
      "thread-2",
      "existing",
    ]);
    expect(sink.panels[0]).toEqual({
      body: "Reading workspace sessions...",
      subtitle: "/repo",
      title: "Worktrees",
    });
    expect(sink.panel).toMatchObject({
      subtitle: "2 sessions · /repo",
      title: "Worktrees",
    });
    expect(sink.panel?.body).toContain("Sessions in workspace: 2");
    expect(sink.panel?.body).toContain("- Related 2 ·");
    expect(sink.panel?.body).toContain("- Related 1 ·");
  });

  it("uses current threads when worktree thread listing fails", async () => {
    const sink = panelSink();
    const currentThreads = [thread({ id: "current", name: "Current" })];
    let merged = false;

    await refreshWorktreesSettingsPanelAction({
      ...baseParams({
        client: baseClient({
          async listThreads() {
            throw new Error("thread list failed");
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
      currentThreads,
      setThreads: () => {
        merged = true;
      },
    });

    expect(merged).toBe(false);
    expect(sink.panel).toMatchObject({
      error: "thread list failed",
      subtitle: "1 sessions · /repo",
      title: "Worktrees",
    });
  });
});
