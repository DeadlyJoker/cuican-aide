import type { FsGetMetadataResponse } from "@crewon-protocol/v2/FsGetMetadataResponse";
import type { PluginReadResponse } from "@crewon-protocol/v2/PluginReadResponse";

import {
  appendAppMentionToken,
  appMentionInfo,
  upsertPendingComposerMention,
  type PendingComposerMention,
} from "../shared/composerMentions";
import type { ConfirmHandler } from "../shared/confirmHandler";
import { appMentionAddedPanel } from "./appMentionPresentation";
import type { NoticeState } from "../shared/noticeState";
import {
  terminateBackgroundTerminal,
} from "../terminal/backgroundTerminalActions";
import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "./capabilityPanelTypes";
import { fileMetadataText } from "./capabilityPanelText";
import { contextFileComposerBlock } from "../context/contextFilePrompt";
import {
  demoDirectoryPanel,
  demoFilePanel,
  directoryEntriesToPanelItems,
  directoryPanel,
  fileErrorPanel,
  fileLoadingPanel,
  fileReadPanel,
} from "../file/filePanelItems";
import type { Locale } from "../i18n";
import {
  pluginCapabilityDetailPanel,
  pluginCapabilityErrorPanel,
  pluginCapabilityLoadingPanel,
} from "../plugin/pluginPanelActions";
import { decodeBase64Text } from "../server-request/serverRequestPresentation";
import { backgroundTerminalTerminateConfirmMessage } from "../terminal/terminalActionPresentation";
import type { BackgroundTerminal } from "../app-server/appServer";

type DirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
};

type CapabilityPanelItemClient = {
  cleanBackgroundTerminals(threadId: string): Promise<void>;
  getMetadata(path: string): Promise<FsGetMetadataResponse>;
  listBackgroundTerminals(
    threadId: string,
  ): Promise<{ data: BackgroundTerminal[] }>;
  readDirectory(path: string): Promise<{ entries?: DirectoryEntry[] }>;
  readFile(path: string): Promise<{ dataBase64: string }>;
  readPlugin(
    pluginName: string,
    marketplacePath?: string | null,
    remoteMarketplaceName?: string | null,
  ): Promise<PluginReadResponse>;
  terminateBackgroundTerminal(
    threadId: string,
    processId: string,
  ): Promise<boolean>;
};

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

type PendingContextFile = {
  path: string;
  text: string;
};

