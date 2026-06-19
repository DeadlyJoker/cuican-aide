import type { Thread } from "@crewon-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";

import type { NoticeState } from "../shared/noticeState";
import {
  officeConfigForThread,
  type LibraryPanel,
  type LibraryPanelAction,
  type OfficeConfig,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  buildOfficeCreatePanel,
  officeCreateFailureNotice,
  officeCreateFailurePanel,
  officeCreateSubtitle,
  officeCreateTitle,
  officeCreateTurnPrompt,
} from "../office/officeDetailPanel";
import { newBackendOfficeWorkspace } from "../office/officeWorkspace";
import { upsertThread, upsertTurnInThread } from "../thread/threadModel";

type StateSetter<T> = (updater: (current: T) => T) => void;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type LibraryOfficeActionParams = {
  action: LibraryPanelAction;
  createOfficeConfig: (params: {
    goal: string;
    subtitle: string;
    threadId: string;
    title: string;
  }) => Promise<{ config: OfficeConfig; filePath: string } | null>;
  isUnsupportedRpcError: (error: unknown) => boolean;
  locale: Locale;
  now: () => Date;
  renameThread: (threadId: string, title: string) => Promise<void>;
  setLibraryPanel: ((panel: LibraryPanel | null) => void) & LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreadGoal: (
    threadId: string,
    goal: string,
    tokenBudget: number | null,
  ) => Promise<void>;
  setThreads: StateSetter<Thread[]>;
  startOfficeThread: () => Promise<Thread | null>;
  startTurn: (
    threadId: string,
    text: string,
  ) => Promise<TurnStartResponse | null | undefined>;
  writeOfficeConfig: (config: OfficeConfig) => Promise<string | null>;
};

export async function handleLibraryOfficeAction({
  action,
  createOfficeConfig,
  isUnsupportedRpcError,
  locale,
  now,
  renameThread,
  setLibraryPanel,
  setNotice,
  setThreadGoal,
  setThreads,
  startOfficeThread,
  startTurn,
  writeOfficeConfig,
}: LibraryOfficeActionParams): Promise<boolean> {
  if (action.id !== "create-office") {
    return false;
  }

  try {
    const title = officeCreateTitle(
      now().toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      locale,
    );
    const thread = await startOfficeThread();
    if (!thread) {
      throw new Error(
        locale === "zh"
          ? "无法创建办公室后端线程"
          : "Unable to create a backend office thread",
      );
    }
    await renameThread(thread.id, title);
    const workspace = newBackendOfficeWorkspace(title, thread.id, locale);
    await setThreadGoal(thread.id, workspace.goal, null);
    const createResponse = await startTurn(
      thread.id,
      officeCreateTurnPrompt({ locale, title, workspace }),
    );
    setThreads((current) => upsertThread(current, { ...thread, name: title }));
    if (createResponse) {
      setThreads((current) =>
        upsertTurnInThread(current, thread.id, createResponse.turn),
      );
    }

    const subtitle = officeCreateSubtitle(locale);
    let officeConfigPath: string | null = null;
    let savedOfficeConfig = officeConfigForThread(
      title,
      subtitle,
      workspace,
      thread.id,
    );
    try {
      const officeCreateResponse = await createOfficeConfig({
        title,
        subtitle,
        threadId: thread.id,
        goal: workspace.goal,
      });
      if (officeCreateResponse) {
        officeConfigPath = officeCreateResponse.filePath;
        savedOfficeConfig = officeCreateResponse.config;
      } else {
        officeConfigPath = await writeOfficeConfig(savedOfficeConfig);
      }
    } catch (error) {
      if (!isUnsupportedRpcError(error)) {
        throw error;
      }
      officeConfigPath = await writeOfficeConfig(savedOfficeConfig);
    }

    setLibraryPanel(
      buildOfficeCreatePanel({
        configPath: officeConfigPath,
        locale,
        subtitle,
        title,
        workspace: savedOfficeConfig.workspace,
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      officeCreateFailurePanel(currentPanel, error, locale),
    );
    setNotice(officeCreateFailureNotice(error, locale));
  }
  return true;
}
