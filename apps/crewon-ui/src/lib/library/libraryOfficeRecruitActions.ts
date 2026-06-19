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
import {
  demoOfficeRecruitPanel,
  officeRecruitCapabilitySummary,
  officeRecruitFailureNotice,
  officeRecruitJoinMessage,
  officeRecruitMissingAgentNoticeState,
  officeRecruitPersistenceWarningNotice,
  officeRecruitSavedPanel,
  officeRecruitSuccessNoticeState,
  officeRecruitTurnPrompt,
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
  ) => Promise<string | null>;
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
    threadId: string,
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

  if (isDemo) {
    setLibraryPanel((currentPanel) =>
      demoOfficeRecruitPanel(currentPanel, locale),
    );
    return true;
  }

  if (!isConnected || !libraryPanel) {
    return false;
  }

  const panel = libraryPanel;
  const workspace = panel.workspace;
  if (!workspace) {
    return false;
  }
  try {
    const recruitConfig = await readRecruitableAgentConfig(workspace.members);
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
    const workspaceWithJoinMessage = officeWorkspaceWithRecruitMessage(
      workspace,
      joinMessage,
    );
    let threadId = await ensureOfficeThread(panel, workspace);
    if (!threadId) {
      return true;
    }

    const savedConfig = await persistOfficeMember(
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
      threadId = await ensureOfficeThread(panel, savedConfig.workspace, true);
      if (!threadId) {
        return true;
      }
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
