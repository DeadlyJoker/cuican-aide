import { ListChecks, Plus, ShieldCheck, Target } from "lucide-react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CommandOfficeCreateDialog } from "./CommandOfficeCreateDialog";
import {
  CommandTeamCapabilityCreateDialog,
  type CommandTeamCapabilityCreateInput,
} from "./CommandTeamCapabilityCreateDialog";
import { useCommandOfficeCatalogAutoReconnect } from "./commandOfficeCatalogReconnect";
import {
  createCommandOffice,
  type CommandOfficeCreationClient,
  type CommandOfficeCreationInput,
} from "./commandOfficeCreation";
import {
  commandTeamWorkspaceCwdFromSearch,
  initialCommandTeamWorkspaceCwd,
  persistCommandTeamWorkspaceCwd,
} from "./commandTeamWorkspace";
import {
  CommandSidebar,
  Palette,
  type CommandLinkedThread,
  type PaletteItemWithCommand,
} from "./CommandWorkspaceChrome";
import { CommandWorkspaceAssistant } from "./CommandWorkspaceAssistant";
import { CommandThreadRoom } from "./CommandWorkspaceConversation";
import { CommandSceneHeader } from "./CommandSceneHeader";
import {
  AgentsView,
  KnowledgeCatalogView,
  ProjectsView,
  TeamView,
} from "./CommandWorkspaceViews";
import { ScheduleView, type ScheduleClient } from "./CommandWorkspaceSchedule";
import { classNames } from "./commandWorkspaceUtils";
import {
  agentPlatformResourceStates as selectAgentPlatformResourceStates,
  emptyAgentPlatformSnapshot,
  insertTokenIntoComposerValue,
  selectCommandHomeSlots,
  type AgentPlatformComposerResource,
  type CommandHomeSlots,
  type CommandShellView,
} from "./commandWorkspaceState";
import {
  commandSceneContextItems,
  commandSceneSlashItems,
} from "./commandWorkspaceSceneResources";
import {
  createAgentPlatformWorkflow,
  getAgentPlatformAccessToken,
  readAgentPlatformSnapshot,
  type AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
import { isLegacyGeneratedAgentPlaceholder } from "../../lib/agent-config/legacyAgentPlaceholder";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { Locale } from "../../lib/i18n";
import type { ConnectionState } from "../../lib/shared/connectionState";
import {
  pendingComposerImagesFromFiles,
  pastedImageFiles,
  type PendingComposerImage,
} from "../../lib/shared/composerImageAttachments";
import type { ComposerImageInput } from "../../lib/shared/composerImages";
import {
  removeComposerMentionToken,
  type PendingComposerMention,
} from "../../lib/shared/composerMentions";
import type { LocalResourceSelectionKind } from "../../lib/shared/localResourceAttachments";
import { formatRelativeTime } from "../../lib/shared/text";
import type { ExpertTeamRecordReference } from "../../lib/experts/expertTeamRecord";
import {
  executionTargetOptionsFromDomain,
  scenePresets,
  scenePresetsEn,
  type CommandScene,
  type SceneInteractionMode,
} from "../../lib/scene/sceneCatalog";
import type { AgentConfig } from "../../lib/domain/domainTypes";
import {
  officeRecordKey,
  type OfficeConfigRecordReference,
} from "../../lib/office/officePanelFromRecord";
import { isLegacyGeneratedOfficePlaceholder } from "../../lib/office/legacyOfficePlaceholder";
import {
  commandComposerRuntimeSettings,
  fallbackCommandModelOptions,
  type CommandComposerPermission,
  type CommandExecutionIntent,
  type CommandModelOption,
  type ThreadRuntimeSettings,
} from "../../lib/thread/threadRuntimeSettings";
import type { WorkMode } from "../../lib/workMode";
import { sidebarThreadTitle } from "../SidebarPresentation";
import {
  CommandComposer,
  CommandComposerSelect,
  type CommandComposerSelectOption,
} from "../composer/CommandComposer";
import {
  ComposerResourceTags,
  type ComposerResourceTag,
} from "../composer/ComposerResourceTags";
import {
  ProviderResourceComposerPopover,
  providerResourceComposerTag,
} from "../provider-resource/ProviderResourcePicker";
import type { ProviderResourceSnapshot } from "../../lib/provider-resource/providerResourceSession";
import {
  providerAgentExecutionTargetOptions,
  providerAgentResourceForTarget,
} from "../../lib/provider-resource/providerAgentExecutionTargets";
import type { ResourceRef } from "@crewon-platform-protocol/v2/ResourceRef";

export {
  activateDesignPanelTab,
  applyDesignCardVisibility,
  cleanSlotTitle,
  insertTokenIntoComposerValue,
  selectCommandHomeSlots,
  setActiveFilter,
  setDefaultTeamOfficePreview,
  syncDesignFilterState,
} from "./commandWorkspaceState";
export { composerKeyIntent as commandComposerKeyIntent } from "../composer/ComposerCore";
export type {
  ComposerKeyIntent as CommandComposerKeyIntent,
  ComposerKeyIntentInput as CommandComposerKeyIntentInput,
} from "../composer/ComposerCore";

type CommandWorkspaceProps = {
  activeTurnId?: string | null;
  assistantActiveTurnId?: string | null;
  assistantStreamingText?: string;
  assistantThread?: Thread | null;
  composerValue: string;
  connectionState: ConnectionState;
  cwd: string;
  executionTargetClient?: {
    addOfficeMemberConfig: CommandOfficeCreationClient["addOfficeMemberConfig"];
    createOfficeConfig: CommandOfficeCreationClient["createOfficeConfig"];
    listAgentConfigs(cwd: string): Promise<{
      data: Array<{ config: AgentConfig; filePath: string }>;
    }>;
    listOfficeConfigs(cwd: string): Promise<{
      data: OfficeConfigRecordReference[];
    }>;
    saveAgentConfig?: (cwd: string, config: AgentConfig) => Promise<unknown>;
    updateAgentConfig?: (
      cwd: string,
      filePath: string,
      config: AgentConfig,
    ) => Promise<unknown>;
    deleteAgentConfig?: (cwd: string, filePath: string) => Promise<unknown>;
    executeAgentPlatformWorkflow?: (
      accessToken: string,
      workflowId: string,
      input: string,
    ) => Promise<{
      workflowId: number;
      executionId: number;
      status: string;
      outputs: unknown;
      executedNodes: unknown[];
      nodeResults: unknown;
      error: string | null;
    }>;
    listExpertTeams?: (
      workspaceKey: string,
    ) => Promise<{ data: ExpertTeamRecordReference[] }>;
    listRegisteredWorkspaces?: () => Promise<{
      data: Array<{ workspaceKey: string; displayName: string }>;
    }>;
    createExpertTeam?: (
      workspaceKey: string,
      input: Omit<
        Extract<CommandTeamCapabilityCreateInput, { kind: "experts" }>,
        "kind"
      >,
    ) => Promise<{ record: ExpertTeamRecordReference }>;
  } | null;
  scheduleClient?: ScheduleClient | null;
  isSending: boolean;
  linkedThreads?: Thread[];
  locale?: Locale;
  modelOptions?: CommandModelOption[];
  officeRoomAdapter?: CommandOfficeRoomAdapter | null;
  pendingComposerMentions?: PendingComposerMention[];
  selectedThread?: Thread | null;
  selectedThreadId?: string | null;
  slashCommands?: ComposerSlashCommand[];
  streamingText?: string;
  workMode: WorkMode;
  onAttachContext: (workspaceCwd?: string | null) => void;
  onAddLocalResources?: (
    files: File[],
    kind: LocalResourceSelectionKind,
  ) => void | Promise<void>;
  onChangeComposerValue: (value: string) => void;
  onComposerResourceSelect?: (
    selection: CommandComposerResourceSelection,
  ) => void;
  onChangeWorkspaceCwd?: (cwd: string | null) => void;
  onClearAssistantThread?: () => void | Promise<void>;
  onModeChange: (mode: WorkMode) => void;
  onOpenSettings?: () => void;
  onSaveCapability?: import("../../lib/capability/capabilityCatalog").CapabilityEditorSaveHandler;
  onRetryConnection: () => void;
  onRemoveComposerMention?: (path: string) => void;
  onSend: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
    images?: ComposerImageInput[],
  ) => void;
  onSendAssistant?: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
    images?: ComposerImageInput[],
  ) => void;
  onSendNewThread?: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
    workspaceCwd?: string | null,
    images?: ComposerImageInput[],
  ) => void;
  onSelectLinkedThread?: (threadId: string | null) => void;
  onSlashCommandSelect?: (command: ComposerSlashCommand) => void;
  onStop?: () => void;
  providerResource?: {
    snapshot: ProviderResourceSnapshot;
    selectedResource: ResourceRef | null;
    executionAgents?: ResourceRef[];
    selectedExecutionAgent?: ResourceRef | null;
    selectedWorkspaceKey: string | null;
    canSelect: boolean;
    onRefresh: () => void | Promise<void>;
    onSelect: (resource: ResourceRef | null) => void;
    onExecutionAgentSelect?: (resource: ResourceRef | null) => void;
    onUnbind: () => void | Promise<void>;
    onWorkspaceSelect: (workspaceKey: string) => void;
  };
};

export type CommandComposerResourceSelection = {
  kind: "knowledge" | "mcp" | "skill";
  name: string;
  platformResource: AgentPlatformComposerResource;
};

export function commandComposerResourceSelection(
  item: PaletteItemWithCommand,
): CommandComposerResourceSelection | null {
  if (
    !item.platformResource ||
    (item.kind !== "knowledge" && item.kind !== "mcp" && item.kind !== "skill")
  ) {
    return null;
  }
  return {
    kind: item.kind,
    name: item.title,
    platformResource: item.platformResource,
  };
}

