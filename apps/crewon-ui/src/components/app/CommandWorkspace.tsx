import { ListChecks, Plus, Target } from "lucide-react";
import type { ControlApiClient } from "@crewon/control-client";
import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";
import {
  type ChangeEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CommandOfficeCreateDialog,
  type CommandOfficeCreationInput,
} from "./CommandOfficeCreateDialog";
import { useCommandOfficeCatalogAutoReconnect } from "./commandOfficeCatalogReconnect";
import {
  CommandSidebar,
  Palette,
  type CommandLinkedThread,
  type PaletteItemWithCommand,
} from "./CommandWorkspaceChrome";
import { CommandWorkspaceAssistant } from "./CommandWorkspaceAssistant";
import { CommandThreadRoom } from "./CommandWorkspaceConversation";
import { AppWorkspaceLibraryContent } from "./AppWorkspaceLibraryContent";
import {
  CommandWorkspaceOperationsPanel,
  type CommandWorkspaceOperationsPanelProps,
} from "./CommandWorkspaceOperationsPanel";
import { CommandSceneHeader, CommandSceneQuickRow } from "./CommandSceneHeader";
import {
  CommandHomeCapabilityStrip,
  commandSceneMayWrite,
  type CommandHomeResource,
} from "./CommandHomeCapabilityStrip";
import { TeamView } from "./CommandWorkspaceViews";
import { CommandProjectBoardView } from "./CommandTaskBoard";
import { CommandControlScheduleView } from "./CommandControlScheduleView";
import {
  commandLibraryKindForView,
  commandShellViewFromHash,
  installCommandShellHashRouting,
  openControlLibraryFromCommandShell,
} from "./commandWorkspaceHashRouting";
import { classNames } from "./commandWorkspaceUtils";

