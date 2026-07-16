import type { Thread } from "@crewon-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";

import type { NoticeState } from "../shared/noticeState";
import { agentConfigToOfficeMember } from "../agent-config/agentConfigDefaults";
import type {
  AgentConfig,
  LibraryPanel,
  LibraryPanelAction,
  OfficeConfig,
  OfficeMember,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import type { OfficeThreadResolution } from "../office/officeThreadActions";
import {
  officeRecruitCapabilitySummary,
  officeRecruitFailureNotice,
  officeRecruitJoinMessage,
  officeRecruitMissingAgentNoticeState,
  officeRecruitPersistenceWarningNotice,
  officeRecruitSavedPanel,
  officeRecruitSuccessNoticeState,
  officeRecruitTurnPrompt,
  officeRecruitUnavailableNoticeState,
  officeWorkspaceWithRecruitMessage,
} from "../office/officeDetailPanel";
import { upsertTurnInThread } from "../thread/threadModel";

type StateSetter<T> = (updater: (current: T) => T) => void;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type LibraryOfficeRecruitActionParams = {
  action: LibraryPanelAction;
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspaceOverride?: OfficeWorkspace,
    forceNew?: boolean,
  ) => Promise<OfficeThreadResolution | null>;
  isConnected: boolean;
  isDemo: boolean;
  isMissingThreadError: (error: unknown) => boolean;
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  persistOfficeMember: (
    panel: Pick<LibraryPanel, "title" | "subtitle">,
    workspaceBeforeMember: OfficeWorkspace,
    agentId: string | undefined,
    member: OfficeMember,
    threadId?: string | null,
  ) => Promise<OfficeConfig | null>;
  readRecruitableAgentConfig: (
    existingMembers: OfficeMember[],
  ) => Promise<AgentConfig | null>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: StateSetter<Thread[]>;
  startTurn: (
    threadId: string,
    text: string,
  ) => Promise<TurnStartResponse | null | undefined>;
};

export async function handleLibraryOfficeRecruitAction({
  action,
  ensureOfficeThread,
  isConnected,
  isDemo,
  isMissingThreadError,
  libraryPanel,
  locale,
  persistOfficeMember,
  readRecruitableAgentConfig,
  setLibraryPanel,
  setNotice,
  setThreads,
  startTurn,
}: LibraryOfficeRecruitActionParams): Promise<boolean> {
  if (action.id !== "recruit-agent") {
    return false;
  }

  if (isDemo || !isConnected) {
    setNotice(officeRecruitUnavailableNoticeState(locale));
    return true;
  }

  if (!libraryPanel) {
    return false;
  }

  const panel = libraryPanel;
  const workspace = panel.workspace;
  if (!workspace) {
    return false;
  }
  try {
    const recruitConfig =
      actionRecruitableAgentConfig(action, workspace.members) ??
      (await readRecruitableAgentConfig(workspace.members));
    if (!recruitConfig?.agentId) {
      setNotice(officeRecruitMissingAgentNoticeState(locale));
      return true;
    }
    const newMember = agentConfigToOfficeMember(recruitConfig, locale);
    const { enabledMcp, enabledSkills } = officeRecruitCapabilitySummary(
      recruitConfig,
      locale,
    );
    const joinMessage = officeRecruitJoinMessage({
      agent: recruitConfig,
      enabledMcp,
      enabledSkills,
      locale,
      member: newMember,
    });
    let canonicalWorkspace = workspace;
    let threadId = workspace.threadId ?? null;
    if (threadId) {
      const thread = await ensureOfficeThread(panel, workspace);
      if (!thread) {
        return true;
      }
      canonicalWorkspace = thread.config.workspace;
      threadId = thread.threadId;
    }

    const workspaceWithJoinMessage = officeWorkspaceWithRecruitMessage(
      canonicalWorkspace,
      joinMessage,
    );
    let savedConfig = await persistOfficeMember(
      panel,
      workspaceWithJoinMessage,
      recruitConfig.agentId,
      newMember,
      threadId,
    );
    if (!savedConfig) {
      setNotice(officeRecruitPersistenceWarningNotice(locale));
      return true;
    }

    if (!threadId) {
      const canonicalSavedConfig = savedConfig;
      setLibraryPanel((currentPanel) =>
        officeRecruitSavedPanel(currentPanel, {
          config: canonicalSavedConfig,
          threadId: null,
        }),
      );
      setNotice(officeRecruitSuccessNoticeState(newMember.name, locale));
      return true;
    }

    const recruitTurnInput = (targetThreadId: string) =>
      officeRecruitTurnPrompt({
        agent: recruitConfig,
        enabledMcp,
        enabledSkills,
        locale,
        member: newMember,
        officeTitle: panel.title,
        threadId: targetThreadId,
      });
    let response;
    try {
      response = await startTurn(threadId, recruitTurnInput(threadId));
    } catch (error) {
      if (!isMissingThreadError(error)) {
        throw error;
      }
      const thread = await ensureOfficeThread(panel, savedConfig.workspace, true);
      if (!thread) {
        return true;
      }
      savedConfig = thread.config;
      threadId = thread.threadId;
      response = await startTurn(threadId, recruitTurnInput(threadId));
    }

    const connectedThreadId = threadId;
    if (response) {
      setThreads((current) =>
        upsertTurnInThread(current, connectedThreadId, response.turn),
      );
    }
    setLibraryPanel((currentPanel) =>
      officeRecruitSavedPanel(currentPanel, {
        config: savedConfig,
        threadId: connectedThreadId,
      }),
    );
    setNotice(officeRecruitSuccessNoticeState(newMember.name, locale));
  } catch (error) {
    setNotice(officeRecruitFailureNotice(error, locale));
  }
  return true;
}

function actionRecruitableAgentConfig(
  action: LibraryPanelAction,
  existingMembers: OfficeMember[],
): AgentConfig | null {
  const config = action.agentConfig;
  if (!config?.agentId) {
    return null;
  }
  const memberNames = new Set(existingMembers.map((member) => member.name));
  const memberAgentIds = new Set(
    existingMembers
      .map((member) => member.agentId)
      .filter((agentId): agentId is string => Boolean(agentId)),
  );
  if (memberNames.has(config.name) || memberAgentIds.has(config.agentId)) {
    return null;
  }
  return config;
}
