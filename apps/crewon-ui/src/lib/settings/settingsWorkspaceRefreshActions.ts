import type { ConfigReadResponse } from "@crewon-protocol/v2/ConfigReadResponse";
import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { GitDiffToRemoteResponse } from "@crewon-protocol/GitDiffToRemoteResponse";
import type { Thread } from "@crewon-protocol/v2/Thread";

import {
  remoteDiffSummaryFromSettledResult,
} from "../shared/statusTypes";
import {
  settledMappedValue,
  settledValue,
} from "../shared/settledResults";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  gitDisconnectedPanel,
  gitLoadingPanel,
  gitMissingWorkspacePanel,
  gitPanel,
  worktreesDisconnectedPanel,
  worktreesLoadingPanel,
  worktreesMissingWorkspacePanel,
  worktreesPanel,
} from "./settingsPanelText";
import { upsertThread } from "../thread/threadModel";

type SettingsWorkspaceRefreshClient = {
  getGitDiffToRemote(cwd: string): Promise<GitDiffToRemoteResponse>;
  listThreads(archived?: boolean): Promise<Thread[]>;
  readConfig(cwd?: string | null): Promise<ConfigReadResponse>;
};

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

type BaseSettingsWorkspaceRefreshParams = {
  client: SettingsWorkspaceRefreshClient | null | undefined;
  connectionHint: string;
  conversationSummary: ConversationSummary | null;
  isConnected: boolean;
  locale: Locale;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  selectedThread: Thread | null;
  setCapabilityPanel: SetCapabilityPanel;
};

export type RefreshGitSettingsPanelParams = BaseSettingsWorkspaceRefreshParams;

export type RefreshWorktreesSettingsPanelParams =
  BaseSettingsWorkspaceRefreshParams & {
    currentThreads: Thread[];
    setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => void;
  };

export async function refreshGitSettingsPanelAction(
  params: RefreshGitSettingsPanelParams,
) {
  const {
    client,
    connectionHint,
    conversationSummary,
    isConnected,
    locale,
    resolveBackendCwd,
    selectedThread,
    setCapabilityPanel,
  } = params;

  if (!isConnected) {
    setCapabilityPanel(gitDisconnectedPanel(connectionHint, locale));
    return;
  }

  const gitCwd = await resolveBackendCwd();
  if (!gitCwd) {
    setCapabilityPanel(gitMissingWorkspacePanel(locale));
    return;
  }

  setCapabilityPanel(gitLoadingPanel(gitCwd, locale));

  const [diffResult, configResult] = await Promise.allSettled([
    client?.getGitDiffToRemote(gitCwd),
    client?.readConfig(gitCwd),
  ]);
  const remoteDiff = remoteDiffSummaryFromSettledResult(
    diffResult,
    locale === "zh" ? "读取远端差异失败" : "Unable to read remote diff",
  );
  const configRead = settledValue(configResult, null);

  setCapabilityPanel(
    gitPanel({
      configRead,
      conversationSummary,
      cwd: gitCwd,
      error:
        configResult.status === "rejected" &&
        configResult.reason instanceof Error
          ? configResult.reason.message
          : undefined,
      locale,
      remoteDiff,
      selectedThread,
    }),
  );
}

export async function refreshWorktreesSettingsPanelAction(
  params: RefreshWorktreesSettingsPanelParams,
) {
  const {
    client,
    connectionHint,
    conversationSummary,
    currentThreads,
    isConnected,
    locale,
    resolveBackendCwd,
    selectedThread,
    setCapabilityPanel,
    setThreads,
  } = params;

  if (!isConnected) {
    setCapabilityPanel(worktreesDisconnectedPanel(connectionHint, locale));
    return;
  }

  const worktreeCwd = await resolveBackendCwd();
  if (!worktreeCwd) {
    setCapabilityPanel(worktreesMissingWorkspacePanel(locale));
    return;
  }

  setCapabilityPanel(worktreesLoadingPanel(worktreeCwd, locale));

  const [threadResult, diffResult] = await Promise.allSettled([
    client?.listThreads(false),
    client?.getGitDiffToRemote(worktreeCwd),
  ]);
  const backendThreads = settledMappedValue(
    threadResult,
    (value) => value ?? [],
    currentThreads,
  );
  const relatedThreads = backendThreads
    .filter((candidate) => candidate.cwd === worktreeCwd)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const remoteDiff = remoteDiffSummaryFromSettledResult(
    diffResult,
    locale === "zh" ? "读取远端差异失败" : "Unable to read remote diff",
  );

  if (threadResult.status === "fulfilled" && threadResult.value) {
    const refreshedThreads = threadResult.value;
    setThreads((current) =>
      refreshedThreads.reduce(
        (nextThreads, thread) => upsertThread(nextThreads, thread),
        current,
      ),
    );
  }

  setCapabilityPanel(
    worktreesPanel({
      conversationSummary,
      cwd: worktreeCwd,
      error:
        threadResult.status === "rejected" &&
        threadResult.reason instanceof Error
          ? threadResult.reason.message
          : undefined,
      locale,
      relatedThreads,
      remoteDiff,
      selectedThread,
    }),
  );
}