type ThreadGoalStatus = ThreadGoalView["status"];
import {
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
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { ControlKnowledgeSelection } from "../../lib/control-runtime/controlComposerResourceDiscovery";
import type { Locale } from "../../lib/i18n";
import type { ControlWorkflowAdapter } from "../../lib/workflow/controlWorkflowAdapter";
import type { ConnectionState } from "../../lib/shared/connectionState";
import type { ComposerImageInput } from "../../lib/shared/composerImages";
import {
  removeComposerMentionToken,
  type PendingComposerMention,
} from "../../lib/shared/composerMentions";
import type { LocalResourceSelectionKind } from "../../lib/shared/localResourceAttachments";
import { formatRelativeTime } from "../../lib/shared/text";
import {
  executionTargetGroups,
  executionTargetOptionsFromDomain,
  type ExecutionTargetOption,
  scenePresets,
  scenePresetsEn,
  type CommandScene,
  type SceneInteractionMode,
} from "../../lib/scene/sceneCatalog";
import type { AgentConfig } from "../../lib/domain/domainTypes";
import {
  isControlOfficeDefinitionRecord,
  officeRecordKey,
  type OfficeConfigRecordReference,
  type OfficeRuntimeRecordReference,
} from "../../lib/office/officePanelFromRecord";
import {
  commandComposerRuntimeSettings,
  fallbackCommandModelOptions,
  type CommandExecutionIntent,
  type CommandModelOption,
  type ThreadRuntimeSettings,
} from "../../lib/thread/threadRuntimeSettings";
import {
  commandModelEffortLabel,
  commandReasoningEffortOptions,
  resolveReasoningEffort,
} from "../../lib/thread/threadReasoningEffort";
import {
  hasThreadProgress,
  threadProgressSummary,
} from "../../lib/thread/threadProgressSummary";
import type { WorkMode } from "../../lib/workMode";
import { sidebarThreadTitle } from "../SidebarPresentation";
import { DesktopWindowDragRegion } from "../TitleBarWindowControls";
import {
  CommandComposer,
  CommandComposerSelect,
  type CommandComposerSelectOption,
} from "../composer/CommandComposer";
import {
  ComposerResourceTags,
  type ComposerResourceTag,
} from "../composer/ComposerResourceTags";
import { ComposerGoalBar } from "../composer/ComposerGoalBar";
import {
  composerGoalBarState,
  goalPauseToggleStatus,
} from "../composer/composerGoalBarState";
import { ComposerProgressPill } from "../composer/ComposerProgressPill";
import {
  effortFromOptionValue,
  effortOptionValue,
  modelEffortGroups,
  modelEffortMenuOptions,
} from "../composer/composerModelEffortMenu";
import {
  ProviderResourceComposerPopover,
  providerResourceComposerTag,
} from "../provider-resource/ProviderResourcePicker";
import type { ProviderResourceSnapshot } from "../../lib/provider-resource/providerResourceSession";
import {
  providerAgentExecutionTargetOptions,
  providerAgentResourceForTarget,
} from "../../lib/provider-resource/providerAgentExecutionTargets";
import type { ResourceRef } from "@crewon-platform-model/v2/ResourceRef";
import type {
  LibraryItem,
  LibraryKind,
  LibraryPanel,
} from "../../lib/domain/crewonDomain";
import type { LibraryPanelActionCallback } from "../library/LibraryPrimitives";

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
export { commandLibraryKindForView } from "./commandWorkspaceHashRouting";
export { composerKeyIntent as commandComposerKeyIntent } from "../composer/ComposerCore";
export type {
  ComposerKeyIntent as CommandComposerKeyIntent,
  ComposerKeyIntentInput as CommandComposerKeyIntentInput,
} from "../composer/ComposerCore";

export type CommandWorkspaceOperationsSlot = Omit<
  CommandWorkspaceOperationsPanelProps,
  "locale"
>;

type CommandWorkspaceProps = {
  activeTurnId?: string | null;
  assistantActiveTurnId?: string | null;
  assistantStreamingText?: string;
  assistantThread?: Thread | null;
  composerValue: string;
  connectionState: ConnectionState;
  controlExecutionCatalog?: Readonly<{
    modelOptionsByTarget: Readonly<Record<string, CommandModelOption[]>>;
    targets: ExecutionTargetOption[];
  }> | null;
  controlWorkflowAdapter?: ControlWorkflowAdapter | null;
  automationClient?: Pick<ControlApiClient, "listThreadRuns"> | null;
  workspaceOperations?: CommandWorkspaceOperationsSlot | null;
  isSending: boolean;
  linkedThreads?: Thread[];
  knowledgeSelections?: readonly ControlKnowledgeSelection[];
  libraryPanel?: LibraryPanel | null;
  locale?: Locale;
  modelOptions?: CommandModelOption[];
  officeRoomAdapter?: CommandOfficeRoomAdapter | null;
  pendingComposerMentions?: PendingComposerMention[];
  selectedThread?: Thread | null;
  selectedThreadId?: string | null;
  slashCommands?: ComposerSlashCommand[];
  streamingText?: string;
  /**
   * Goal steering the selected thread, when the backend reports one. The
   * composer renders it as an editable bar above the input.
   */
  threadGoal?: ThreadGoalView | null;
  threadGoalBusy?: boolean;
  committedExecutionIntent?: {
    intent: Exclude<CommandExecutionIntent, "none">;
    sequence: number;
  } | null;
  workMode: WorkMode;
  onAddLocalResources?: (
    files: File[],
    kind: LocalResourceSelectionKind,
  ) => void | Promise<void>;
  onChangeComposerValue: (value: string) => void;
  onComposerResourceSelect?: (
    selection: CommandComposerResourceSelection,
  ) => void;
  onClearAssistantThread?: () => void | Promise<void>;
  onModeChange: (mode: WorkMode) => void;
  onKnowledgeSelect?: (selection: ControlKnowledgeSelection) => void;
  onLibraryItemAction?: (item: LibraryItem) => void;
  onLibraryPanelAction?: LibraryPanelActionCallback;
  onLibraryPanelFieldChange?: (fieldId: string, value: string) => void;
  onOpenLibrary?: (kind: LibraryKind) => void | Promise<void>;
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
    images?: ComposerImageInput[],
  ) => void;
  onSelectLinkedThread?: (threadId: string | null) => void;
  onSlashCommandSelect?: (command: ComposerSlashCommand) => void;
  onStop?: () => void;
  onClearThreadGoal?: (threadId: string) => void;
  onSetThreadGoalObjective?: (threadId: string, objective: string) => void;
  onSetThreadGoalStatus?: (threadId: string, status: ThreadGoalStatus) => void;
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

export function commandKnowledgeSelection(
  item: PaletteItemWithCommand,
  selections: readonly ControlKnowledgeSelection[],
): ControlKnowledgeSelection | null {
  if (item.kind !== "knowledge" || item.knowledgeReference === undefined) {
    return null;
  }
  const matches = selections.filter(
    (selection) =>
      selection.reference.knowledgeId ===
        item.knowledgeReference?.knowledgeId &&
      selection.reference.contentDigest ===
        item.knowledgeReference?.contentDigest,
  );
  return matches.length === 1 ? matches[0] : null;
}

export function submitCommandComposer({
  onSend,
  onSendNewThread,
  settings,
  shouldCreateNewThread,
  text,
  images,
}: {
  onSend: CommandWorkspaceProps["onSend"];
  onSendNewThread: CommandWorkspaceProps["onSendNewThread"];
  settings: ThreadRuntimeSettings;
  shouldCreateNewThread: boolean;
  text: string;
  images?: ComposerImageInput[];
}): void {
  if (shouldCreateNewThread && onSendNewThread) {
    if (images?.length) {
      onSendNewThread(text, settings, images);
    } else {
      onSendNewThread(text, settings);
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
  create: (
    input: CommandOfficeCreationInput,
  ) => Promise<OfficeConfigRecordReference>;
  listCatalog: () => Promise<CommandDomainCatalog>;
  open: (record: OfficeConfigRecordReference) => void | Promise<void>;
  render: (
    record: OfficeConfigRecordReference,
    onBack: () => void,
    onDeleted: () => void,
  ) => ReactNode;
};

type TeamMode = "office" | "workflow" | "experts";
type CommandDomainCatalog = {
  agents: Array<{ config: AgentConfig; filePath: string }>;
  officeStatus: "loading" | "ready" | "unavailable";
  offices: OfficeConfigRecordReference[];
  status: "loading" | "ready" | "unavailable";
};
const noWorkspaceValue = "__no_workspace__";

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

export function executionIntentAfterCommit(
  current: CommandExecutionIntent,
  committed: Exclude<CommandExecutionIntent, "none">,
): CommandExecutionIntent {
  return current === committed ? "none" : current;
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
  automationClient = null,
  controlExecutionCatalog,
  controlWorkflowAdapter = null,
  workspaceOperations = null,
  isSending,
  knowledgeSelections = [],
  libraryPanel = null,
  linkedThreads = [],
  locale = "zh",
  modelOptions = fallbackCommandModelOptions,
  officeRoomAdapter = null,
  pendingComposerMentions = [],
  selectedThread = null,
  selectedThreadId = null,
  slashCommands = [],
  streamingText = "",
  threadGoal = null,
  threadGoalBusy = false,
  committedExecutionIntent = null,
  workMode,
  onAddLocalResources,
  onChangeComposerValue,
  onComposerResourceSelect,
  onClearAssistantThread,
  onModeChange,
  onKnowledgeSelect,
  onLibraryItemAction,
  onLibraryPanelAction,
  onLibraryPanelFieldChange,
  onOpenLibrary,
  onOpenSettings,
  onRemoveComposerMention,
  onRetryConnection,
  onSend,
  onSendAssistant,
  onSendNewThread,
  onSelectLinkedThread,
  onSlashCommandSelect,
  onStop,
  onClearThreadGoal,
  onSetThreadGoalObjective,
  onSetThreadGoalStatus,
  providerResource,
}: CommandWorkspaceProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const assistantTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const lastCommandThreadIdRef = useRef<string | null>(selectedThreadId);
  const [activeView, setActiveView] = useState<CommandShellView>(() =>
    typeof window === "undefined"
      ? "command"
      : commandShellViewFromHash(window.location.hash),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [activeLinkedThreadId, setActiveLinkedThreadId] = useState<
    string | null
  >(selectedThreadId);
  const [newTaskDraft, setNewTaskDraft] = useState(false);
  const [assistantComposerValue, setAssistantComposerValue] = useState("");
  const [scene, setScene] = useState<CommandScene>("office");
  const [sceneMode, setSceneMode] = useState<SceneInteractionMode>("auto");
  const [model, setModel] = useState(fallbackCommandModelOptions[0].value);
  const [modelSelectionTouched, setModelSelectionTouched] = useState(false);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<
    string | null
  >(null);
  const [executionTarget, setExecutionTarget] = useState("crewon");
  const [cloudAgentTargetError, setCloudAgentTargetError] = useState<
    string | null
  >(null);
  const [executionTargetCatalog, setExecutionTargetCatalog] =
    useState<CommandDomainCatalog>({
      agents: [],
      offices: [],
      officeStatus: "loading",
      status: "loading",
    });
  const [executionIntent, setExecutionIntent] =
    useState<CommandExecutionIntent>("none");

  useEffect(() => {
    if (committedExecutionIntent !== null) {
      setExecutionIntent((current) =>
        executionIntentAfterCommit(current, committedExecutionIntent.intent),
      );
    }
  }, [committedExecutionIntent]);
  const [openPalette, setOpenPalette] = useState<
    "add" | "context" | "provider" | "slash" | null
  >(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const platformSnapshot = emptyAgentPlatformSnapshot;
  const [teamMode, setTeamMode] = useState<TeamMode>("office");
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
    return installCommandShellHashRouting(window, setActiveView, onOpenLibrary);
  }, [onOpenLibrary]);

  useEffect(() => {
    let cancelled = false;
    if (!officeRoomAdapter || connectionState !== "connected") {
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
    void officeRoomAdapter.listCatalog().then(
      (catalog) => !cancelled && setExecutionTargetCatalog(catalog),
      () =>
        !cancelled &&
        setExecutionTargetCatalog({
          agents: [],
          offices: [],
          officeStatus: "unavailable",
          status: "unavailable",
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [connectionState, officeRoomAdapter]);

  useEffect(() => {
    let cancelled = false;
    if (!officeRoomAdapter || connectionState !== "connected") {
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
    void officeRoomAdapter.listCatalog().then(
      (catalog) => !cancelled && setTeamCatalog(catalog),
      () =>
        !cancelled &&
        setTeamCatalog({
          agents: [],
          offices: [],
          officeStatus: "unavailable",
          status: "unavailable",
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [connectionState, officeRoomAdapter, teamRefreshNonce]);

  useCommandOfficeCatalogAutoReconnect({
    active: activeView === "team" && teamMode === "office",
    connectionState,
    refreshNonce: setTeamRefreshNonce,
    status: teamCatalog.officeStatus,
    workspaceCwd: workspaceOperations?.nativeWorkspaceDisplayName ?? "",
  });

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

  const selectedControlModelOptions =
    controlExecutionCatalog?.modelOptionsByTarget[executionTarget];
  const effectiveModelOptions = controlExecutionCatalog
    ? (selectedControlModelOptions ?? [])
    : modelOptions.length > 0
      ? modelOptions
      : fallbackCommandModelOptions;

  useEffect(() => {
    const defaultModel = effectiveModelOptions.find(
      (option) => option.isDefault,
    )?.value;
    if (!effectiveModelOptions.some((option) => option.value === model)) {
      setModel(
        defaultModel ??
          effectiveModelOptions[0]?.value ??
          (controlExecutionCatalog ? "" : fallbackCommandModelOptions[0].value),
      );
      return;
    }
    if (!modelSelectionTouched && defaultModel && model !== defaultModel) {
      setModel(defaultModel);
    }
  }, [
    controlExecutionCatalog,
    effectiveModelOptions,
    model,
    modelSelectionTouched,
  ]);

  // Derived rather than synced through an effect: an unsupported effort after a
  // model swap resolves to that model's catalog default on the same render, so
  // the trigger label is never briefly wrong.
  const effectiveReasoningEffort = resolveReasoningEffort(
    effectiveModelOptions,
    model,
    selectedReasoningEffort,
  );

  const slots = useMemo(
    () => selectCommandHomeSlots(platformSnapshot),
    [platformSnapshot],
  );
  const contextPaletteItems = useMemo(
    () => [
      ...commandSceneContextItems(scene, emptyAgentPlatformSnapshot, ""),
      ...(onKnowledgeSelect ? knowledgeSelections : []).map((selection) => ({
        detail: selection.sourceId,
        kind: "knowledge" as const,
        knowledgeReference: selection.reference,
        label: locale === "zh" ? "知识库" : "Knowledge",
        title: selection.title,
      })),
    ],
    [knowledgeSelections, locale, onKnowledgeSelect, scene],
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
  const providerExecutionTargetsAvailable = Boolean(
    providerResource && (providerResource.executionAgents?.length ?? 0) > 0,
  );
  const addPaletteItems = useMemo<PaletteItemWithCommand[]>(
    () => [
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
              detail: "通过资源 authority 添加可执行的云端 MCP Tool 或知识库",
              kind: "knowledge" as const,
              label: "云端资源",
              title: "选择云端资源",
            },
          ]
        : []),
      ...contextPaletteItems.filter((item) => item.kind === "knowledge"),
      ...slashPaletteItems.filter(
        (item) =>
          item.kind === "skill" || item.kind === "mcp" || item.kind === "tool",
      ),
    ],
    [contextPaletteItems, providerResourceAvailable, slashPaletteItems],
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
    if (controlExecutionCatalog) {
      return controlExecutionCatalog.targets;
    }
    const domainTargets = executionTargetOptionsFromDomain({
      ...executionTargetCatalog,
      locale,
      offices: executionTargetCatalog.offices.filter(
        (record): record is OfficeRuntimeRecordReference =>
          !isControlOfficeDefinitionRecord(record),
      ),
    });
    const providerTargets = providerExecutionTargetsAvailable
      ? providerAgentExecutionTargetOptions(
          providerResource?.executionAgents ?? [],
        )
      : [];
    return [...domainTargets, ...providerTargets];
  }, [
    controlExecutionCatalog,
    executionTargetCatalog,
    locale,
    providerResource?.executionAgents,
    providerExecutionTargetsAvailable,
  ]);
  const localizedScenePresets = locale === "zh" ? scenePresets : scenePresetsEn;
  const scenePreset = localizedScenePresets[scene];
  const homeResourceEntries = [
    ...contextPaletteItems.filter((item) => item.kind === "knowledge"),
    ...slashPaletteItems.filter(
      (item) =>
        item.kind === "skill" || item.kind === "mcp" || item.kind === "tool",
    ),
  ]
    .slice(0, 4)
    .map((item, index) => ({
      item,
      resource: {
        id: `${item.kind}:${"token" in item ? (item.token ?? item.title) : item.title}:${index}`,
        kind: item.kind as CommandHomeResource["kind"],
        label: item.label,
        title: item.title,
      } satisfies CommandHomeResource,
    }));
  const workspaceOptions = useMemo<CommandComposerSelectOption[]>(() => {
    const displayName = workspaceOperations?.nativeWorkspaceDisplayName;
    return [
      {
        detail:
          locale === "zh"
            ? "使用默认执行环境，不向新任务显式绑定目录"
            : "Use the default execution environment without explicitly binding a directory",
        label: locale === "zh" ? "无工作空间" : "No workspace",
        value: noWorkspaceValue,
      },
      ...(displayName
        ? [
            {
              detail:
                locale === "zh"
                  ? "由桌面端安全 authority 管理"
                  : "Managed by the desktop authority",
              label: displayName,
              value: "__native_workspace__",
            },
          ]
        : []),
      {
        detail:
          locale === "zh"
            ? "打开桌面文件夹选择器；路径只交给 native authority"
            : "Open the desktop folder picker; only the native authority receives the path",
        label:
          locale === "zh"
            ? displayName
              ? "更换工作空间…"
              : "选择工作空间…"
            : displayName
              ? "Replace Workspace…"
              : "Select Workspace…",
        value: "__select_native_workspace__",
      },
    ];
  }, [locale, workspaceOperations?.nativeWorkspaceDisplayName]);
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

  async function selectExecutionTarget(nextTarget: string) {
    setCloudAgentTargetError(null);
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
        cwd: thread.cwd,
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
  function switchView(view: CommandShellView) {
    setOpenPalette(null);
    setPaletteQuery("");
    const libraryKind = commandLibraryKindForView(view);
    if (libraryKind !== null) {
      openControlLibraryFromCommandShell(
        window,
        setActiveView,
        libraryKind,
        onOpenLibrary,
      );
      return;
    }
    setActiveView(view);
    if (typeof window !== "undefined") {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#view-${view}`,
      );
    }
  }

  function renderControlLibraryView(
    view: Extract<CommandShellView, "agents" | "knowledge" | "schedule">,
  ) {
    const expectedKind = commandLibraryKindForView(view);
    const panelReady =
      expectedKind !== null &&
      (libraryPanel?.kind === expectedKind ||
        (view === "agents" && libraryPanel?.kind === "tools"));
    const isAutomationCatalog =
      view === "schedule" &&
      libraryPanel?.kind === "automation" &&
      !libraryPanel.fields &&
      libraryPanel.actions?.some(
        (action) => action.id === "prepare-control-automation",
      );
    return (
      <section
        className={classNames(
          "shell-view shell-page-view command-library-shell-view",
          activeView === view && "active",
        )}
        data-shell-view={view}
        hidden={activeView !== view}
      >
        {panelReady && libraryPanel ? (
          <>
            {view === "agents" ? (
              <div
                className="command-library-mode-switch"
                role="tablist"
                aria-label={
                  locale === "zh"
                    ? "智能体能力目录"
                    : "Agent capability catalog"
                }
              >
                <button
                  aria-selected={libraryPanel.kind === "agents"}
                  className={
                    libraryPanel.kind === "agents" ? "active" : undefined
                  }
                  role="tab"
                  type="button"
                  onClick={() => void onOpenLibrary?.("agents")}
                >
                  {locale === "zh" ? "智能体" : "Agents"}
                </button>
                <button
                  aria-selected={libraryPanel.kind === "tools"}
                  className={
                    libraryPanel.kind === "tools" ? "active" : undefined
                  }
                  role="tab"
                  type="button"
                  onClick={() => void onOpenLibrary?.("tools")}
                >
                  {locale === "zh" ? "技能 · 连接器" : "Skills · Connectors"}
                </button>
              </div>
            ) : null}
            {isAutomationCatalog ? (
              <CommandControlScheduleView
                client={automationClient}
                locale={locale}
                panel={libraryPanel}
                onItemAction={onLibraryItemAction ?? (() => undefined)}
                onPanelAction={onLibraryPanelAction ?? (() => undefined)}
                onRefresh={() => void onOpenLibrary?.("automation")}
              />
            ) : (
              <AppWorkspaceLibraryContent
                libraryPanel={libraryPanel}
                locale={locale}
                onBackLibrary={() => switchView("command")}
                onItemAction={onLibraryItemAction ?? (() => undefined)}
                onLibraryPanelAction={onLibraryPanelAction ?? (() => undefined)}
                onPanelFieldChange={
                  onLibraryPanelFieldChange ?? (() => undefined)
                }
              />
            )}
          </>
        ) : (
          <div className="route-loading-state" role="status" aria-live="polite">
            <strong>
              {locale === "zh"
                ? "正在读取 Control 数据…"
                : "Loading Control data…"}
            </strong>
            <small>
              {locale === "zh"
                ? "页面会保留在当前工作台中"
                : "The page stays inside the current workspace"}
            </small>
          </div>
        )}
      </section>
    );
  }

  function focusActiveComposer() {
    const ref = activeView === "assist" ? assistantTextareaRef : textareaRef;
    ref.current?.focus();
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
    if (
      isSending ||
      activeTurnId ||
      !trimmed ||
      (controlExecutionCatalog && !model)
    ) {
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
      onSend,
      onSendNewThread,
      settings: commandComposerRuntimeSettings({
        executionTarget,
        model,
        ...(effectiveReasoningEffort
          ? { reasoningEffort: effectiveReasoningEffort }
          : {}),
        scene,
        sceneMode,
        executionIntent,
      }),
      shouldCreateNewThread,
      text: trimmed,
    });
    setNewTaskDraft(false);
  }

  function sendAssistantComposerValue(submittedValue = assistantComposerValue) {
    const trimmed = submittedValue.trim();
    if (isSending || assistantActiveTurnId || !trimmed || !onSendAssistant) {
      return;
    }
    setAssistantComposerValue("");
    const settings = commandComposerRuntimeSettings({
      executionTarget: "crewon",
      model,
      ...(effectiveReasoningEffort
        ? { reasoningEffort: effectiveReasoningEffort }
        : {}),
      executionIntent: "none",
    });
    onSendAssistant(trimmed, settings);
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
    const knowledgeSelection = commandKnowledgeSelection(
      item,
      knowledgeSelections,
    );
    if (knowledgeSelection) {
      onKnowledgeSelect?.(knowledgeSelection);
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
    if (item.command?.selection === "promptToken") {
      const nextValue = insertTokenIntoComposerValue({
        prefix: "/",
        token: item.command.token,
        value: currentValue,
      });
      if (activeView === "assist") {
        setAssistantComposerValue(nextValue);
      } else {
        onChangeComposerValue(nextValue);
      }
      closeComposerPalette();
      focusActiveComposer();
      return;
    }
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

  async function createRuntimeOffice(input: CommandOfficeCreationInput) {
    if (!officeRoomAdapter) {
      return;
    }
    setOfficeCreateBusy(true);
    setOfficeCreateError(null);
    try {
      const record = await officeRoomAdapter.create(input);
      const recordKey = officeRecordKey(record);
      setTeamCatalog((current) => ({
        ...current,
        offices: [
          ...current.offices.filter(
            (record) => officeRecordKey(record) !== recordKey,
          ),
          record,
        ],
        officeStatus: "ready",
        status: "ready",
      }));
      setOfficeCreateOpen(false);
      await openRuntimeOffice(record);
      setOfficeRoomWarning(null);
    } catch (error) {
      setOfficeCreateError(
        error instanceof Error ? error.message : "无法创建办公室",
      );
    } finally {
      setOfficeCreateBusy(false);
    }
  }

  const selectedOfficeRecordKey = selectedOfficeRecord
    ? officeRecordKey(selectedOfficeRecord)
    : null;
  const canCreateOffice = Boolean(
    officeRoomAdapter && connectionState === "connected",
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
        workspaceCwd: "",
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
        ? "CrewON Control 已连接"
        : "CrewON Control connected"
      : connectionState === "connecting"
        ? locale === "zh"
          ? "正在连接 CrewON Control"
          : "Connecting to CrewON Control"
        : connectionState === "demo"
          ? locale === "zh"
            ? "演示模式"
            : "Demo mode"
          : locale === "zh"
            ? "CrewON Control 已断开"
            : "CrewON Control disconnected";
  const composerActivityLabel = isSending
    ? locale === "zh"
      ? "发送中"
      : "Sending"
    : commandThreadRunning && composerValue.trim()
      ? locale === "zh"
        ? "请先停止当前运行，再发送新指令"
        : "Stop the current run before sending another instruction"
      : commandThreadRunning
        ? locale === "zh"
          ? "Agent 正在执行；请先停止，再发送新指令"
          : "Agent is running; stop it before sending another instruction"
        : composerValue.trim()
          ? locale === "zh"
            ? "草稿未发送"
            : "Draft not sent"
          : null;
  const threadProgress = threadProgressSummary(
    showCommandThread ? selectedThread : null,
  );
  const showProgressPill = hasThreadProgress(threadProgress);
  const goalBar = showCommandThread
    ? composerGoalBarState(threadGoal, locale)
    : null;
  const goalThreadId = selectedThread?.id ?? null;
  const reasoningEffortOptions = commandReasoningEffortOptions(
    effectiveModelOptions,
    model,
    locale,
  );
  const modelTriggerLabel = commandModelEffortLabel({
    effort: reasoningEffortOptions.length > 0 ? effectiveReasoningEffort : null,
    locale,
    modelLabel:
      effectiveModelOptions.find((option) => option.value === model)?.label ??
      model,
  });
  const modelEffortOptions = modelEffortMenuOptions({
    effortOptions: reasoningEffortOptions,
    modelOptions: effectiveModelOptions,
  });

  function selectModelOrEffort(nextValue: string) {
    const nextEffort = effortFromOptionValue(nextValue);
    if (nextEffort) {
      setSelectedReasoningEffort(nextEffort);
      return;
    }
    setModelSelectionTouched(true);
    setModel(nextValue);
  }
  const composerSendLabel = commandThreadRunning
    ? locale === "zh"
      ? "发送补充指令"
      : "Send follow-up"
    : locale === "zh"
      ? "发送任务"
      : "Send task";
  const commandThreadRoom =
    showCommandThread && selectedThread ? (
      <CommandThreadRoom
        activeTurnId={activeTurnId}
        cwd=""
        locale={locale}
        selectedThread={selectedThread}
        streamingText={streamingText}
        workMode={workMode}
        onModeChange={onModeChange}
        onStop={onStop}
      />
    ) : null;

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
          linkedThreads={commandLinkedThreads}
          locale={locale}
          query={sidebarSearchQuery}
          selectedWorkspaceName={
            workspaceOperations?.nativeWorkspaceDisplayName ?? null
          }
          selectedLinkedThreadId={activeLinkedThreadId}
          slots={slots}
          onCloseSearch={() => {
            setSidebarSearchOpen(false);
            setSidebarSearchQuery("");
          }}
          onClearWorkspace={workspaceOperations?.onClearNativeWorkspace}
          onNewThread={() => {
            setActiveLinkedThreadId(null);
            setNewTaskDraft(true);
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
          onSelectWorkspace={workspaceOperations?.onSelectNativeWorkspace}
          onQueryChange={setSidebarSearchQuery}
          onSwitchView={switchView}
          onToggleCollapse={() =>
            setSidebarCollapsed((collapsed) => !collapsed)
          }
          onToggleSearch={() => setSidebarSearchOpen((open) => !open)}
        />

        <DesktopWindowDragRegion />

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
            {/*
             * The task bar is a sibling of the centered work column, not a child
             * of it, so it can span the canvas and start flush left instead of
             * beginning mid-screen above the messages.
             */}
            {showCommandThread && selectedThread ? (
              <div className="command-thread-toolbar">
                <div className="command-thread-identity">
                  <strong
                    title={sidebarThreadTitle(
                      selectedThread,
                      locale === "zh" ? "未命名会话" : "Untitled thread",
                    )}
                  >
                    {sidebarThreadTitle(
                      selectedThread,
                      locale === "zh" ? "未命名会话" : "Untitled thread",
                    )}
                  </strong>
                </div>
              </div>
            ) : null}
            <section
              className={classNames(
                "hero-center",
                showCommandThread && "has-command-thread",
              )}
              data-od-id="primary-work-area"
            >
              {commandThreadRoom ? (
                workspaceOperations ? (
                  <div
                    className="command-thread-stage"
                    data-workspace-operations-slot="mounted"
                  >
                    {commandThreadRoom}
                    <aside
                      className="command-thread-operations-rail"
                      aria-label={
                        locale === "zh"
                          ? "工作空间操作"
                          : "Workspace operations"
                      }
                    >
                      <CommandWorkspaceOperationsPanel
                        {...workspaceOperations}
                        locale={locale}
                      />
                    </aside>
                  </div>
                ) : (
                  commandThreadRoom
                )
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
                  <CommandHomeCapabilityStrip
                    intent={executionIntent}
                    locale={locale}
                    preset={scenePreset}
                    resources={homeResourceEntries.map(
                      (entry) => entry.resource,
                    )}
                    risky={commandSceneMayWrite(scene, sceneMode)}
                    onIntentChange={(nextIntent) =>
                      setExecutionIntent((current) =>
                        nextExecutionIntent(current, nextIntent),
                      )
                    }
                    onResourceSelect={(resource) => {
                      const entry = homeResourceEntries.find(
                        (candidate) => candidate.resource.id === resource.id,
                      );
                      if (!entry) return;
                      if (entry.item.kind === "knowledge") {
                        insertContextItem(entry.item);
                      } else {
                        insertSlashItem(entry.item);
                      }
                    }}
                  />
                </>
              )}

              <CommandComposer
                actions={
                  <>
                    <CommandComposerSelect
                      ariaLabel={locale === "zh" ? "执行主体" : "Run with"}
                      className="execution-target-dropdown"
                      groups={executionTargetGroups(locale)}
                      options={executionTargets}
                      value={executionTarget}
                      onChange={selectExecutionTarget}
                    />
                    <CommandComposerSelect
                      activeValues={[
                        model,
                        ...(effectiveReasoningEffort
                          ? [effortOptionValue(effectiveReasoningEffort)]
                          : []),
                      ]}
                      ariaLabel={
                        locale === "zh" ? "模型与推理档位" : "Model and effort"
                      }
                      className="model-dropdown"
                      groups={modelEffortGroups(locale)}
                      options={modelEffortOptions}
                      triggerLabel={modelTriggerLabel}
                      value={model}
                      onChange={selectModelOrEffort}
                    />
                  </>
                }
                beforeTextarea={
                  <>
                    {showProgressPill ? (
                      <ComposerProgressPill
                        locale={locale}
                        running={commandThreadRunning}
                        summary={threadProgress}
                      />
                    ) : null}
                    {goalBar && goalThreadId ? (
                      <ComposerGoalBar
                        busy={threadGoalBusy}
                        goal={goalBar}
                        locale={locale}
                        onClear={() => onClearThreadGoal?.(goalThreadId)}
                        onEdit={(objective: string) =>
                          onSetThreadGoalObjective?.(goalThreadId, objective)
                        }
                        onTogglePause={() =>
                          onSetThreadGoalStatus?.(
                            goalThreadId,
                            goalPauseToggleStatus(
                              threadGoal?.status ?? "active",
                            ),
                          )
                        }
                      />
                    ) : null}
                    <ComposerResourceTags
                      resources={[
                        ...pendingComposerResources,
                        ...(providerComposerTag ? [providerComposerTag] : []),
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
                        removePendingResource(resource, "command");
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
                    {showCommandThread ? (
                      <SelectedExecutionIntent
                        intent={executionIntent}
                        locale={locale}
                        onClear={() => setExecutionIntent("none")}
                      />
                    ) : null}
                  </>
                }
                dataOdId="ai-composer"
                disabled={isSending || Boolean(activeTurnId)}
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
                        {workspaceOperations?.nativeWorkspaceDisplayName ??
                          (locale === "zh" ? "无工作空间" : "No workspace")}
                      </span>
                    ) : (
                      <CommandComposerSelect
                        ariaLabel={
                          locale === "zh" ? "工作空间选择" : "Workspace"
                        }
                        className="workspace-dropdown"
                        options={workspaceOptions}
                        value={
                          workspaceOperations?.nativeWorkspaceDisplayName
                            ? "__native_workspace__"
                            : noWorkspaceValue
                        }
                        onChange={(nextWorkspace) => {
                          const action =
                            nextWorkspace === noWorkspaceValue
                              ? workspaceOperations?.onClearNativeWorkspace
                              : workspaceOperations?.onSelectNativeWorkspace;
                          if (action) {
                            void Promise.resolve(action()).catch(
                              () => undefined,
                            );
                          }
                        }}
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
                        {locale === "zh" ? "重试 Control" : "Retry Control"}
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
                onStop={onStop}
                onSubmit={sendComposerValue}
              />
              {cloudAgentTargetError ? (
                <div className="composer-inline-error" role="alert">
                  {cloudAgentTargetError}
                </div>
              ) : null}

              {showCommandThread ? null : (
                <CommandSceneQuickRow
                  locale={locale}
                  scene={scene}
                  onQuickAction={(action) =>
                    prefillScenario(action.prompt, scene, action.mode)
                  }
                />
              )}
            </section>
          </section>

          <CommandWorkspaceAssistant
            active={activeView === "assist"}
            activeTurnId={assistantActiveTurnId}
            composer={
              <CommandComposer
                actions={
                  <CommandComposerSelect
                    activeValues={[
                      model,
                      ...(effectiveReasoningEffort
                        ? [effortOptionValue(effectiveReasoningEffort)]
                        : []),
                    ]}
                    ariaLabel={
                      locale === "zh" ? "模型与推理档位" : "Model and effort"
                    }
                    className="model-dropdown"
                    groups={modelEffortGroups(locale)}
                    options={modelEffortOptions}
                    triggerLabel={modelTriggerLabel}
                    value={model}
                    onChange={selectModelOrEffort}
                  />
                }
                beforeTextarea={
                  <>
                    <ComposerResourceTags
                      resources={[
                        ...pendingComposerResources,
                        ...(providerComposerTag ? [providerComposerTag] : []),
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
                        removePendingResource(resource, "assistant");
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
                  </>
                }
                dataOdId="assistant-composer"
                disabled={isSending || Boolean(assistantActiveTurnId)}
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
          <CommandProjectBoardView
            active={activeView === "projects"}
            locale={locale}
            selectedThreadId={selectedThreadId}
            threads={linkedThreads}
            onSelectThread={(threadId) => {
              setActiveLinkedThreadId(threadId);
              setNewTaskDraft(false);
              switchView("command");
              onSelectLinkedThread?.(threadId);
            }}
            onNewTask={() => {
              setActiveLinkedThreadId(null);
              setNewTaskDraft(true);
              onChangeComposerValue("");
              switchView("command");
              textareaRef.current?.focus();
            }}
          />
          {renderControlLibraryView("agents")}
          {renderControlLibraryView("schedule")}
          {renderControlLibraryView("knowledge")}
          <TeamView
            active={activeView === "team"}
            expertAgents={teamCatalog.agents.map(({ config }) => config)}
            officeRuntime={officeRuntime}
            officeRoomId={officeRoomId}
            teamMode={teamMode}
            controlWorkflowAdapter={controlWorkflowAdapter}
            selectedThreadId={selectedThreadId}
            onCreateOffice={
              canCreateOffice
                ? () => {
                    setOfficeCreateError(null);
                    setOfficeCreateOpen(true);
                  }
                : undefined
            }
            onCreateExpertGroup={
              canCreateOffice
                ? () => {
                    setOfficeCreateError(null);
                    setOfficeCreateOpen(true);
                  }
                : undefined
            }
            onRefresh={() => setTeamRefreshNonce((current) => current + 1)}
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
              supportsGoal={false}
              onClose={() => {
                if (!officeCreateBusy) {
                  setOfficeCreateOpen(false);
                  setOfficeCreateError(null);
                }
              }}
              onSubmit={createRuntimeOffice}
            />
          ) : null}
        </section>
      </section>
    </section>
  );
}