export function submitCommandComposer({
  cwd,
  onSend,
  onSendNewThread,
  settings,
  shouldCreateNewThread,
  text,
  images,
}: {
  cwd: string | null;
  onSend: CommandWorkspaceProps["onSend"];
  onSendNewThread: CommandWorkspaceProps["onSendNewThread"];
  settings: ThreadRuntimeSettings;
  shouldCreateNewThread: boolean;
  text: string;
  images?: ComposerImageInput[];
}): void {
  if (shouldCreateNewThread && onSendNewThread) {
    if (images?.length) {
      onSendNewThread(text, settings, cwd, images);
    } else {
      onSendNewThread(text, settings, cwd);
    }
    return;
  }
  if (images?.length) {
    onSend(text, settings, images);
  } else {
    onSend(text, settings);
  }
}

export function shouldCreateCommandThread({
  hasProviderAgentTarget,
  isProviderAgentBoundToSelectedThread,
  newTaskDraft,
  selectedThread,
}: {
  hasProviderAgentTarget: boolean;
  isProviderAgentBoundToSelectedThread: boolean;
  newTaskDraft: boolean;
  selectedThread: Thread | null | undefined;
}): boolean {
  return (
    newTaskDraft ||
    !selectedThread ||
    (hasProviderAgentTarget && !isProviderAgentBoundToSelectedThread)
  );
}

export type CommandOfficeRoomAdapter = {
  open: (record: OfficeConfigRecordReference) => void | Promise<void>;
  render: (
    record: OfficeConfigRecordReference,
    onBack: () => void,
    onDeleted: () => void,
  ) => ReactNode;
};

type PlatformLoadState = "loading" | "ready" | "fallback";
type TeamMode = "office" | "workflow" | "experts";
type CommandDomainCatalog = {
  agents: Array<{ config: AgentConfig; filePath: string }>;
  officeStatus: "loading" | "ready" | "unavailable";
  offices: OfficeConfigRecordReference[];
  status: "loading" | "ready" | "unavailable";
};
const shellViewIds: CommandShellView[] = [
  "command",
  "assist",
  "projects",
  "agents",
  "knowledge",
  "schedule",
  "team",
];

const noWorkspaceValue = "__no_workspace__";

function isShellView(value: string): value is CommandShellView {
  return shellViewIds.includes(value as CommandShellView);
}