export type CapabilityPanelItemActionParams = {
  busyToolId: string | null;
  client: CapabilityPanelItemClient | null | undefined;
  confirm: ConfirmHandler;
  isConnected: boolean;
  isDemo: boolean;
  item: CapabilityPanelItem;
  locale: Locale;
  setBusyToolId: (toolId: "files" | "terminal" | "web" | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setComposerFocusSignal: (updater: (signal: number) => number) => void;
  setComposerValue: (updater: (value: string) => string) => void;
  setNotice: (notice: NoticeState) => void;
  setPendingComposerMentions: (
    updater: (mentions: PendingComposerMention[]) => PendingComposerMention[],
  ) => void;
  setPendingContextFile: (contextFile: PendingContextFile) => void;
};

export async function handleCapabilityPanelItemAction(
  params: CapabilityPanelItemActionParams,
) {
  const {
    busyToolId,
    isConnected,
    isDemo,
    item,
    locale,
    setCapabilityPanel,
  } = params;

  if (isDemo) {
    if (item.kind === "directory") {
      setCapabilityPanel(
        demoDirectoryPanel({
          label: item.label,
          locale,
          path: item.path,
        }),
      );
      return;
    }
    setCapabilityPanel(
      demoFilePanel({
        label: item.label,
        locale,
        path: item.path,
      }),
    );
    return;
  }

  if (busyToolId || !isConnected || (!item.path && !item.action)) {
    return;
  }

  const itemAction = item.action;

  if (itemAction?.type === "app") {
    handleAppMentionItem(params, itemAction);
    return;
  }

  if (itemAction?.type === "background-terminal") {
    await handleBackgroundTerminalItem(params, itemAction);
    return;
  }

  if (itemAction?.type === "plugin") {
    await handlePluginItem(params, itemAction);
    return;
  }

  await handleFileItem(params);
}

function handleAppMentionItem(
  params: CapabilityPanelItemActionParams,
  itemAction: Extract<
    NonNullable<CapabilityPanelItem["action"]>,
    { type: "app" }
  >,
) {
  const {
    locale,
    setCapabilityPanel,
    setComposerFocusSignal,
    setComposerValue,
    setPendingComposerMentions,
  } = params;
  const appName = itemAction.appName;
  const mention = appMentionInfo(itemAction.appId, appName);
  setPendingComposerMentions((currentMentions) =>
    upsertPendingComposerMention(currentMentions, mention, appName),
  );
  setComposerValue((currentValue) =>
    appendAppMentionToken(currentValue, mention.token),
  );
  setComposerFocusSignal((signal) => signal + 1);
  setCapabilityPanel((currentPanel) =>
    appMentionAddedPanel(currentPanel, mention, locale),
  );
}

async function handleBackgroundTerminalItem(
  params: CapabilityPanelItemActionParams,
  itemAction: Extract<
    NonNullable<CapabilityPanelItem["action"]>,
    { type: "background-terminal" }
  >,
) {
  const {
    client,
    confirm,
    locale,
    setBusyToolId,
    setCapabilityPanel,
    setNotice,
  } = params;
  const confirmed = await confirm(
    backgroundTerminalTerminateConfirmMessage(itemAction.processId, locale),
  );
  if (!confirmed) {
    return;
  }

  await terminateBackgroundTerminal({
    client,
    locale,
    processId: itemAction.processId,
    setBusyToolId,
    setCapabilityPanel,
    setNotice,
    threadId: itemAction.threadId,
  });
}

async function handlePluginItem(
  params: CapabilityPanelItemActionParams,
  itemAction: Extract<
    NonNullable<CapabilityPanelItem["action"]>,
    { type: "plugin" }
  >,
) {
  const { client, locale, setBusyToolId, setCapabilityPanel } = params;

  setBusyToolId("web");
  setCapabilityPanel(pluginCapabilityLoadingPanel(itemAction.pluginName, locale));

  try {
    const response = await client?.readPlugin(
      itemAction.pluginName,
      itemAction.marketplacePath,
      itemAction.remoteMarketplaceName,
    );

    if (!response) {
      return;
    }

    setCapabilityPanel(pluginCapabilityDetailPanel(response, itemAction, locale));
  } catch (error) {
    setCapabilityPanel(
      pluginCapabilityErrorPanel({
        error,
        locale,
        pluginName: itemAction.pluginName,
      }),
    );
  } finally {
    setBusyToolId(null);
  }
}

async function handleFileItem(params: CapabilityPanelItemActionParams) {
  const {
    client,
    item,
    locale,
    setBusyToolId,
    setCapabilityPanel,
    setComposerValue,
    setPendingContextFile,
  } = params;
  const itemPath = item.path;

  setBusyToolId("files");
  if (!itemPath) {
    setBusyToolId(null);
    return;
  }

  try {
    if (item.kind === "directory") {
      setCapabilityPanel(fileLoadingPanel(itemPath, locale));
      const [response, metadata] = await Promise.all([
        client?.readDirectory(itemPath),
        client?.getMetadata(itemPath),
      ]);
      const entries = directoryEntriesToPanelItems(response?.entries, itemPath);
      setCapabilityPanel(
        directoryPanel({
          entries,
          includeCopyAction: true,
          locale,
          metadataText: fileMetadataText(metadata ?? null, locale),
          path: itemPath,
        }),
      );
      return;
    }

    setCapabilityPanel(fileLoadingPanel(itemPath, locale));
    const [response, metadata] = await Promise.all([
      client?.readFile(itemPath),
      client?.getMetadata(itemPath),
    ]);
    const fileText = response ? decodeBase64Text(response.dataBase64) : "";
    const metadataText = fileMetadataText(metadata ?? null, locale);
    if (item.intent === "attach-context") {
      const contextText = fileText.trim();
      const contextBlock = contextFileComposerBlock({
        path: itemPath,
        text: contextText,
        locale,
      });
      setComposerValue((currentValue) =>
        currentValue.trim()
          ? `${currentValue.trim()}\n\n${contextBlock}`
          : contextBlock,
      );
      setPendingContextFile({ path: itemPath, text: contextText });
    }
    setCapabilityPanel(
      fileReadPanel({
        fileText,
        intent: item.intent,
        label: item.label,
        locale,
        metadataText,
        path: itemPath,
      }),
    );
  } catch (error) {
    setCapabilityPanel(
      fileErrorPanel({
        error,
        fallback: locale === "zh" ? "读取失败" : "Unable to read",
        locale,
        path: item.path ?? "",
      }),
    );
  } finally {
    setBusyToolId(null);
  }
}
