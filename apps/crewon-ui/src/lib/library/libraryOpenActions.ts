import type { ExternalAgentConfigDetectResponse } from "@crewon-protocol/v2/ExternalAgentConfigDetectResponse";
import type { PluginListResponse } from "@crewon-protocol/v2/PluginListResponse";
import type { SkillsListResponse } from "@crewon-protocol/v2/SkillsListResponse";

import type { AppServerClient } from "../app-server/appServer";
import {
  readAgentPlatformAgentItems,
  readAgentPlatformKnowledgeData,
  readAgentPlatformToolItems,
} from "../agent-platform/agentPlatformClient";
import { isPlaceholderBackendCwd } from "../backend/backendWorkspace";
import type {
  KnowledgeData,
  LibraryItem,
  LibraryKind,
  LibraryPanel,
} from "../domain/crewonDomain";
import type { McpInventory } from "../domain/domainCollaborationBackend";
import { toolLibraryPanelContent } from "../domain/domainToolLibraryItems";
import type { Locale } from "../i18n";
import {
  backendAgentCollectionContent,
  backendAutomationCollectionContent,
  backendOfficeCollectionContent,
  knowledgeLibraryPanel,
  libraryCollectionPanel,
  libraryDisconnectedPanel,
  libraryLoadFailurePanel,
  libraryLoadingPanel,
} from "./libraryCollectionPanels";
import { libraryLoadingFallbackPanel } from "./libraryPanelFormatters";
import { buildPluginLibraryPanelContent } from "../plugin/pluginLibraryPanel";

type LibraryPanelSetter = (
  panel:
    | LibraryPanel
    | null
    | ((currentPanel: LibraryPanel | null) => LibraryPanel | null),
) => void;

type AutomationConfigListResponse = Awaited<
  ReturnType<AppServerClient["listAutomationConfigs"]>
>;
type OfficeConfigListResponse = Awaited<
  ReturnType<AppServerClient["listOfficeConfigs"]>
>;

export type OpenLibraryActionParams = {
  beginLibraryLoad: () => () => boolean;
  connectionHint: string;
  cwd: string;
  demoLibraryPanel: (kind: LibraryKind, locale: Locale) => LibraryPanel;
  detectExternalAgentConfig: (
    cwd: string,
  ) => Promise<ExternalAgentConfigDetectResponse | null | undefined>;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  isUnsupportedRpcError: (error: unknown) => boolean;
  kind: LibraryKind;
  listAutomationConfigs: (
    cwd: string,
  ) => Promise<AutomationConfigListResponse | null | undefined>;
  listOfficeConfigs: (
    cwd: string,
  ) => Promise<OfficeConfigListResponse | null | undefined>;
  listPlugins: (cwd: string) => Promise<PluginListResponse | null | undefined>;
  listSkills: (cwd: string) => Promise<SkillsListResponse | null | undefined>;
  loadAgentLibraryItems: (cwd: string) => Promise<LibraryItem[]>;
  loadMcpInventory: (
    selectedThreadId: string | undefined,
    cwd: string,
  ) => Promise<McpInventory>;
  loadToolLibraryItems: (cwd: string) => Promise<LibraryItem[]>;
  locale: Locale;
  readKnowledgeData: () => Promise<KnowledgeData>;
  resolveBackendCwd: () => Promise<string>;
  selectedThreadId: string | null;
  setAppView: (view: "library") => void;
  setCapabilityDockOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setLibraryPanel: LibraryPanelSetter;
  storedAutomationItems: (
    records: AutomationConfigListResponse["data"],
  ) => Promise<LibraryItem[]>;
  storedOfficeItems: (
    records: OfficeConfigListResponse["data"],
  ) => LibraryItem[];
};