function shellViewFromHash(): CommandShellView {
  if (typeof window === "undefined") {
    return "command";
  }
  const value = window.location.hash.replace(/^#view-/, "");
  return isShellView(value) ? value : "command";
}

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

function paletteFilter(items: PaletteItemWithCommand[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return items;
  }
  return items.filter((item) =>
    [item.label, item.title, item.detail, item.token]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
}

export function nextExecutionIntent(
  current: CommandExecutionIntent,
  selected: Exclude<CommandExecutionIntent, "none">,
): CommandExecutionIntent {
  return current === selected ? "none" : selected;
}

export function SelectedExecutionIntent({
  intent,
  locale,
  onClear,
}: {
  intent: CommandExecutionIntent;
  locale: Locale;
  onClear: () => void;
}) {
  if (intent === "none") {
    return null;
  }
  const isGoal = intent === "goal";
  const label = isGoal
    ? locale === "zh"
      ? "目标"
      : "Goal"
    : locale === "zh"
      ? "计划模式"
      : "Plan mode";
  return (
    <button
      aria-label={
        locale === "zh" ? `取消${label}` : `Clear ${label.toLowerCase()}`
      }
      aria-pressed="true"
      className="execution-intent-button selected-execution-intent"
      data-execution-intent={intent}
      title={locale === "zh" ? `点击取消${label}` : `Click to clear ${label}`}
      type="button"
      onClick={onClear}
    >
      {isGoal ? (
        <Target aria-hidden="true" />
      ) : (
        <ListChecks aria-hidden="true" />
      )}
      <span>{label}</span>
    </button>
  );
}

export function shouldCloseComposerPalette({
  paletteRoots,
  target,
  triggers,
}: {
  paletteRoots: Array<Pick<Node, "contains">>;
  target: Node | null;
  triggers: Array<Pick<Node, "contains">>;
}): boolean {
  if (!target) {
    return false;
  }
  return ![...paletteRoots, ...triggers].some((element) =>
    element.contains(target),
  );
}

export function CommandWorkspace({
  activeTurnId = null,
  assistantActiveTurnId = null,
  assistantStreamingText = "",
  assistantThread = null,
  composerValue,
  connectionState,
  cwd,
  executionTargetClient = null,
  scheduleClient = null,
  isSending,
  linkedThreads = [],
  locale = "zh",
  modelOptions = fallbackCommandModelOptions,
  officeRoomAdapter = null,
  pendingComposerMentions = [],
  selectedThread = null,
  selectedThreadId = null,
  slashCommands = [],
  streamingText = "",
  workMode,
  onAddLocalResources,
  onChangeComposerValue,
  onComposerResourceSelect,
  onChangeWorkspaceCwd,
  onClearAssistantThread,
  onModeChange,
  onOpenSettings,
  onSaveCapability,
  onRemoveComposerMention,
  onRetryConnection,
  onSend,
  onSendAssistant,
  onSendNewThread,
  onSelectLinkedThread,
  onSlashCommandSelect,
  onStop,
  providerResource,
}: CommandWorkspaceProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const assistantTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const lastCommandThreadIdRef = useRef<string | null>(selectedThreadId);
  const [activeView, setActiveView] = useState<CommandShellView>(() =>
    shellViewFromHash(),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [activeLinkedThreadId, setActiveLinkedThreadId] = useState<
    string | null
  >(selectedThreadId);
  const [newTaskDraft, setNewTaskDraft] = useState(false);
  const [assistantComposerValue, setAssistantComposerValue] = useState("");
  const [commandImages, setCommandImages] = useState<PendingComposerImage[]>(
    [],
  );
  const [assistantImages, setAssistantImages] = useState<
    PendingComposerImage[]
  >([]);
  const [scene, setScene] = useState<CommandScene>("office");
  const [sceneMode, setSceneMode] = useState<SceneInteractionMode>("auto");
  const [model, setModel] = useState(fallbackCommandModelOptions[0].value);
  const [modelSelectionTouched, setModelSelectionTouched] = useState(false);
  const [executionTarget, setExecutionTarget] = useState("crewon");
  const [executionTargetCatalog, setExecutionTargetCatalog] =
    useState<CommandDomainCatalog>({
      agents: [],
      offices: [],
      officeStatus: "loading",
      status: "loading",
    });
  const [permission, setPermission] =
    useState<CommandComposerPermission>("approve-for-me");
  const [executionIntent, setExecutionIntent] =
    useState<CommandExecutionIntent>("none");
  const [openPalette, setOpenPalette] = useState<
    "add" | "context" | "provider" | "slash" | null
  >(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [platformState, setPlatformState] =
    useState<PlatformLoadState>("loading");
  const [platformSnapshot, setPlatformSnapshot] =
    useState<AgentPlatformSnapshot>(emptyAgentPlatformSnapshot);
  const [catalogFilter, setCatalogFilter] = useState("skill");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [scheduleMode, setScheduleMode] = useState("tasks");
  const [scheduleSource, setScheduleSource] = useState("personal");
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [teamMode, setTeamMode] = useState<TeamMode>("office");
  const [teamWorkspaceCwd, setTeamWorkspaceCwd] = useState(() =>
    initialCommandTeamWorkspaceCwd(cwd),
  );
  const [teamCatalog, setTeamCatalog] = useState<CommandDomainCatalog>({
    agents: [],
    offices: [],
    officeStatus: "loading",
    status: "loading",
  });
  const [teamRefreshNonce, setTeamRefreshNonce] = useState(0);
  const [officeRoomId, setOfficeRoomId] = useState<string | null>(null);
  const [officeCreateOpen, setOfficeCreateOpen] = useState(false);
  const [officeCreateBusy, setOfficeCreateBusy] = useState(false);
  const [officeCreateError, setOfficeCreateError] = useState<string | null>(
    null,
  );
  const [expertTeams, setExpertTeams] = useState<ExpertTeamRecordReference[]>(
    [],
  );
  const [expertTeamsStatus, setExpertTeamsStatus] = useState<
    "loading" | "ready" | "unavailable"
  >("loading");
  const [expertCreateOpen, setExpertCreateOpen] = useState(false);
  const [expertCreateError, setExpertCreateError] = useState<string | null>(
    null,
  );
  const [expertCreateBusy, setExpertCreateBusy] = useState(false);
  const [workflowCreateOpen, setWorkflowCreateOpen] = useState(false);
  const [workflowCreateError, setWorkflowCreateError] = useState<string | null>(
    null,
  );
  const [workflowCreateBusy, setWorkflowCreateBusy] = useState(false);
  const [fallbackExpertWorkspaceKey, setFallbackExpertWorkspaceKey] = useState<
    string | null
  >(null);
  const [officeRoomWarning, setOfficeRoomWarning] = useState<string | null>(
    null,
  );
  const [selectedOfficeRecord, setSelectedOfficeRecord] =
    useState<OfficeConfigRecordReference | null>(null);
  const [officeRoomError, setOfficeRoomError] = useState<string | null>(null);
  const officeOpenRequestRef = useRef(0);

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    function syncRoute() {
      setActiveView(shellViewFromHash());
      const routeTeamCwd = commandTeamWorkspaceCwdFromSearch(
        window.location.search,
        cwd,
      );
      setTeamWorkspaceCwd(routeTeamCwd);
    }
    window.addEventListener("hashchange", syncRoute);
    window.addEventListener("popstate", syncRoute);
    return () => {
      window.removeEventListener("hashchange", syncRoute);
      window.removeEventListener("popstate", syncRoute);
    };
  }, [cwd]);

  useEffect(() => {
    if (!teamWorkspaceCwd && cwd.trim()) {
      setTeamWorkspaceCwd(cwd.trim());
    }
  }, [cwd, teamWorkspaceCwd]);

  useEffect(() => {
    const normalizedCwd = teamWorkspaceCwd.trim();
    if (!normalizedCwd || typeof window === "undefined") {
      return;
    }
    const persistedCwd = new URLSearchParams(window.location.search)
      .get("teamCwd")
      ?.trim();
    if (!persistedCwd) {
      persistCommandTeamWorkspaceCwd(normalizedCwd);
    }
  }, [teamWorkspaceCwd]);

  useEffect(() => {
    let cancelled = false;
    if (!executionTargetClient || !cwd || connectionState !== "connected") {
      setExecutionTargetCatalog({
        agents: [],
        offices: [],
        officeStatus:
          connectionState === "connecting" ? "loading" : "unavailable",
        status: connectionState === "connecting" ? "loading" : "unavailable",
      });
      return;
    }
    setExecutionTargetCatalog({
      agents: [],
      offices: [],
      officeStatus: "loading",
      status: "loading",
    });
    Promise.allSettled([
      executionTargetClient.listAgentConfigs(cwd),
      executionTargetClient.listOfficeConfigs(cwd),
    ]).then(([agents, offices]) => {
      if (!cancelled) {
        const agentsAvailable = agents.status === "fulfilled";
        const officesAvailable = offices.status === "fulfilled";
        setExecutionTargetCatalog({
          agents: agentsAvailable
            ? agents.value.data.filter(
                (record) => !isLegacyGeneratedAgentPlaceholder(record.config),
              )
            : [],
          offices: officesAvailable
            ? offices.value.data
                .filter(
                  (record) =>
                    !isLegacyGeneratedOfficePlaceholder(record.config),
                )
                .map((record) => ({
                  ...record,
                  workspaceCwd: cwd,
                }))
            : [],
          officeStatus: officesAvailable ? "ready" : "unavailable",
          status: agentsAvailable || officesAvailable ? "ready" : "unavailable",
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [connectionState, cwd, executionTargetClient]);

  useEffect(() => {
    let cancelled = false;
    if (
      !executionTargetClient ||
      !teamWorkspaceCwd ||
      connectionState !== "connected"
    ) {
      setTeamCatalog({
        agents: [],
        offices: [],
        officeStatus:
          connectionState === "connecting" ? "loading" : "unavailable",
        status: connectionState === "connecting" ? "loading" : "unavailable",
      });
      return;
    }
    setTeamCatalog({
      agents: [],
      offices: [],
      officeStatus: "loading",
      status: "loading",
    });
    Promise.allSettled([
      executionTargetClient.listAgentConfigs(teamWorkspaceCwd),
      executionTargetClient.listOfficeConfigs(teamWorkspaceCwd),
    ]).then(([agents, offices]) => {
      if (cancelled) {
        return;
      }
      const agentsAvailable = agents.status === "fulfilled";
      const officesAvailable = offices.status === "fulfilled";
      setTeamCatalog({
        agents: agentsAvailable
          ? agents.value.data.filter(
              (record) => !isLegacyGeneratedAgentPlaceholder(record.config),
            )
          : [],
        offices: officesAvailable
          ? offices.value.data
              .filter(
                (record) => !isLegacyGeneratedOfficePlaceholder(record.config),
              )
              .map((record) => ({
                ...record,
                workspaceCwd: teamWorkspaceCwd,
              }))
          : [],
        officeStatus: officesAvailable ? "ready" : "unavailable",
        status: agentsAvailable || officesAvailable ? "ready" : "unavailable",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    connectionState,
    executionTargetClient,
    teamRefreshNonce,
    teamWorkspaceCwd,
  ]);

  useCommandOfficeCatalogAutoReconnect({
    active: activeView === "team" && teamMode === "office",
    connectionState,
    refreshNonce: setTeamRefreshNonce,
    status: teamCatalog.officeStatus,
    workspaceCwd: teamWorkspaceCwd,
  });

  const providerExpertWorkspaceKey = useMemo(() => {
    if (providerResource?.selectedWorkspaceKey) {
      return providerResource.selectedWorkspaceKey;
    }
    const workspaces = providerResource?.snapshot.workspaces ?? [];
    const matching = workspaces.filter(
      (workspace) => workspace.displayName === basename(cwd),
    );
    if (matching.length === 1) {
      return matching[0]?.workspaceKey ?? null;
    }
    return workspaces.length === 1
      ? (workspaces[0]?.workspaceKey ?? null)
      : null;
  }, [
    cwd,
    providerResource?.selectedWorkspaceKey,
    providerResource?.snapshot.workspaces,
  ]);
  const expertWorkspaceKey =
    providerExpertWorkspaceKey ?? fallbackExpertWorkspaceKey;

  useEffect(() => {
    let cancelled = false;
    if (
      providerExpertWorkspaceKey ||
      !executionTargetClient?.listRegisteredWorkspaces
    ) {
      setFallbackExpertWorkspaceKey(null);
      return;
    }
    executionTargetClient
      .listRegisteredWorkspaces()
      .then((response) => {
        if (cancelled) {
          return;
        }
        const matching = response.data.filter(
          (workspace) => workspace.displayName === basename(cwd),
        );
        setFallbackExpertWorkspaceKey(
          matching.length === 1
            ? (matching[0]?.workspaceKey ?? null)
            : response.data.length === 1
              ? (response.data[0]?.workspaceKey ?? null)
              : null,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setFallbackExpertWorkspaceKey(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, executionTargetClient, providerExpertWorkspaceKey]);

  useEffect(() => {
    let cancelled = false;
    if (
      connectionState !== "connected" ||
      !expertWorkspaceKey ||
      !executionTargetClient?.listExpertTeams
    ) {
      setExpertTeams([]);
      setExpertTeamsStatus(
        connectionState === "connecting" ? "loading" : "unavailable",
      );
      return;
    }
    setExpertTeamsStatus("loading");
    executionTargetClient
      .listExpertTeams(expertWorkspaceKey)
      .then((response) => {
        if (!cancelled) {
          setExpertTeams(response.data);
          setExpertTeamsStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExpertTeams([]);
          setExpertTeamsStatus("unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    connectionState,
    executionTargetClient,
    expertWorkspaceKey,
    teamRefreshNonce,
  ]);

  useEffect(() => {
    let cancelled = false;
    setPlatformState("loading");
    readAgentPlatformSnapshot()
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setPlatformSnapshot(snapshot);
        setPlatformState("ready");
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setPlatformSnapshot(emptyAgentPlatformSnapshot);
        setPlatformState("fallback");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setActiveLinkedThreadId(selectedThreadId);
  }, [selectedThreadId]);

  useEffect(() => {
    if (selectedThreadId && selectedThreadId !== assistantThread?.id) {
      lastCommandThreadIdRef.current = selectedThreadId;
    }
  }, [assistantThread?.id, selectedThreadId]);

  useEffect(() => {
    if (activeView === "assist") {
      if (assistantThread && selectedThreadId !== assistantThread.id) {
        onSelectLinkedThread?.(assistantThread.id);
      }
      return;
    }
    if (
      activeView === "command" &&
      assistantThread &&
      selectedThreadId === assistantThread.id
    ) {
      const commandThreadId = lastCommandThreadIdRef.current;
      if (
        commandThreadId &&
        linkedThreads.some((thread) => thread.id === commandThreadId)
      ) {
        onSelectLinkedThread?.(commandThreadId);
      } else {
        onSelectLinkedThread?.(null);
      }
    }
  }, [
    activeView,
    assistantThread,
    linkedThreads,
    onSelectLinkedThread,
    selectedThreadId,
  ]);

  const effectiveModelOptions =
    modelOptions.length > 0 ? modelOptions : fallbackCommandModelOptions;

  useEffect(() => {
    const defaultModel = effectiveModelOptions.find(
      (option) => option.isDefault,
    )?.value;
    if (!effectiveModelOptions.some((option) => option.value === model)) {
      setModel(
        defaultModel ??
          effectiveModelOptions[0]?.value ??
          fallbackCommandModelOptions[0].value,
      );
      return;
    }
    if (!modelSelectionTouched && defaultModel && model !== defaultModel) {
      setModel(defaultModel);
    }
  }, [effectiveModelOptions, model, modelSelectionTouched]);

  const slots = useMemo(
    () => selectCommandHomeSlots(platformSnapshot),
    [platformSnapshot],
  );
  const contextPaletteItems = useMemo(
    () => commandSceneContextItems(scene, emptyAgentPlatformSnapshot, cwd),
    [cwd, scene],
  );
  const slashPaletteItems = useMemo(
    () => commandSceneSlashItems(emptyAgentPlatformSnapshot, slashCommands),
    [slashCommands],
  );
  const providerResourceAvailable = Boolean(
    providerResource?.canSelect &&
      (providerResource.snapshot.binding ||
        (activeView === "command"
          ? !selectedThread || newTaskDraft
          : activeView === "assist" && !assistantThread)),
  );
  const addPaletteItems = useMemo<PaletteItemWithCommand[]>(
    () => [
      {
        action: "toggle-goal",
        detail:
          executionIntent === "goal"
            ? "已选择；再次点击取消目标模式"
            : "设置要持续追求的任务目标",
        kind: "intent",
        label: "目标",
        selected: executionIntent === "goal",
        title: "目标",
      },
      {
        action: "toggle-plan",
        detail:
          executionIntent === "plan"
            ? "已选择；再次点击取消计划模式"
            : "先制定计划，不直接执行",
        kind: "intent",
        label: "计划",
        selected: executionIntent === "plan",
        title: "计划模式",
      },
      {
        action: "attach-files",
        detail: "从本地电脑选择一个或多个文件",
        kind: "file",
        label: "文件",
        title: "选择文件",
      },
      {
        action: "attach-folder",
        detail: "从本地电脑选择一个文件夹",
        kind: "folder",
        label: "文件夹",
        title: "选择文件夹",
      },
      ...(providerResourceAvailable
        ? [
            {
              action: "provider-resources" as const,
              detail: "通过 app-server 添加可执行的云端 MCP Tool 或知识库",
              kind: "knowledge" as const,
              label: "云端资源",
              title: "选择云端资源",
            },
          ]
        : []),
      ...contextPaletteItems.filter((item) => item.kind === "knowledge"),
      ...slashPaletteItems.filter(
        (item) => item.kind === "skill" || item.kind === "mcp",
      ),
    ],
    [
      contextPaletteItems,
      executionIntent,
      providerResourceAvailable,
      slashPaletteItems,
    ],
  );
  const providerComposerTag =
    providerResourceAvailable && providerResource?.selectedResource
      ? providerResourceComposerTag(
          providerResource.selectedResource,
          providerResource.snapshot.binding,
        )
      : null;
  const pendingComposerResources = useMemo<ComposerResourceTag[]>(
    () =>
      pendingComposerMentions
        .filter((mention) => !mention.path.startsWith("app://"))
        .map((mention) => {
          const kind: ComposerResourceTag["kind"] =
            mention.resourceKind ??
            (mention.kind === "skill"
              ? "skill"
              : mention.path.startsWith("mcp://")
                ? "mcp"
                : "file");
          const labels: Record<ComposerResourceTag["kind"], string> = {
            file: locale === "zh" ? "文件" : "File",
            folder: locale === "zh" ? "文件夹" : "Folder",
            image: locale === "zh" ? "图片" : "Image",
            knowledge: locale === "zh" ? "知识库" : "Knowledge",
            mcp: "MCP",
            skill: "Skill",
          };
          return {
            id: mention.path,
            kind,
            label: labels[kind],
            name: mention.name || basename(mention.path),
          };
        }),
    [locale, pendingComposerMentions],
  );

  function imageResources(
    images: PendingComposerImage[],
  ): ComposerResourceTag[] {
    return images.map((image) => ({
      id: image.id,
      kind: "image",
      label: locale === "zh" ? "图片" : "Image",
      name: image.name,
    }));
  }

  function removePendingResource(
    resource: ComposerResourceTag,
    target: "assistant" | "command",
  ) {
    const mention = pendingComposerMentions.find(
      (candidate) => candidate.path === resource.id,
    );
    if (mention?.token) {
      if (target === "assistant") {
        setAssistantComposerValue((current) =>
          removeComposerMentionToken(current, mention.token),
        );
      } else {
        onChangeComposerValue(
          removeComposerMentionToken(composerValue, mention.token),
        );
      }
    }
    onRemoveComposerMention?.(resource.id);
  }
  const executionTargets = useMemo(() => {
    const domainTargets = executionTargetOptionsFromDomain({
      ...executionTargetCatalog,
      locale,
    });
    const providerTargets = providerResourceAvailable
      ? providerAgentExecutionTargetOptions(
          providerResource?.executionAgents ?? [],
        )
      : [];
    const expertTargets = expertTeams.map((record) => ({
      detail:
        locale === "zh"
          ? `${record.config.experts.length} 名后台专家 · 团长 ${record.config.leader.name}`
          : `${record.config.experts.length} background experts · lead ${record.config.leader.name}`,
      kind: "experts" as const,
      label: `${record.config.title} · ${locale === "zh" ? "专家团" : "Expert team"}`,
      strategy: "team" as const,
      value: `experts:${record.config.expertsId}`,
    }));
    return [
      ...domainTargets.slice(0, 1),
      ...providerTargets,
      ...expertTargets,
      ...domainTargets.slice(1),
    ];
  }, [
    executionTargetCatalog,
    expertTeams,
    locale,
    providerResource?.executionAgents,
    providerResourceAvailable,
  ]);
  const localizedScenePresets = locale === "zh" ? scenePresets : scenePresetsEn;
  const scenePreset = localizedScenePresets[scene];
  const localizedPermissionOptions: CommandComposerSelectOption<CommandComposerPermission>[] =
    locale === "zh"
      ? [
          {
            detail: "工作区内自动执行，必要时请求升级",
            label: "本地自动",
            value: "approve-for-me",
          },
          {
            detail: "涉及授权时先请求确认",
            label: "操作前确认",
            value: "request-approval",
          },
        ]
      : [
          {
            detail: "Run automatically in the workspace and ask when needed",
            label: "Workspace access",
            value: "approve-for-me",
          },
          {
            detail: "Ask before operations that require approval",
            label: "Ask before actions",
            value: "request-approval",
          },
        ];
  const workspaceOptions = useMemo<CommandComposerSelectOption[]>(() => {
    const paths = [cwd, ...linkedThreads.map((thread) => thread.cwd ?? "")]
      .map((path) => path.trim())
      .filter(
        (path, index, allPaths) => path && allPaths.indexOf(path) === index,
      );
    return [
      {
        detail:
          locale === "zh"
            ? "不绑定项目文件夹，使用默认执行环境"
            : "Use the default execution environment without a project folder",
        label: locale === "zh" ? "无工作空间" : "No workspace",
        value: noWorkspaceValue,
      },
      ...paths.map((path) => ({
        detail: path,
        label: basename(path),
        value: path,
      })),
    ];
  }, [cwd, linkedThreads, locale]);
  const teamWorkspaceOptions = useMemo(
    () =>
      [
        teamWorkspaceCwd,
        cwd,
        ...linkedThreads.map((thread) => thread.cwd ?? ""),
      ]
        .map((path) => path.trim())
        .filter(
          (path, index, allPaths) => path && allPaths.indexOf(path) === index,
        )
        .map((path) => ({
          label: basename(path),
          value: path,
        })),
    [cwd, linkedThreads, teamWorkspaceCwd],
  );

  useEffect(() => {
    const targetProviderAgent = providerAgentResourceForTarget(
      providerResource?.executionAgents ?? [],
      executionTarget,
    );
    const selectedProviderAgentMatches =
      !targetProviderAgent ||
      providerAgentResourceForTarget(
        providerResource?.selectedExecutionAgent
          ? [providerResource.selectedExecutionAgent]
          : [],
        executionTarget,
      ) !== null;
    if (
      !executionTargets.some((target) => target.value === executionTarget) ||
      !selectedProviderAgentMatches
    ) {
      setExecutionTarget("crewon");
      providerResource?.onExecutionAgentSelect?.(null);
    }
  }, [
    executionTarget,
    executionTargets,
    providerResource?.executionAgents,
    providerResource?.onExecutionAgentSelect,
    providerResource?.selectedExecutionAgent,
  ]);

  function selectExecutionTarget(nextTarget: string) {
    const providerAgent = providerAgentResourceForTarget(
      providerResource?.executionAgents ?? [],
      nextTarget,
    );
    if (providerAgent) {
      providerResource?.onExecutionAgentSelect?.(providerAgent);
    } else if (providerResource?.selectedExecutionAgent) {
      providerResource.onExecutionAgentSelect?.(null);
    }
    setExecutionTarget(nextTarget);
  }
  const visibleContextItems = paletteFilter(contextPaletteItems, paletteQuery);
  const visibleSlashItems = paletteFilter(slashPaletteItems, paletteQuery);
  const visibleAddItems = paletteFilter(addPaletteItems, paletteQuery);
  const commandLinkedThreads: CommandLinkedThread[] = useMemo(
    () =>
      linkedThreads.map((thread) => ({
        cwd: thread.cwd ?? null,
        id: thread.id,
        preview: thread.preview,
        title: sidebarThreadTitle(
          thread,
          locale === "zh" ? "未命名会话" : "Untitled thread",
        ),
        updatedAt: thread.updatedAt,
        updatedLabel: formatRelativeTime(thread.updatedAt, locale),
      })),
    [linkedThreads, locale],
  );
  const platformHasResources =
    platformSnapshot.agents.length +
      platformSnapshot.skills.length +
      platformSnapshot.mcpServers.length +
      platformSnapshot.knowledgeBases.length +
      platformSnapshot.workflows.length >
    0;
  const platformResourceStates =
    selectAgentPlatformResourceStates(platformSnapshot);
  const resourceStatus =
    platformState === "loading"
      ? "正在读取当前账号的资源。"
      : platformState === "fallback"
        ? "本地 agent-platform 未连接，对话后端不受影响。"
        : platformHasResources
          ? "Agent-platform 资源已同步。"
          : "当前账号暂无已创建或已授权的资源。";

  async function reloadPlatformResources() {
    setPlatformState("loading");
    try {
      setPlatformSnapshot(await readAgentPlatformSnapshot());
      setPlatformState("ready");
    } catch {
      setPlatformSnapshot(emptyAgentPlatformSnapshot);
      setPlatformState("fallback");
    }
  }

  function switchView(view: CommandShellView) {
    setOpenPalette(null);
    setPaletteQuery("");
    setActiveView(view);
    if (typeof window !== "undefined") {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#view-${view}`,
      );
    }
  }

  function focusActiveComposer() {
    const ref = activeView === "assist" ? assistantTextareaRef : textareaRef;
    ref.current?.focus();
  }

  async function pasteImages(
    event: ClipboardEvent<HTMLTextAreaElement>,
    target: "assistant" | "command",
  ) {
    const files = pastedImageFiles(event.clipboardData.items);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    const currentImages =
      target === "assistant" ? assistantImages : commandImages;
    const nextImages = await pendingComposerImagesFromFiles(
      files,
      currentImages.length,
    );
    if (target === "assistant") {
      setAssistantImages((current) => [...current, ...nextImages]);
    } else {
      setCommandImages((current) => [...current, ...nextImages]);
    }
    focusActiveComposer();
  }

  async function addLocalResources(
    event: ChangeEvent<HTMLInputElement>,
    kind: LocalResourceSelectionKind,
  ) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0 || !onAddLocalResources) {
      return;
    }
    await onAddLocalResources(files, kind);
    focusActiveComposer();
  }

  function switchScene(nextScene: CommandScene) {
    setScene(nextScene);
    setSceneMode("auto");
  }

  function prefillScenario(
    prompt: string,
    nextScene: CommandScene,
    mode: SceneInteractionMode,
  ) {
    switchScene(nextScene);
    setSceneMode(mode);
    onChangeComposerValue(prompt);
    textareaRef.current?.focus();
  }

  function sendComposerValue(submittedValue = composerValue) {
    const trimmed = submittedValue.trim();
    if (isSending || !trimmed) {
      return;
    }
    onChangeComposerValue("");
    const targetProviderAgent = providerAgentResourceForTarget(
      providerResource?.executionAgents ?? [],
      executionTarget,
    );
    const selectedProviderAgentMatches =
      providerResource?.selectedExecutionAgent !== undefined &&
      providerResource.selectedExecutionAgent !== null &&
      providerAgentResourceForTarget(
        [providerResource.selectedExecutionAgent],
        executionTarget,
      ) !== null;
    const shouldCreateNewThread = shouldCreateCommandThread({
      hasProviderAgentTarget: targetProviderAgent !== null,
      isProviderAgentBoundToSelectedThread:
        selectedProviderAgentMatches &&
        providerResource?.snapshot.binding !== null,
      newTaskDraft,
      selectedThread,
    });
    submitCommandComposer({
      cwd: cwd || null,
      images: commandImages.map(({ detail, url }) => ({ detail, url })),
      onSend,
      onSendNewThread,
      settings: commandComposerRuntimeSettings({
        executionTarget,
        model,
        permission,
        scene,
        sceneMode,
        executionIntent,
      }),
      shouldCreateNewThread,
      text: trimmed,
    });
    setCommandImages([]);
    setNewTaskDraft(false);
    setExecutionIntent("none");
  }

  function sendAssistantComposerValue(submittedValue = assistantComposerValue) {
    const trimmed = submittedValue.trim();
    if (isSending || !trimmed || !onSendAssistant) {
      return;
    }
    setAssistantComposerValue("");
    const settings = commandComposerRuntimeSettings({
      executionTarget: "crewon",
      model,
      permission,
      executionIntent: "none",
    });
    const images = assistantImages.map(({ detail, url }) => ({ detail, url }));
    if (images.length) {
      onSendAssistant(trimmed, settings, images);
    } else {
      onSendAssistant(trimmed, settings);
    }
    setAssistantImages([]);
  }

  function openComposerPalette(kind: "add" | "context" | "provider" | "slash") {
    setOpenPalette(kind);
    setPaletteQuery("");
  }

  function toggleComposerPalette(
    kind: "add" | "context" | "provider" | "slash",
  ) {
    if (openPalette === kind) {
      closeComposerPalette();
      return;
    }
    openComposerPalette(kind);
  }

  function closeComposerPalette() {
    setOpenPalette(null);
    setPaletteQuery("");
  }

  useEffect(() => {
    if (!openPalette) {
      return;
    }

    function handleOutsidePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const paletteRoots = Array.from(
        document.querySelectorAll<HTMLElement>("[data-composer-palette]"),
      );
      const triggers = Array.from(
        document.querySelectorAll<HTMLElement>("[data-palette-trigger]"),
      );
      if (shouldCloseComposerPalette({ paletteRoots, target, triggers })) {
        closeComposerPalette();
      }
    }

    document.addEventListener("pointerdown", handleOutsidePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointerDown);
    };
  }, [openPalette]);

  function insertContextItem(item: PaletteItemWithCommand) {
    const currentValue =
      activeView === "assist" ? assistantComposerValue : composerValue;
    const selection = commandComposerResourceSelection(item);
    if (selection) {
      onComposerResourceSelect?.(selection);
      const nextValue = removeComposerMentionToken(
        currentValue,
        `@${item.title}`,
      );
      if (activeView === "assist") {
        setAssistantComposerValue(nextValue);
      } else {
        onChangeComposerValue(nextValue);
      }
      closeComposerPalette();
      focusActiveComposer();
      return;
    }
    const nextValue = insertTokenIntoComposerValue({
      prefix: "@",
      token: item.title,
      value: currentValue,
    });
    if (activeView === "assist") {
      setAssistantComposerValue(nextValue);
    } else {
      onChangeComposerValue(nextValue);
    }
    closeComposerPalette();
    focusActiveComposer();
  }

  function insertSlashItem(item: PaletteItemWithCommand) {
    const currentValue =
      activeView === "assist" ? assistantComposerValue : composerValue;
    if (item.command) {
      onSlashCommandSelect?.(item.command);
      if (item.command.kind !== "app") {
        const nextValue = removeComposerMentionToken(
          currentValue,
          item.command.token,
        );
        if (activeView === "assist") {
          setAssistantComposerValue(nextValue);
        } else {
          onChangeComposerValue(nextValue);
        }
        closeComposerPalette();
        focusActiveComposer();
        return;
      }
    } else {
      const selection = commandComposerResourceSelection(item);
      if (selection) {
        onComposerResourceSelect?.(selection);
        const rawToken = (item.token ?? item.title).trim();
        const token =
          rawToken.startsWith("$") || rawToken.startsWith("/")
            ? rawToken
            : `/${rawToken}`;
        const nextValue = removeComposerMentionToken(currentValue, token);
        if (activeView === "assist") {
          setAssistantComposerValue(nextValue);
        } else {
          onChangeComposerValue(nextValue);
        }
        closeComposerPalette();
        focusActiveComposer();
        return;
      }
    }
    const nextValue = insertTokenIntoComposerValue({
      prefix: "/",
      token: item.command?.token ?? item.token ?? item.title,
      value: currentValue,
    });
    if (activeView === "assist") {
      setAssistantComposerValue(nextValue);
    } else {
      onChangeComposerValue(nextValue);
    }
    closeComposerPalette();
    focusActiveComposer();
  }

  function insertAddItem(item: PaletteItemWithCommand) {
    if (item.action === "toggle-goal") {
      setExecutionIntent((current) => nextExecutionIntent(current, "goal"));
      closeComposerPalette();
      focusActiveComposer();
      return;
    }
    if (item.action === "toggle-plan") {
      setExecutionIntent((current) => nextExecutionIntent(current, "plan"));
      closeComposerPalette();
      focusActiveComposer();
      return;
    }
    if (item.action === "attach-files") {
      closeComposerPalette();
      fileInputRef.current?.click();
      return;
    }
    if (item.action === "attach-folder") {
      closeComposerPalette();
      folderInputRef.current?.click();
      return;
    }
    if (item.action === "provider-resources") {
      openComposerPalette("provider");
      return;
    }
    if (item.kind === "skill" || item.kind === "mcp" || item.command) {
      insertSlashItem(item);
      return;
    }
    insertContextItem(item);
  }

  async function openRuntimeOffice(record: OfficeConfigRecordReference) {
    const key = officeRecordKey(record);
    if (!key || !officeRoomAdapter) {
      return;
    }
    const previousKey = selectedOfficeRecord
      ? officeRecordKey(selectedOfficeRecord)
      : null;
    const requestId = officeOpenRequestRef.current + 1;
    officeOpenRequestRef.current = requestId;
    setSelectedOfficeRecord(record);
    setOfficeRoomId(key);
    setOfficeRoomError(null);
    setOfficeRoomWarning(null);
    if (previousKey === key) {
      return;
    }
    try {
      await officeRoomAdapter.open(record);
    } catch (error) {
      if (officeOpenRequestRef.current === requestId) {
        setOfficeRoomError(
          error instanceof Error ? error.message : "无法打开办公室",
        );
      }
    }
  }

  function closeRuntimeOffice() {
    const closedRecordKey = selectedOfficeRecord
      ? officeRecordKey(selectedOfficeRecord)
      : null;
    officeOpenRequestRef.current += 1;
    setOfficeRoomId(null);
    setOfficeRoomError(null);
    setOfficeRoomWarning(null);
    setSelectedOfficeRecord(null);
    setTeamRefreshNonce((current) => current + 1);
    if (typeof document !== "undefined") {
      window.requestAnimationFrame(() => {
        Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-office-open]"),
        )
          .find((button) => button.dataset.officeRecordKey === closedRecordKey)
          ?.focus();
      });
    }
  }

  function changeTeamWorkspace(nextCwd: string) {
    const normalizedCwd = nextCwd.trim();
    if (!normalizedCwd || normalizedCwd === teamWorkspaceCwd) {
      return;
    }
    officeOpenRequestRef.current += 1;
    setTeamWorkspaceCwd(normalizedCwd);
    persistCommandTeamWorkspaceCwd(normalizedCwd);
    setOfficeRoomId(null);
    setOfficeCreateOpen(false);
    setOfficeCreateError(null);
    setOfficeRoomWarning(null);
    setSelectedOfficeRecord(null);
    setOfficeRoomError(null);
  }

  async function createRuntimeOffice(input: CommandOfficeCreationInput) {
    if (!executionTargetClient || !teamWorkspaceCwd || !officeRoomAdapter) {
      return;
    }
    setOfficeCreateBusy(true);
    setOfficeCreateError(null);
    try {
      const result = await createCommandOffice(
        executionTargetClient,
        teamWorkspaceCwd,
        input,
        locale,
      );
      const recordKey = officeRecordKey(result.record);
      setTeamCatalog((current) => ({
        ...current,
        offices: [
          ...current.offices.filter(
            (record) => officeRecordKey(record) !== recordKey,
          ),
          result.record,
        ],
        officeStatus: "ready",
        status: "ready",
      }));
      setOfficeCreateOpen(false);
      await openRuntimeOffice(result.record);
      setOfficeRoomWarning(
        result.warnings.length > 0 ? result.warnings.join("；") : null,
      );
    } catch (error) {
      setOfficeCreateError(
        error instanceof Error ? error.message : "无法创建办公室",
      );
    } finally {
      setOfficeCreateBusy(false);
    }
  }

  function openExpertTeam(record: ExpertTeamRecordReference) {
    setExecutionTarget(`experts:${record.config.expertsId}`);
    setActiveLinkedThreadId(null);
    setNewTaskDraft(true);
    onChangeComposerValue("");
    switchView("command");
    textareaRef.current?.focus();
  }

  async function createExpertTeam(input: CommandTeamCapabilityCreateInput) {
    if (
      input.kind !== "experts" ||
      !expertWorkspaceKey ||
      !executionTargetClient?.createExpertTeam
    ) {
      return;
    }
    setExpertCreateBusy(true);
    setExpertCreateError(null);
    try {
      const { kind: _kind, ...definition } = input;
      const response = await executionTargetClient.createExpertTeam(
        expertWorkspaceKey,
        definition,
      );
      setExpertTeams((current) => [
        response.record,
        ...current.filter(
          (record) =>
            record.config.expertsId !== response.record.config.expertsId,
        ),
      ]);
      setExpertTeamsStatus("ready");
      setExpertCreateOpen(false);
      openExpertTeam(response.record);
    } catch (error) {
      setExpertCreateError(
        error instanceof Error ? error.message : "无法创建专家团",
      );
    } finally {
      setExpertCreateBusy(false);
    }
  }

  async function createWorkflowDefinition(
    input: CommandTeamCapabilityCreateInput,
  ) {
    if (input.kind !== "workflow") {
      return;
    }
    setWorkflowCreateBusy(true);
    setWorkflowCreateError(null);
    try {
      const workflow = await createAgentPlatformWorkflow({
        description: input.goal,
        lead: input.lead,
        name: input.title,
      });
      setPlatformSnapshot((current) => ({
        ...current,
        workflows: [
          workflow,
          ...current.workflows.filter((item) => item.id !== workflow.id),
        ],
      }));
      setWorkflowCreateOpen(false);
    } catch (error) {
      setWorkflowCreateError(
        error instanceof Error ? error.message : "无法创建协作流",
      );
    } finally {
      setWorkflowCreateBusy(false);
    }
  }

  const currentWorkspace = basename(
    cwd || (locale === "zh" ? "工作空间" : "Workspace"),
  );
  const selectedOfficeRecordKey = selectedOfficeRecord
    ? officeRecordKey(selectedOfficeRecord)
    : null;
  const canCreateOffice = Boolean(
    officeRoomAdapter &&
      executionTargetClient &&
      teamWorkspaceCwd &&
      connectionState === "connected",
  );
  const canCreateExpertTeam = Boolean(
    expertWorkspaceKey &&
      executionTargetClient?.createExpertTeam &&
      connectionState === "connected",
  );
  const officeRuntime = officeRoomAdapter
    ? {
        records: teamCatalog.offices,
        room: selectedOfficeRecord ? (
          officeRoomError ? (
            <div className="team-office-room-error" role="alert">
              {officeRoomError}
            </div>
          ) : (
            <>
              {officeRoomWarning ? (
                <div className="team-office-room-warning" role="status">
                  {officeRoomWarning}
                </div>
              ) : null}
              {officeRoomAdapter.render(
                selectedOfficeRecord,
                closeRuntimeOffice,
                () => {
                  const deletedKey = officeRecordKey(selectedOfficeRecord);
                  setTeamCatalog((current) => ({
                    ...current,
                    offices: current.offices.filter(
                      (record) => officeRecordKey(record) !== deletedKey,
                    ),
                  }));
                  setSelectedOfficeRecord(null);
                  closeRuntimeOffice();
                },
              )}
            </>
          )
        ) : null,
        selectedRecordKey: selectedOfficeRecordKey,
        status: teamCatalog.officeStatus,
        workspaceCwd: teamWorkspaceCwd,
        onCreate: canCreateOffice
          ? () => {
              setOfficeCreateError(null);
              setOfficeCreateOpen(true);
            }
          : undefined,
        onOpen: (record: OfficeConfigRecordReference) => {
          void openRuntimeOffice(record);
        },
        onRetry: () => setTeamRefreshNonce((current) => current + 1),
      }
    : null;
  const showCommandThread =
    activeView === "command" && Boolean(selectedThread) && !newTaskDraft;
  const commandThreadRunning =
    Boolean(activeTurnId) ||
    Boolean(selectedThread?.turns.some((turn) => turn.status === "inProgress"));
  const connectionStatusLabel =
    connectionState === "connected"
      ? locale === "zh"
        ? "App Server 已连接"
        : "App Server connected"
      : connectionState === "connecting"
        ? locale === "zh"
          ? "正在连接 App Server"
          : "Connecting to App Server"
        : connectionState === "demo"
          ? locale === "zh"
            ? "演示模式"
            : "Demo mode"
          : locale === "zh"
            ? "App Server 已断开"
            : "App Server disconnected";
  const composerActivityLabel = isSending
    ? locale === "zh"
      ? "发送中"
      : "Sending"
    : commandThreadRunning && composerValue.trim()
      ? locale === "zh"
        ? "继续补充指令"
        : "Add more instructions"
      : commandThreadRunning
        ? locale === "zh"
          ? "Agent 正在执行，可继续输入补充指令"
          : "Agent is running; you can add more instructions"
        : composerValue.trim()
          ? locale === "zh"
            ? "草稿未发送"
            : "Draft not sent"
          : null;
  const composerSendLabel = commandThreadRunning
    ? locale === "zh"
      ? "发送补充指令"
      : "Send follow-up"
    : locale === "zh"
      ? "发送任务"
      : "Send task";

  return (
    <section
      className="screen-shell command-screen desktop-command-screen"
      data-od-id="desktop-command-screen"
      data-force-new-task={newTaskDraft ? "true" : "false"}
      data-locale={locale}
    >
      <input
        ref={fileInputRef}
        aria-label={locale === "zh" ? "从本地电脑选择文件" : "Choose files"}
        hidden
        multiple
        type="file"
        onChange={(event) => void addLocalResources(event, "files")}
      />
      <input
        ref={folderInputRef}
        aria-label={
          locale === "zh" ? "从本地电脑选择文件夹" : "Choose a folder"
        }
        hidden
        multiple
        type="file"
        onChange={(event) => void addLocalResources(event, "folder")}
      />
      <section
        className={classNames(
          "desktop-window command-window",
          sidebarCollapsed && "sidebar-collapsed",
        )}
        data-od-id="desktop-window"
      >
        <CommandSidebar
          activeView={activeView}
          isSearchOpen={sidebarSearchOpen}
          cwd={cwd}
          linkedThreads={commandLinkedThreads}
          locale={locale}
          query={sidebarSearchQuery}
          selectedLinkedThreadId={activeLinkedThreadId}
          slots={slots}
          onCloseSearch={() => {
            setSidebarSearchOpen(false);
            setSidebarSearchQuery("");
          }}
          onCreateWorkspace={onChangeWorkspaceCwd}
          onNewThread={(workspaceCwd) => {
            setActiveLinkedThreadId(null);
            setNewTaskDraft(true);
            onChangeWorkspaceCwd?.(workspaceCwd);
            onChangeComposerValue("");
            switchView("command");
            textareaRef.current?.focus();
          }}
          onOpenLinkedThread={(threadId) => {
            setActiveLinkedThreadId(threadId);
            setNewTaskDraft(false);
            switchView("command");
            onSelectLinkedThread?.(threadId);
          }}
          onOpenSettings={onOpenSettings}
          onQueryChange={setSidebarSearchQuery}
          onSwitchView={switchView}
          onToggleCollapse={() =>
            setSidebarCollapsed((collapsed) => !collapsed)
          }
          onToggleSearch={() => setSidebarSearchOpen((open) => !open)}
        />

        <section className="command-canvas" data-od-id="desktop-main-pane">
          <section
            className={classNames(
              "shell-view command-home-view",
              activeView === "command" && "active",
              showCommandThread && "has-command-thread",
            )}
            data-shell-view="command"
            data-shell-view-title-zh="新建任务"
            data-shell-view-title-en="New task"
            data-od-id="shell-view-command"
            data-has-thread={showCommandThread ? "true" : "false"}
            hidden={activeView !== "command"}
          >
            <section
              className={classNames(
                "hero-center",
                showCommandThread && "has-command-thread",
              )}
              data-od-id="primary-work-area"
            >
              {showCommandThread && selectedThread ? (
                <CommandThreadRoom
                  activeTurnId={activeTurnId}
                  cwd={cwd}
                  locale={locale}
                  selectedThread={selectedThread}
                  streamingText={streamingText}
                  workMode={workMode}
                  onModeChange={onModeChange}
                  onStop={onStop}
                />
              ) : (
                <>
                  <CommandSceneHeader
                    locale={locale}
                    scene={scene}
                    onQuickAction={(action) =>
                      prefillScenario(action.prompt, scene, action.mode)
                    }
                    onSceneChange={switchScene}
                  />
                </>
              )}

              <CommandComposer
                actions={
                  <>
                    <CommandComposerSelect
                      ariaLabel={locale === "zh" ? "执行主体" : "Run with"}
                      className="execution-target-dropdown"
                      options={executionTargets}
                      value={executionTarget}
                      onChange={selectExecutionTarget}
                    />
                    <CommandComposerSelect
                      ariaLabel={locale === "zh" ? "模型选择" : "Model"}
                      className="model-dropdown"
                      options={effectiveModelOptions}
                      value={model}
                      onChange={(nextModel) => {
                        setModelSelectionTouched(true);
                        setModel(nextModel);
                      }}
                    />
                  </>
                }
                beforeTextarea={
                  <>
                    <ComposerResourceTags
                      resources={[
                        ...pendingComposerResources,
                        ...(providerComposerTag ? [providerComposerTag] : []),
                        ...imageResources(commandImages),
                      ]}
                      onRemove={(resource) => {
                        if (providerComposerTag?.id === resource.id) {
                          if (providerResource?.snapshot.binding) {
                            void providerResource.onUnbind();
                          } else {
                            providerResource?.onSelect(null);
                          }
                          return;
                        }
                        if (resource.kind !== "image") {
                          removePendingResource(resource, "command");
                          return;
                        }
                        setCommandImages((current) =>
                          current.filter((image) => image.id !== resource.id),
                        );
                      }}
                    />
                    <button
                      aria-hidden="true"
                      className="shortcut-proxy"
                      data-context-open=""
                      data-palette-trigger="context"
                      hidden
                      tabIndex={-1}
                      type="button"
                      onClick={() => openComposerPalette("context")}
                    />
                    <button
                      aria-hidden="true"
                      className="shortcut-proxy"
                      data-slash-open=""
                      data-palette-trigger="slash"
                      hidden
                      tabIndex={-1}
                      type="button"
                      onClick={() => openComposerPalette("slash")}
                    />
                  </>
                }
                ariaDescribedBy="composer-status composer-error"
                ariaLabel={locale === "zh" ? "任务输入" : "Task input"}
                className={classNames(
                  "command-input",
                  showCommandThread && "thread-command-input",
                )}
                controls={
                  <>
                    <button
                      aria-label={
                        locale === "zh" ? "添加上下文" : "Add context"
                      }
                      className="icon-action composer-plus-action"
                      data-palette-trigger="add"
                      type="button"
                      onClick={() => toggleComposerPalette("add")}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                    <CommandComposerSelect
                      ariaLabel={locale === "zh" ? "权限选择" : "Permissions"}
                      className="permission-dropdown"
                      icon={<ShieldCheck aria-hidden="true" />}
                      options={localizedPermissionOptions}
                      value={permission}
                      onChange={setPermission}
                    />
                    <SelectedExecutionIntent
                      intent={executionIntent}
                      locale={locale}
                      onClear={() => setExecutionIntent("none")}
                    />
                  </>
                }
                dataOdId="ai-composer"
                disabled={isSending}
                id="desktop-task-input"
                palettes={
                  <>
                    <Palette
                      id="add-search-panel"
                      inputId="add-search"
                      items={visibleAddItems}
                      kind="add"
                      open={openPalette === "add"}
                      placeholder={locale === "zh" ? "添加" : "Add"}
                      query={paletteQuery}
                      onClose={closeComposerPalette}
                      onQueryChange={setPaletteQuery}
                      onSelect={insertAddItem}
                    />
                    <Palette
                      id="context-search-panel"
                      inputId="context-search"
                      items={visibleContextItems}
                      kind="context"
                      open={openPalette === "context"}
                      placeholder={
                        locale === "zh"
                          ? "搜索文件、会话或工作空间"
                          : "Search files, conversations, or workspaces"
                      }
                      query={paletteQuery}
                      onClose={closeComposerPalette}
                      onQueryChange={setPaletteQuery}
                      onSelect={insertContextItem}
                    />
                    <Palette
                      id="slash-search-panel"
                      inputId="slash-search"
                      items={visibleSlashItems}
                      kind="slash"
                      open={openPalette === "slash"}
                      placeholder={
                        locale === "zh"
                          ? "搜索 Skill 或 MCP，例如 页面审阅、Filesystem"
                          : "Search Skills or MCP, for example page review or Filesystem"
                      }
                      query={paletteQuery}
                      onClose={closeComposerPalette}
                      onQueryChange={setPaletteQuery}
                      onSelect={insertSlashItem}
                    />
                    {providerResourceAvailable && providerResource ? (
                      <ProviderResourceComposerPopover
                        open={openPalette === "provider"}
                        selectedResource={providerResource.selectedResource}
                        selectedWorkspaceKey={
                          providerResource.selectedWorkspaceKey
                        }
                        snapshot={providerResource.snapshot}
                        onBind={(resource) => {
                          providerResource.onSelect(resource);
                          closeComposerPalette();
                        }}
                        onRetry={providerResource.onRefresh}
                        onSelect={providerResource.onSelect}
                        onUnbind={() => void providerResource.onUnbind()}
                        onWorkspaceSelect={providerResource.onWorkspaceSelect}
                      />
                    ) : null}
                  </>
                }
                paletteOpen={Boolean(openPalette)}
                placeholder={scenePreset.placeholder}
                sendLabel={
                  showCommandThread
                    ? composerSendLabel
                    : locale === "zh"
                      ? "开始任务"
                      : "Start task"
                }
                state={
                  <>
                    {showCommandThread ? (
                      <span
                        className="workspace-label"
                        data-od-id="workspace-picker"
                      >
                        {currentWorkspace}
                      </span>
                    ) : (
                      <CommandComposerSelect
                        ariaLabel={
                          locale === "zh" ? "工作空间选择" : "Workspace"
                        }
                        className="workspace-dropdown"
                        options={workspaceOptions}
                        value={cwd || noWorkspaceValue}
                        onChange={(nextWorkspace) =>
                          onChangeWorkspaceCwd?.(
                            nextWorkspace === noWorkspaceValue
                              ? null
                              : nextWorkspace,
                          )
                        }
                      />
                    )}
                    {composerActivityLabel ? (
                      <span className="composer-state">
                        {composerActivityLabel}
                      </span>
                    ) : null}
                    {connectionState === "disconnected" ? (
                      <button
                        className="button compact"
                        type="button"
                        onClick={onRetryConnection}
                      >
                        {locale === "zh"
                          ? "重试 app-server"
                          : "Retry app-server"}
                      </button>
                    ) : null}
                    <span
                      aria-label={connectionStatusLabel}
                      className="connection-indicator"
                      data-state={connectionState}
                      role="status"
                      title={connectionStatusLabel}
                    />
                  </>
                }
                running={commandThreadRunning}
                stateDataOdId="composer-state-row"
                stateId="composer-status"
                stopLabel={locale === "zh" ? "停止" : "Stop"}
                submitBehavior="enter"
                submitting={isSending}
                textareaDataOdId="composer-input"
                textareaRef={textareaRef}
                value={composerValue}
                onChange={onChangeComposerValue}
                onClosePalette={closeComposerPalette}
                onOpenPalette={openComposerPalette}
                onPaste={(event) => void pasteImages(event, "command")}
                onStop={onStop}
                onSubmit={sendComposerValue}
              />
            </section>
          </section>

          <CommandWorkspaceAssistant
            active={activeView === "assist"}
            activeTurnId={assistantActiveTurnId}
            composer={
              <CommandComposer
                actions={
                  <CommandComposerSelect
                    ariaLabel={locale === "zh" ? "模型选择" : "Model"}
                    className="model-dropdown"
                    options={effectiveModelOptions}
                    value={model}
                    onChange={(nextModel) => {
                      setModelSelectionTouched(true);
                      setModel(nextModel);
                    }}
                  />
                }
                beforeTextarea={
                  <>
                    <ComposerResourceTags
                      resources={[
                        ...pendingComposerResources,
                        ...(providerComposerTag ? [providerComposerTag] : []),
                        ...imageResources(assistantImages),
                      ]}
                      onRemove={(resource) => {
                        if (providerComposerTag?.id === resource.id) {
                          if (providerResource?.snapshot.binding) {
                            void providerResource.onUnbind();
                          } else {
                            providerResource?.onSelect(null);
                          }
                          return;
                        }
                        if (resource.kind !== "image") {
                          removePendingResource(resource, "assistant");
                          return;
                        }
                        setAssistantImages((current) =>
                          current.filter((image) => image.id !== resource.id),
                        );
                      }}
                    />
                    <button
                      aria-hidden="true"
                      className="shortcut-proxy"
                      data-context-open=""
                      data-palette-trigger="context"
                      hidden
                      tabIndex={-1}
                      type="button"
                      onClick={() => openComposerPalette("context")}
                    />
                    <button
                      aria-hidden="true"
                      className="shortcut-proxy"
                      data-slash-open=""
                      data-palette-trigger="slash"
                      hidden
                      tabIndex={-1}
                      type="button"
                      onClick={() => openComposerPalette("slash")}
                    />
                  </>
                }
                ariaDescribedBy="assistant-composer-status"
                ariaLabel={locale === "zh" ? "助理输入" : "Assistant input"}
                className="command-input thread-command-input assistant-home-composer"
                controls={
                  <>
                    <button
                      aria-label={
                        locale === "zh"
                          ? "添加附件或能力"
                          : "Add attachments or capabilities"
                      }
                      className="icon-action composer-plus-action"
                      data-palette-trigger="add"
                      type="button"
                      onClick={() => toggleComposerPalette("add")}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                    <CommandComposerSelect
                      ariaLabel={locale === "zh" ? "权限选择" : "Permissions"}
                      className="permission-dropdown"
                      icon={<ShieldCheck aria-hidden="true" />}
                      options={localizedPermissionOptions}
                      value={permission}
                      onChange={setPermission}
                    />
                  </>
                }
                dataOdId="assistant-composer"
                disabled={isSending}
                id="assistant-task-input"
                palettes={
                  <>
                    <Palette
                      id="assistant-add-search-panel"
                      inputId="assistant-add-search"
                      items={visibleAddItems}
                      kind="add"
                      open={openPalette === "add"}
                      placeholder={
                        locale === "zh"
                          ? "添加附件、知识库、Skill 或 MCP"
                          : "Add attachments, knowledge, Skills, or MCP"
                      }
                      query={paletteQuery}
                      onClose={closeComposerPalette}
                      onQueryChange={setPaletteQuery}
                      onSelect={insertAddItem}
                    />
                    <Palette
                      id="assistant-context-search-panel"
                      inputId="assistant-context-search"
                      items={visibleContextItems}
                      kind="context"
                      open={openPalette === "context"}
                      placeholder={
                        locale === "zh"
                          ? "搜索可引用的上下文"
                          : "Search available context"
                      }
                      query={paletteQuery}
                      onClose={closeComposerPalette}
                      onQueryChange={setPaletteQuery}
                      onSelect={insertContextItem}
                    />
                    <Palette
                      id="assistant-slash-search-panel"
                      inputId="assistant-slash-search"
                      items={visibleSlashItems}
                      kind="slash"
                      open={openPalette === "slash"}
                      placeholder={
                        locale === "zh"
                          ? "搜索 Skill 或 MCP"
                          : "Search Skills or MCP"
                      }
                      query={paletteQuery}
                      onClose={closeComposerPalette}
                      onQueryChange={setPaletteQuery}
                      onSelect={insertSlashItem}
                    />
                    {providerResourceAvailable && providerResource ? (
                      <ProviderResourceComposerPopover
                        open={openPalette === "provider"}
                        selectedResource={providerResource.selectedResource}
                        selectedWorkspaceKey={
                          providerResource.selectedWorkspaceKey
                        }
                        snapshot={providerResource.snapshot}
                        onBind={(resource) => {
                          providerResource.onSelect(resource);
                          closeComposerPalette();
                        }}
                        onRetry={providerResource.onRefresh}
                        onSelect={providerResource.onSelect}
                        onUnbind={() => void providerResource.onUnbind()}
                        onWorkspaceSelect={providerResource.onWorkspaceSelect}
                      />
                    ) : null}
                  </>
                }
                paletteOpen={Boolean(openPalette)}
                placeholder={
                  locale === "zh"
                    ? "告诉助理你想了解、整理或持续跟进的事情…"
                    : "Tell the assistant what you want to understand, organize, or keep track of…"
                }
                running={Boolean(assistantActiveTurnId)}
                sendLabel={
                  assistantActiveTurnId
                    ? locale === "zh"
                      ? "发送补充指令"
                      : "Send follow-up"
                    : locale === "zh"
                      ? "发送"
                      : "Send"
                }
                state={
                  <>
                    <span
                      className="composer-state"
                      id="assistant-composer-status"
                    >
                      {locale === "zh"
                        ? "单一会话 · 默认执行环境 · 上下文自动压缩"
                        : "Single conversation · default environment · automatic context compaction"}
                    </span>
                    <span
                      aria-label={connectionStatusLabel}
                      className="connection-indicator"
                      data-state={connectionState}
                      role="status"
                      title={connectionStatusLabel}
                    />
                  </>
                }
                stopLabel={locale === "zh" ? "停止" : "Stop"}
                submitBehavior="enter"
                submitting={isSending}
                textareaDataOdId="assistant-composer-input"
                textareaRef={assistantTextareaRef}
                value={assistantComposerValue}
                onChange={setAssistantComposerValue}
                onClosePalette={closeComposerPalette}
                onOpenPalette={openComposerPalette}
                onPaste={(event) => void pasteImages(event, "assistant")}
                onStop={onStop}
                onSubmit={sendAssistantComposerValue}
              />
            }
            locale={locale}
            streamingText={assistantStreamingText}
            thread={assistantThread}
            workMode={workMode}
            clearAvailable={connectionState === "connected"}
            onClearThread={onClearAssistantThread}
            onModeChange={onModeChange}
            onStop={onStop}
          />
          <ProjectsView
            active={activeView === "projects"}
            resourceStatus={resourceStatus}
          />
          <AgentsView
            active={activeView === "agents"}
            catalogFilter={catalogFilter}
            catalogSearch={catalogSearch}
            platformState={platformState}
            resourceStates={platformResourceStates}
            snapshot={platformSnapshot}
            onReload={reloadPlatformResources}
            onCatalogFilterChange={setCatalogFilter}
            onCatalogSearchChange={setCatalogSearch}
            onSaveCapability={onSaveCapability}
          />
          <KnowledgeCatalogView
            active={activeView === "knowledge"}
            platformState={platformState}
            resourceStates={platformResourceStates}
            snapshot={platformSnapshot}
            onReload={reloadPlatformResources}
          />
          <ScheduleView
            active={activeView === "schedule"}
            client={scheduleClient}
            cwd={cwd}
            modalOpen={scheduleModalOpen}
            scheduleMode={scheduleMode}
            scheduleSource={scheduleSource}
            onCloseModal={() => setScheduleModalOpen(false)}
            onModeChange={setScheduleMode}
            onOpenModal={() => setScheduleModalOpen(true)}
            onSourceChange={setScheduleSource}
            onOpenThread={onSelectLinkedThread}
          />
          <TeamView
            active={activeView === "team"}
            officeRuntime={officeRuntime}
            officeRoomId={officeRoomId}
            singleChatWorkspaceCwd={cwd}
            teamMode={teamMode}
            teamWorkspaceCwd={teamWorkspaceCwd}
            teamWorkspaceOptions={teamWorkspaceOptions}
            workflows={platformSnapshot.workflows}
            expertTeams={expertTeams}
            expertTeamsStatus={expertTeamsStatus}
            onCreateOffice={
              canCreateOffice
                ? () => {
                    setOfficeCreateError(null);
                    setOfficeCreateOpen(true);
                  }
                : undefined
            }
            onCreateWorkflow={
              platformState === "ready"
                ? () => {
                    setWorkflowCreateError(null);
                    setWorkflowCreateOpen(true);
                  }
                : undefined
            }
            onRefresh={() => setTeamRefreshNonce((current) => current + 1)}
            onCreateExpertTeam={
              canCreateExpertTeam
                ? () => {
                    setExpertCreateError(null);
                    setExpertCreateOpen(true);
                  }
                : undefined
            }
            onReloadWorkflows={reloadPlatformResources}
            onRunWorkflow={async (workflow, input) => {
              const accessToken = await getAgentPlatformAccessToken();
              if (!accessToken) {
                throw new Error("Agent Platform 登录已失效，请重新登录");
              }
              if (!executionTargetClient?.executeAgentPlatformWorkflow) {
                throw new Error("App Server 尚未提供协作流执行能力");
              }
              const execution =
                await executionTargetClient.executeAgentPlatformWorkflow(
                  accessToken,
                  String(workflow.id),
                  input,
                );
              return {
                id: execution.executionId,
                workflow_id: execution.workflowId,
                status: execution.status,
                output_data: execution.outputs as
                  | Record<string, unknown>
                  | string
                  | null,
                executed_nodes: execution.executedNodes,
                node_results: execution.nodeResults as Record<string, unknown>,
                error_message: execution.error,
              };
            }}
            onSelectExpert={openExpertTeam}
            onTeamWorkspaceChange={changeTeamWorkspace}
            onTeamModeChange={(mode) => {
              setTeamMode(mode);
              setOfficeRoomId(null);
              setOfficeRoomError(null);
              setOfficeRoomWarning(null);
            }}
          />
          {officeCreateOpen ? (
            <CommandOfficeCreateDialog
              agents={teamCatalog.agents}
              busy={officeCreateBusy}
              error={officeCreateError}
              locale={locale}
              onClose={() => {
                if (!officeCreateBusy) {
                  setOfficeCreateOpen(false);
                  setOfficeCreateError(null);
                }
              }}
              onSubmit={createRuntimeOffice}
            />
          ) : null}
          {expertCreateOpen ? (
            <CommandTeamCapabilityCreateDialog
              kind="experts"
              busy={expertCreateBusy}
              error={expertCreateError}
              workspaceCwd={cwd}
              onClose={() => {
                if (!expertCreateBusy) {
                  setExpertCreateOpen(false);
                  setExpertCreateError(null);
                }
              }}
              onSubmit={(input) => void createExpertTeam(input)}
            />
          ) : null}
          {workflowCreateOpen ? (
            <CommandTeamCapabilityCreateDialog
              kind="workflow"
              busy={workflowCreateBusy}
              error={workflowCreateError}
              workspaceCwd=""
              onClose={() => {
                if (!workflowCreateBusy) {
                  setWorkflowCreateOpen(false);
                  setWorkflowCreateError(null);
                }
              }}
              onSubmit={(input) => void createWorkflowDefinition(input)}
            />
          ) : null}
        </section>
      </section>
    </section>
  );
}
