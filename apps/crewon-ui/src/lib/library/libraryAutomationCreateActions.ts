import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { TurnStartResponse } from "@crewon-ui-model/v2/TurnStartResponse";

import type { NoticeState } from "../shared/noticeState";
import type {
  AgentConfig,
  AutomationConfig,
  LibraryPanel,
  LibraryPanelAction,
  OfficeConfig,
} from "../domain/crewonDomain";
import {
  automationConfigForCreate,
  automationCreateFailureNotice,
  automationCreateFailurePanel,
  automationCreateFieldValues,
  automationCreateRequiresBindingsNotice,
  automationCreateRequiresBindingsPanel,
  automationCreateSelectionPanel,
  automationCreateSuccessPanel,
  automationCreateTitle,
  automationCreateTurnPrompt,
  automationRunPrompt,
} from "../domain/domainAutomationContent";
import type { Locale } from "../i18n";
import { upsertThread, upsertTurnInThread } from "../thread/threadModel";

type DomainConfigRecord<TConfig> = {
  filePath: string;
  config: TConfig;
};

type StateSetter<T> = (updater: (current: T) => T) => void;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type LibraryAutomationCreateActionParams = {
  action: LibraryPanelAction;
  createAutomationConfig: (params: {
    executionAgent: AgentConfig;
    prompt: string;
    status: string;
    targetOffice: OfficeConfig;
    threadId: string;
    title: string;
  }) => Promise<{ config: AutomationConfig; filePath: string }>;
  isUnsupportedRpcError: (error: unknown) => boolean;
  libraryPanel: LibraryPanel | null;
  listAgentConfigs: () => Promise<Array<DomainConfigRecord<AgentConfig>>>;
  listOfficeConfigs: () => Promise<Array<DomainConfigRecord<OfficeConfig>>>;
  locale: Locale;
  now: () => Date;
  renameThread: (threadId: string, title: string) => Promise<void>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreadGoal: (
    threadId: string,
    goal: string,
    tokenBudget: number | null,
  ) => Promise<void>;
  setThreads: StateSetter<Thread[]>;
  startAutomationThread: () => Promise<Thread | null>;
  startTurn: (
    threadId: string,
    text: string,
  ) => Promise<TurnStartResponse | null | undefined>;
  updateAutomationConfig: (
    filePath: string,
    config: AutomationConfig,
  ) => Promise<{ config: AutomationConfig; filePath: string }>;
  writeAutomationConfig: (config: AutomationConfig) => Promise<string | null>;
};

export async function handleLibraryAutomationCreateAction({
  action,
  createAutomationConfig,
  isUnsupportedRpcError,
  libraryPanel,
  listAgentConfigs,
  listOfficeConfigs,
  locale,
  now,
  renameThread,
  setLibraryPanel,
  setNotice,
  setThreadGoal,
  setThreads,
  startAutomationThread,
  startTurn,
  updateAutomationConfig,
  writeAutomationConfig,
}: LibraryAutomationCreateActionParams): Promise<boolean> {
  if (action.id !== "create-automation") {
    return false;
  }

  try {
    const defaultTitle = automationCreateTitle(
      now().toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      locale,
    );
    const [officeRecords, allAgentRecords] = await Promise.all([
      listOfficeConfigs(),
      listAgentConfigs(),
    ]);
    const agentRecords = allAgentRecords.filter((record) =>
      Boolean(record.config.agentId),
    );
    const {
      selectedAgentPath,
      selectedOfficePath,
      selectedPrompt,
      selectedTrigger,
      title,
    } = automationCreateFieldValues({
      defaultTitle,
      fields: libraryPanel?.fields,
    });

    if (!selectedOfficePath || !selectedAgentPath) {
      if (officeRecords.length === 0 || agentRecords.length === 0) {
        setLibraryPanel((currentPanel) =>
          automationCreateRequiresBindingsPanel(currentPanel, locale),
        );
        setNotice(automationCreateRequiresBindingsNotice(locale));
        return true;
      }
      setLibraryPanel((currentPanel) =>
        automationCreateSelectionPanel(currentPanel, {
          agentRecords,
          locale,
          officeRecords,
          title,
        }),
      );
      return true;
    }

    const targetOffice =
      officeRecords.find((record) => record.filePath === selectedOfficePath)
        ?.config ?? null;
    const executionAgent =
      agentRecords.find((record) => record.filePath === selectedAgentPath)
        ?.config ?? null;
    if (!targetOffice || !executionAgent?.agentId) {
      setLibraryPanel((currentPanel) =>
        automationCreateRequiresBindingsPanel(currentPanel, locale),
      );
      setNotice(automationCreateRequiresBindingsNotice(locale));
      return true;
    }

    const thread = await startAutomationThread();
    if (!thread) {
      throw new Error(
        locale === "zh"
          ? "无法创建自动化后端线程"
          : "Unable to create a backend automation thread",
      );
    }
    await renameThread(thread.id, title);
    await setThreadGoal(
      thread.id,
      locale === "zh"
        ? "运行自动化，绑定目标办公室和执行智能体，并沉淀后续运行记录。"
        : "Run automation with a target office and execution agent, keeping future run records.",
      null,
    );

    const automationConfig = automationConfigForCreate({
      threadId: thread.id,
      title,
      targetOffice,
      executionAgent,
      prompt:
        selectedPrompt ||
        automationRunPrompt({
          title,
          targetOffice,
          executionAgent,
          locale,
        }),
      selectedTrigger,
      locale,
    });
    let savedAutomationConfig = automationConfig;
    let automationConfigPath: string | null = null;
    const createPrompt = automationRunPrompt({
      title,
      targetOffice,
      executionAgent,
      locale,
    });
    try {
      const createResult = await createAutomationConfig({
        title,
        threadId: thread.id,
        targetOffice,
        executionAgent,
        prompt: createPrompt,
        status: "enabled",
      });
      savedAutomationConfig = {
        ...automationConfig,
        ...createResult.config,
        subtitle: automationConfig.subtitle,
        body: automationConfig.body,
        prompt: automationConfig.prompt,
        trigger: automationConfig.trigger,
        targetOffice,
        executionAgent,
      };
      const updateResponse = await updateAutomationConfig(
        createResult.filePath,
        savedAutomationConfig,
      );
      savedAutomationConfig = updateResponse.config;
      automationConfigPath = updateResponse.filePath;
    } catch (error) {
      if (!isUnsupportedRpcError(error)) {
        throw error;
      }
      automationConfigPath = await writeAutomationConfig(automationConfig);
    }

    const createResponse = await startTurn(
      thread.id,
      automationCreateTurnPrompt({
        title,
        targetOffice,
        executionAgent,
        configPath: automationConfigPath,
        prompt: savedAutomationConfig.prompt,
        locale,
      }),
    );
    setThreads((current) => upsertThread(current, { ...thread, name: title }));
    if (createResponse) {
      setThreads((current) =>
        upsertTurnInThread(current, thread.id, createResponse.turn),
      );
    }
    setLibraryPanel((currentPanel) =>
      automationCreateSuccessPanel(currentPanel, {
        config: savedAutomationConfig,
        configPath: automationConfigPath,
        locale,
        threadId: thread.id,
      }),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      automationCreateFailurePanel(currentPanel, error, locale),
    );
    setNotice(automationCreateFailureNotice(error, locale));
  }
  return true;
}