export async function openLibraryAction({
  beginLibraryLoad,
  connectionHint,
  cwd,
  demoLibraryPanel,
  detectExternalAgentConfig,
  isConnected,
  isDemo,
  isDemoPreview,
  isUnsupportedRpcError,
  kind,
  listAutomationConfigs,
  listOfficeConfigs,
  listPlugins,
  listSkills,
  loadAgentLibraryItems,
  loadMcpInventory,
  loadToolLibraryItems,
  locale,
  readKnowledgeData,
  resolveBackendCwd,
  selectedThreadId,
  setAppView,
  setCapabilityDockOpen,
  setInspectorOpen,
  setLibraryPanel,
  storedAutomationItems,
  storedOfficeItems,
}: OpenLibraryActionParams): Promise<void> {
  const isCurrentLibraryLoad = beginLibraryLoad();
  setAppView("library");
  setCapabilityDockOpen(false);
  setInspectorOpen(false);
  setLibraryPanel(libraryLoadingPanel(kind, locale));
  const loadingFallbackTimer = window.setTimeout(() => {
    if (!isCurrentLibraryLoad()) {
      return;
    }
    setLibraryPanel((currentPanel) =>
      currentPanel?.kind === kind &&
      currentPanel.items.length === 0 &&
      !currentPanel.error
        ? libraryLoadingFallbackPanel(kind, locale)
        : currentPanel,
    );
  }, 1800);

  if (!isConnected) {
    try {
      const platformPanel = await loadAgentPlatformFallbackPanel(kind, locale);
      window.clearTimeout(loadingFallbackTimer);
      if (!isCurrentLibraryLoad()) {
        return;
      }
      if (platformPanel) {
        setLibraryPanel(platformPanel);
        return;
      }
    } catch {
      // Keep the original disconnected/demo behavior when local agent-platform
      // is unavailable or not yet configured.
    }

    window.clearTimeout(loadingFallbackTimer);
    if (isDemo) {
      setLibraryPanel(demoLibraryPanel(kind, locale));
      return;
    }

    setLibraryPanel(libraryDisconnectedPanel(kind, connectionHint, locale));
    return;
  }

  try {
    const shouldResolveCwd =
      isDemoPreview || !cwd.trim() || isPlaceholderBackendCwd(cwd);
    const effectiveCwd = shouldResolveCwd ? await resolveBackendCwd() : cwd;
    if (!effectiveCwd.trim()) {
      throw new Error(
        locale === "zh"
          ? "缺少后端工作区，无法读取资源库。"
          : "No backend workspace is available for the library.",
      );
    }
    const effectiveThreadId = isDemoPreview
      ? undefined
      : (selectedThreadId ?? undefined);

    if (kind === "tools") {
      const [
        mcpInventory,
        skillsResponse,
        pluginsResponse,
        workspaceToolItems,
        platformToolItems,
      ] = await Promise.all([
        loadMcpInventory(effectiveThreadId, effectiveCwd).catch(() => ({
          configs: [],
          servers: [],
          statuses: [],
        })),
        listSkills(effectiveCwd).catch(() => null),
        listPlugins(effectiveCwd).catch(() => null),
        loadToolLibraryItems(effectiveCwd).catch(() => []),
        readAgentPlatformToolItems().catch(() => []),
      ]);
      if (!isCurrentLibraryLoad()) {
        return;
      }
      setLibraryPanel(
        libraryCollectionPanel(
          kind,
          toolLibraryPanelContent({
            mcpInventory,
            pluginsResponse,
            skillsResponse,
            workspaceToolItems: [...platformToolItems, ...workspaceToolItems],
            locale,
          }),
          locale,
        ),
      );
      return;
    }

    if (kind === "office") {
      let items: LibraryItem[] = [];
      let listUnsupported = false;
      try {
        const response = await listOfficeConfigs(effectiveCwd);
        items = storedOfficeItems(response?.data ?? []);
      } catch (error) {
        if (!isUnsupportedRpcError(error)) {
          throw error;
        }
        listUnsupported = true;
      }
      if (!isCurrentLibraryLoad()) {
        return;
      }
      setLibraryPanel(
        libraryCollectionPanel(
          kind,
          backendOfficeCollectionContent({ items, listUnsupported, locale }),
          locale,
        ),
      );
      return;
    }

    if (kind === "automation") {
      let items: LibraryItem[] = [];
      let listUnsupported = false;
      try {
        const response = await listAutomationConfigs(effectiveCwd);
        items = await storedAutomationItems(response?.data ?? []);
      } catch (error) {
        if (!isUnsupportedRpcError(error)) {
          throw error;
        }
        listUnsupported = true;
      }
      if (!isCurrentLibraryLoad()) {
        return;
      }
      setLibraryPanel(
        libraryCollectionPanel(
          kind,
          backendAutomationCollectionContent({
            items,
            listUnsupported,
            locale,
          }),
          locale,
        ),
      );
      return;
    }

    if (kind === "knowledge") {
      const [knowledge, platformKnowledge] = await Promise.all([
        readKnowledgeData().catch(() => ({ memories: [], sources: [] })),
        readAgentPlatformKnowledgeData().catch(() => ({
          memories: [],
          sources: [],
        })),
      ]);
      if (!isCurrentLibraryLoad()) {
        return;
      }
      setLibraryPanel(
        knowledgeLibraryPanel(
          {
            memories: [...platformKnowledge.memories, ...knowledge.memories],
            sources: [...platformKnowledge.sources, ...knowledge.sources],
          },
          locale,
        ),
      );
      return;
    }

    if (kind === "agents") {
      const [response, storedItems, platformItems] = await Promise.all([
        detectExternalAgentConfig(effectiveCwd).catch(() => null),
        loadAgentLibraryItems(effectiveCwd).catch(() => []),
        readAgentPlatformAgentItems().catch(() => []),
      ]);
      if (!isCurrentLibraryLoad()) {
        return;
      }
      setLibraryPanel(
        libraryCollectionPanel(
          kind,
          backendAgentCollectionContent({
            storedItems: [...platformItems, ...storedItems],
            detectedItems: response?.items ?? [],
            locale,
          }),
          locale,
        ),
      );
      return;
    }

    const response = await listPlugins(effectiveCwd);
    if (!isCurrentLibraryLoad()) {
      return;
    }
    setLibraryPanel(
      libraryCollectionPanel(
        kind,
        buildPluginLibraryPanelContent(
          response?.marketplaces ?? [],
          response?.marketplaceLoadErrors ?? [],
          locale,
        ),
        locale,
      ),
    );
  } catch (error) {
    if (!isCurrentLibraryLoad()) {
      return;
    }
    setLibraryPanel(libraryLoadFailurePanel(kind, error, locale));
  } finally {
    window.clearTimeout(loadingFallbackTimer);
  }
}

async function loadAgentPlatformFallbackPanel(
  kind: LibraryKind,
  locale: Locale,
): Promise<LibraryPanel | null> {
  if (kind === "agents") {
    const items = await readAgentPlatformAgentItems();
    return libraryCollectionPanel(
      kind,
      backendAgentCollectionContent({
        storedItems: items,
        detectedItems: [],
        locale,
      }),
      locale,
    );
  }

  if (kind === "tools") {
    const items = await readAgentPlatformToolItems();
    return libraryCollectionPanel(
      kind,
      {
        subtitle: `${items.length} local agent-platform tools`,
        body: "Loaded from local agent-platform while CrewON app-server is unavailable.",
        items,
      },
      locale,
    );
  }

  if (kind === "knowledge") {
    return knowledgeLibraryPanel(await readAgentPlatformKnowledgeData(), locale);
  }

  return null;
}
