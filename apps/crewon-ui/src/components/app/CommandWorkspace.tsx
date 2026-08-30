import { ListChecks, Plus, ShieldCheck, Target, X } from "lucide-react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";
import type { WorkflowRunUpdatedNotification } from "@crewon/app-server-protocol/v2/WorkflowRunUpdatedNotification";
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
  clearLegacyCommandTeamWorkspaceCwd,
  legacyCommandTeamWorkspaceCwd,
} from "./commandTeamWorkspace";
import {
  CommandSidebar,
  Palette,
  type CommandControlWorkspaceNav,
  type CommandLinkedThread,
  type PaletteItemWithCommand,
  type CommandWorkspaceAuthority,
} from "./CommandWorkspaceChrome";
import { CommandWorkspaceAssistant } from "./CommandWorkspaceAssistant";
import {
  assistantAutomationDraft,
  assistantScheduleRequest,
  type AutomationCreateDraft,
} from "./automationCreateDraft";
import {
  commandSidebarThreadScope,
  commandSidebarThreadScopeLabel,
  commandSidebarThreadState,
  commandSidebarThreadStateLabel,
  useCommandSidebarSeenThreadUpdates,
} from "./commandSidebarThreadPresentation";
import { CommandThreadRoom } from "./CommandWorkspaceConversation";
import { CommandSceneHeader, CommandSceneQuickRow } from "./CommandSceneHeader";
import {
  AgentsView,
  KnowledgeCatalogView,
  ProjectsView,
  TeamView,
} from "./CommandWorkspaceViews";
import { AutomationView } from "./CommandWorkspaceAutomations";
import type { ControlAutomationRuntime } from "../../lib/control-runtime/controlAutomationRuntime";
import {
  ControlWorkflowRuntime,
  isInternalControlWorkflowThread,
  type ControlWorkflowRuntimeClient,
} from "../../lib/control-runtime/controlWorkflowRuntime";
import {
  ControlExpertRuntime,
  isControlExpertOfficeRecord,
  isInternalControlExpertThread,
  type ControlExpertRuntimeClient,
} from "../../lib/control-runtime/controlExpertRuntime";
import { classNames } from "./commandWorkspaceUtils";

type ThreadGoalStatus = ThreadGoalView["status"];
import {
  agentPlatformResourceStates as selectAgentPlatformResourceStates,
  emptyAgentPlatformSnapshot,
  insertTokenIntoComposerValue,
  readThreadExecutionTarget,
  selectCommandHomeSlots,
  shouldResetExecutionTarget,
  writeThreadExecutionTarget,
  type AgentPlatformComposerResource,
  type CommandHomeSlots,
  type CommandShellView,
} from "./commandWorkspaceState";
import {
  commandLocalWorkspaceSlashItems,
  commandOnlineWorkspaceSlashItems,
  commandSceneContextItems,
  commandSceneSlashItems,
} from "./commandWorkspaceSceneResources";
import {
  platformAgentToConfig,
  readAgentPlatformSnapshot,
  type AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
import {
  agentPlatformExecutionTargetOptions,
  platformAgentForExecutionTarget,
} from "../../lib/agent-platform/agentPlatformExecutionTargets";
import { isLegacyGeneratedAgentPlaceholder } from "../../lib/agent-config/legacyAgentPlaceholder";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { Locale } from "../../lib/i18n";
import { detectRuntimeSurface, type PlatformKind } from "../../lib/platform";
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
  executionTargetGroups,
  executionTargetOptionsFromDomain,
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
  createControlOffice,
  listControlOfficeCatalog,
  type ControlOfficeClient,
} from "../../lib/office/controlOfficeRuntime";
import { controlOfficeRuntimeStatus } from "../../lib/office/controlOfficeExecutionTarget";
import { isLegacyGeneratedOfficePlaceholder } from "../../lib/office/legacyOfficePlaceholder";
import {
  commandComposerRuntimeSettings,
  fallbackCommandModelOptions,
  type CommandComposerPermission,
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
import type {
  CrewonWorkflowExecution,
  CrewonWorkflowNodeInput,
  CrewonWorkflowRecord,
} from "../../lib/workflow/crewonWorkflow";
import {
  crewonWorkflowConfigFromValue,
  workflowRecordsWithRuntimeUpdate,
} from "../../lib/workflow/crewonWorkflow";
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
import { commandComposerPermissionOptions } from "../composer/commandComposerPermissionOptions";
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
import type { ResourceRef } from "@crewon/app-server-protocol/platform/v2/ResourceRef";

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

export type CommandWorkspaceControlNav = CommandControlWorkspaceNav;

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
      data: OfficeRuntimeRecordReference[];
    }>;
    saveAgentConfig?: (cwd: string, config: AgentConfig) => Promise<unknown>;
    updateAgentConfig?: (
      cwd: string,
      filePath: string,
      config: AgentConfig,
    ) => Promise<unknown>;
    deleteAgentConfig?: (cwd: string, filePath: string) => Promise<unknown>;
    listWorkflowConfigs?: (cwd: string) => Promise<{
      data: CrewonWorkflowRecord[];
    }>;
    createWorkflowConfig?: (
      cwd: string,
      input: {
        name: string;
        description: string;
        lead: string;
        nodes: CrewonWorkflowNodeInput[];
      },
    ) => Promise<unknown>;
    runWorkflowConfig?: (
      cwd: string,
      workflowId: string,
      input: string,
    ) => Promise<CrewonWorkflowExecution>;
    resolveWorkflowGate?: (
      cwd: string,
      workflowId: string,
      executionId: string,
      nodeId: string,
      decision: "approve" | "reject",
      comment: string | null,
    ) => Promise<CrewonWorkflowExecution>;
    cancelWorkflowRun?: (
      cwd: string,
      workflowId: string,
      executionId: string,
    ) => Promise<CrewonWorkflowExecution>;
    subscribeWorkflowRunUpdates?: (
      listener: (notification: WorkflowRunUpdatedNotification) => void,
    ) => () => void;
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
  officeControlClient?: ControlOfficeClient | null;
  controlOfficeRoomAdapter?: CommandOfficeRoomAdapter | null;
  workflowControlClient?:
    | (ControlWorkflowRuntimeClient & ControlExpertRuntimeClient)
    | null;
  automationRuntime?: ControlAutomationRuntime | null;
  automationControlConfigured?: boolean;
  automationControlConnected?: boolean;
  /**
   * Control-mode workspace navigation for the sidebar tree: the bound folder's
   * name plus its select/clear mutations. `null` in legacy mode.
   */
  controlWorkspaceNav?: CommandWorkspaceControlNav | null;
  /**
   * `control` removes every legacy cwd/path authority surface. Omission keeps
   * historical call sites in the legacy cohort; production composition passes
   * this explicitly.
   */
  workspaceAuthority?: CommandWorkspaceAuthority;
  isSending: boolean;
  linkedThreads?: Thread[];
  locale?: Locale;
  platform?: PlatformKind;
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
  onEnsureAssistantThread?: () => Promise<Thread | null>;
  onModeChange: (mode: WorkMode) => void;
  onOpenSettings?: () => void;
  onSaveCapability?: import("../../lib/capability/capabilityCatalog").CapabilityEditorSaveHandler;
  onSceneChange?: (scene: CommandScene) => void;
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
  content?: string;
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
    ...(item.content ? { content: item.content } : {}),
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
    composer?: CommandOfficeComposerCapabilities,
  ) => ReactNode;
};

export type CommandOfficeComposerCapabilities = {
  contextItems: PaletteItemWithCommand[];
  modelOptions: CommandModelOption[];
  slashItems: PaletteItemWithCommand[];
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
const executionTargetQueryKey = "executionTarget";
const executionTargetThreadQueryKey = "executionTargetThread";

function readPersistedThreadExecutionTarget(threadId: string): string | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    const query = new URLSearchParams(window.location.search);
    const queryTarget = query.get(executionTargetQueryKey);
    if (
      query.get(executionTargetThreadQueryKey) === threadId &&
      queryTarget !== null &&
      queryTarget.length > 0 &&
      queryTarget.length <= 512 &&
      !/[\u0000-\u001f]/u.test(queryTarget)
    ) {
      return queryTarget;
    }
    return readThreadExecutionTarget(window.localStorage, threadId);
  } catch {
    return null;
  }
}

function persistThreadExecutionTarget(
  threadId: string,
  executionTarget: string,
): void {
  if (
    !threadId ||
    !executionTarget ||
    executionTarget.length > 512 ||
    /[\u0000-\u001f]/u.test(executionTarget)
  ) {
    return;
  }
  try {
    if (typeof window !== "undefined") {
      writeThreadExecutionTarget(
        window.localStorage,
        threadId,
        executionTarget,
      );
      const query = new URLSearchParams(window.location.search);
      query.set(executionTargetThreadQueryKey, threadId);
      query.set(executionTargetQueryKey, executionTarget);
      const search = query.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${search ? `?${search}` : ""}${
          window.location.hash
        }`,
      );
    }
  } catch {
    // Browser storage is optional; the active in-memory selection still works.
  }
}

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

export function executionIntentAfterCommit(
  current: CommandExecutionIntent,
  committed: Exclude<CommandExecutionIntent, "none">,
): CommandExecutionIntent {
  return current === committed ? "none" : current;
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
  officeControlClient = null,
  controlOfficeRoomAdapter = null,
  workflowControlClient = null,
  automationRuntime = null,
  automationControlConfigured = false,
  automationControlConnected = false,
  controlWorkspaceNav = null,
  workspaceAuthority = "legacy",
  isSending,
  linkedThreads = [],
  locale = "zh",
  platform = "web",
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
  onChangeWorkspaceCwd,
  onClearAssistantThread,
  onEnsureAssistantThread,
  onModeChange,
  onOpenSettings,
  onSaveCapability,
  onSceneChange,
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
  const executionTargetThreadIdRef = useRef<string | null>(null);
  const pendingThreadExecutionTargetRef = useRef<string | null>(null);
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
  useEffect(() => {
    onSceneChange?.(scene);
  }, [onSceneChange, scene]);
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
  const [permission, setPermission] =
    useState<CommandComposerPermission>("approve-for-me");
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
  const [platformState, setPlatformState] =
    useState<PlatformLoadState>("loading");
  const [platformSnapshot, setPlatformSnapshot] =
    useState<AgentPlatformSnapshot>(emptyAgentPlatformSnapshot);
  const [catalogFilter, setCatalogFilter] = useState("skill");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleCreateDraft, setScheduleCreateDraft] =
    useState<AutomationCreateDraft | null>(null);
  const [scheduleTargetThreadId, setScheduleTargetThreadId] = useState<
    string | null
  >(null);
  const scheduleDraftRequestIdRef = useRef(0);
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
  const [workflows, setWorkflows] = useState<CrewonWorkflowRecord[]>([]);
  const [workflowsStatus, setWorkflowsStatus] = useState<
    "loading" | "ready" | "unavailable"
  >("loading");
  const controlWorkflowRuntime = useMemo(
    () =>
      workflowControlClient === null
        ? null
        : new ControlWorkflowRuntime({ client: workflowControlClient }),
    [workflowControlClient],
  );
  const controlExpertRuntime = useMemo(
    () =>
      workflowControlClient === null
        ? null
        : new ControlExpertRuntime({
            client: workflowControlClient,
            locale,
          }),
    [locale, workflowControlClient],
  );
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
    }
    window.addEventListener("hashchange", syncRoute);
    window.addEventListener("popstate", syncRoute);
    return () => {
      window.removeEventListener("hashchange", syncRoute);
      window.removeEventListener("popstate", syncRoute);
    };
  }, []);

  // An office is a long-lived chat inside one workspace, so switching the
  // workspace must close whatever room is open.
  useEffect(() => {
    officeOpenRequestRef.current += 1;
    setOfficeRoomId(null);
    setOfficeCreateOpen(false);
    setOfficeCreateError(null);
    setOfficeRoomWarning(null);
    setSelectedOfficeRecord(null);
    setOfficeRoomError(null);
  }, [cwd]);

  // Legacy links carried a separate ?teamCwd= workspace for the team page. The
  // workspace now has a single source of truth (the sidebar), so adopt the old
  // parameter once and drop it from the URL.
  useEffect(() => {
    if (workspaceAuthority !== "legacy") {
      return;
    }
    const legacyCwd = legacyCommandTeamWorkspaceCwd();
    if (!legacyCwd) {
      return;
    }
    clearLegacyCommandTeamWorkspaceCwd();
    if (legacyCwd !== cwd.trim()) {
      onChangeWorkspaceCwd?.(legacyCwd);
    }
  }, [cwd, onChangeWorkspaceCwd, workspaceAuthority]);

  useEffect(() => {
    let cancelled = false;
    if (workspaceAuthority === "control") {
      if (!officeControlClient || connectionState !== "connected") {
        setExecutionTargetCatalog({
          agents: [],
          offices: [],
          officeStatus:
            connectionState === "connecting" ? "loading" : "unavailable",
          status: connectionState === "connecting" ? "loading" : "unavailable",
        });
        return;
      }
      setExecutionTargetCatalog((current) => ({
        ...current,
        officeStatus: "loading",
        status: "loading",
      }));
      void listControlOfficeCatalog(officeControlClient, locale).then(
        (catalog) => {
          if (!cancelled) {
            setExecutionTargetCatalog({
              ...catalog,
              officeStatus: "ready",
              status: "ready",
            });
          }
        },
        () => {
          if (!cancelled) {
            setExecutionTargetCatalog({
              agents: [],
              offices: [],
              officeStatus: "unavailable",
              status: "unavailable",
            });
          }
        },
      );
      return () => {
        cancelled = true;
      };
    }
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
  }, [
    connectionState,
    cwd,
    executionTargetClient,
    locale,
    officeControlClient,
    workspaceAuthority,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (workspaceAuthority === "control") {
      if (!officeControlClient || connectionState !== "connected") {
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
      void listControlOfficeCatalog(officeControlClient, locale).then(
        (catalog) => {
          if (!cancelled) {
            setTeamCatalog({
              ...catalog,
              offices: catalog.offices.filter(
                (record) => !isControlExpertOfficeRecord(record),
              ),
              officeStatus: "ready",
              status: "ready",
            });
          }
        },
        () => {
          if (!cancelled) {
            setTeamCatalog({
              agents: [],
              offices: [],
              officeStatus: "unavailable",
              status: "unavailable",
            });
          }
        },
      );
      return () => {
        cancelled = true;
      };
    }
    if (!executionTargetClient || !cwd || connectionState !== "connected") {
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
      executionTargetClient.listAgentConfigs(cwd),
      executionTargetClient.listOfficeConfigs(cwd),
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
                workspaceCwd: cwd,
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
    locale,
    officeControlClient,
    teamRefreshNonce,
    cwd,
    workspaceAuthority,
  ]);

  useCommandOfficeCatalogAutoReconnect({
    active:
      workspaceAuthority === "legacy" &&
      activeView === "team" &&
      teamMode === "office",
    connectionState,
    refreshNonce: setTeamRefreshNonce,
    status: teamCatalog.officeStatus,
    workspaceCwd: cwd,
  });

  const providerExpertWorkspaceKey = useMemo(() => {
    const workspaces = providerResource?.snapshot.workspaces ?? [];
    const matching = workspaces.filter(
      (workspace) => workspace.displayName === basename(cwd),
    );
    if (matching.length === 1) {
      return matching[0]?.workspaceKey ?? null;
    }
    if (
      providerResource?.selectedWorkspaceKey &&
      workspaces.some(
        (workspace) =>
          workspace.workspaceKey === providerResource.selectedWorkspaceKey &&
          workspace.availability === "available",
      )
    ) {
      return providerResource.selectedWorkspaceKey;
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
      connectionState !== "connected" ||
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
  }, [
    connectionState,
    cwd,
    executionTargetClient,
    providerExpertWorkspaceKey,
    workspaceAuthority,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (workspaceAuthority === "control") {
      if (!controlExpertRuntime || connectionState !== "connected") {
        setExpertTeams([]);
        setExpertTeamsStatus(
          connectionState === "connecting" ? "loading" : "unavailable",
        );
        return;
      }
      setExpertTeamsStatus("loading");
      void controlExpertRuntime.listExpertTeams().then(
        (records) => {
          if (!cancelled) {
            setExpertTeams([...records]);
            setExpertTeamsStatus("ready");
          }
        },
        () => {
          if (!cancelled) {
            setExpertTeams([]);
            setExpertTeamsStatus("unavailable");
          }
        },
      );
      return () => {
        cancelled = true;
      };
    }
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
    controlExpertRuntime,
    executionTargetClient,
    expertWorkspaceKey,
    teamRefreshNonce,
    workspaceAuthority,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (workspaceAuthority === "control") {
      if (!controlWorkflowRuntime || connectionState !== "connected") {
        setWorkflows([]);
        setWorkflowsStatus(
          connectionState === "connecting" ? "loading" : "unavailable",
        );
        return;
      }
      setWorkflowsStatus("loading");
      void controlWorkflowRuntime.listWorkflows().then(
        (records) => {
          if (!cancelled) {
            setWorkflows([...records]);
            setWorkflowsStatus("ready");
          }
        },
        () => {
          if (!cancelled) {
            setWorkflows([]);
            setWorkflowsStatus("unavailable");
          }
        },
      );
      return () => {
        cancelled = true;
      };
    }
    if (
      connectionState !== "connected" ||
      !cwd ||
      !executionTargetClient?.listWorkflowConfigs
    ) {
      setWorkflows([]);
      setWorkflowsStatus(
        connectionState === "connecting" ? "loading" : "unavailable",
      );
      return;
    }
    setWorkflowsStatus("loading");
    executionTargetClient
      .listWorkflowConfigs(cwd)
      .then((response) => {
        if (!cancelled) {
          setWorkflows(response.data);
          setWorkflowsStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkflows([]);
          setWorkflowsStatus("unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    connectionState,
    controlWorkflowRuntime,
    cwd,
    executionTargetClient,
    teamRefreshNonce,
    workspaceAuthority,
  ]);

  useEffect(() => {
    if (
      workspaceAuthority === "control" ||
      !cwd ||
      !executionTargetClient?.subscribeWorkflowRunUpdates
    ) {
      return;
    }
    return executionTargetClient.subscribeWorkflowRunUpdates((notification) => {
      if (notification.cwd !== cwd) {
        return;
      }
      const config = crewonWorkflowConfigFromValue(notification.config);
      if (!config) {
        return;
      }
      setWorkflows((current) =>
        workflowRecordsWithRuntimeUpdate(current, {
          filePath: notification.filePath,
          config,
        }),
      );
      setWorkflowsStatus("ready");
    });
  }, [cwd, executionTargetClient, workspaceAuthority]);

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
    () =>
      commandSceneContextItems(
        scene,
        platformSnapshot,
        workspaceAuthority === "legacy" ? cwd : "",
      ),
    [cwd, platformSnapshot, scene, workspaceAuthority],
  );
  const platformSlashPaletteItems = useMemo(
    () => commandSceneSlashItems(platformSnapshot, slashCommands),
    [platformSnapshot, slashCommands],
  );
  const slashPaletteItems = useMemo(() => {
    if (workspaceAuthority !== "control" || connectionState !== "connected") {
      return platformSlashPaletteItems;
    }
    const workspaceItems = controlWorkspaceNav?.name
      ? commandLocalWorkspaceSlashItems(locale)
      : detectRuntimeSurface() === "web"
        ? commandOnlineWorkspaceSlashItems(locale)
        : [];
    return [...workspaceItems, ...platformSlashPaletteItems];
  }, [
    connectionState,
    controlWorkspaceNav?.name,
    locale,
    platformSlashPaletteItems,
    workspaceAuthority,
  ]);
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
        action: "intent-goal",
        active: executionIntent === "goal",
        detail:
          locale === "zh"
            ? "围绕一个可追踪的目标持续推进，进度显示在目标栏"
            : "Keep working toward a trackable goal, with progress in the goal bar",
        kind: "intent",
        label: locale === "zh" ? "目标" : "Goal",
        title: locale === "zh" ? "目标模式" : "Goal mode",
      },
      {
        action: "intent-plan",
        active: executionIntent === "plan",
        detail:
          locale === "zh"
            ? "先给出执行计划，确认后再执行"
            : "Draft an execution plan first, then run it after confirmation",
        kind: "intent",
        label: locale === "zh" ? "计划" : "Plan",
        title: locale === "zh" ? "计划模式" : "Plan mode",
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
              detail: "添加可用的云端工具或知识库",
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
      locale,
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
    const activeAgentVersionIds = new Set(
      executionTargetCatalog.agents.flatMap((record) => {
        const id = record.config.agentId?.trim();
        return id ? [id] : [];
      }),
    );
    const domainTargets = executionTargetOptionsFromDomain({
      ...executionTargetCatalog,
      locale,
      offices: executionTargetCatalog.offices.map((record) =>
        isControlOfficeDefinitionRecord(record)
          ? {
              config: record.config,
              controlOffice: {
                memberCount: record.definition.members.length,
                officeVersionId: record.definition.officeVersionId,
                runtimeStatus: controlOfficeRuntimeStatus(
                  record.definition,
                  activeAgentVersionIds,
                ),
              },
              filePath: record.filePath,
            }
          : record,
      ),
    });
    if (workspaceAuthority === "control") {
      return domainTargets;
    }
    const providerTargets = providerExecutionTargetsAvailable
      ? providerAgentExecutionTargetOptions(
          providerResource?.executionAgents ?? [],
        )
      : [];
    const platformTargets =
      providerTargets.length === 0
        ? agentPlatformExecutionTargetOptions(
            platformSnapshot,
            executionTargetCatalog.agents,
          )
        : [];
    const expertTargets = expertTeams.map((record) => ({
      detail:
        locale === "zh"
          ? `${record.config.experts.length} 名后台专家 · 团长 ${record.config.leader.name}`
          : `${record.config.experts.length} background experts · lead ${record.config.leader.name}`,
      group: "experts" as const,
      kind: "experts" as const,
      label: record.config.title,
      strategy: "team" as const,
      value: `experts:${record.config.expertsId}`,
    }));
    // Natural order: the selector groups these into local, cloud, and expert
    // sections, so the concat order no longer has to interleave cloud targets
    // behind CrewON to keep them visible.
    return [
      ...domainTargets,
      ...providerTargets,
      ...platformTargets,
      ...expertTargets,
    ];
  }, [
    executionTargetCatalog,
    expertTeams,
    locale,
    platformSnapshot,
    providerResource?.executionAgents,
    providerExecutionTargetsAvailable,
    workspaceAuthority,
  ]);
  const localizedScenePresets = locale === "zh" ? scenePresets : scenePresetsEn;
  const scenePreset = localizedScenePresets[scene];
  const localizedPermissionOptions: CommandComposerSelectOption<CommandComposerPermission>[] =
    commandComposerPermissionOptions(locale);
  const workspaceOptions = useMemo<CommandComposerSelectOption[]>(() => {
    if (workspaceAuthority !== "legacy") {
      return [];
    }
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
  }, [cwd, linkedThreads, locale, workspaceAuthority]);
  useEffect(() => {
    if (selectedThreadId === null) {
      executionTargetThreadIdRef.current = null;
      return;
    }
    if (executionTargetThreadIdRef.current === selectedThreadId) {
      return;
    }
    const pendingTarget = pendingThreadExecutionTargetRef.current;
    pendingThreadExecutionTargetRef.current = null;
    const storedTarget =
      pendingTarget ?? readPersistedThreadExecutionTarget(selectedThreadId);
    const nextTarget = storedTarget ?? "crewon";
    executionTargetThreadIdRef.current = selectedThreadId;
    setExecutionTarget(nextTarget);
    if (pendingTarget !== null) {
      persistThreadExecutionTarget(selectedThreadId, pendingTarget);
    }
  }, [selectedThreadId]);
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
      shouldResetExecutionTarget({
        catalogStatus: executionTargetCatalog.status,
        optionAvailable: executionTargets.some(
          (target) => target.value === executionTarget,
        ),
        selectedProviderAgentMatches,
      })
    ) {
      setExecutionTarget("crewon");
      if (selectedThreadId !== null) {
        persistThreadExecutionTarget(selectedThreadId, "crewon");
      }
      providerResource?.onExecutionAgentSelect?.(null);
    }
  }, [
    executionTarget,
    executionTargetCatalog.status,
    executionTargets,
    providerResource?.executionAgents,
    providerResource?.onExecutionAgentSelect,
    providerResource?.selectedExecutionAgent,
    selectedThreadId,
  ]);

  async function selectExecutionTarget(nextTarget: string) {
    if (!nextTarget) {
      return;
    }
    setCloudAgentTargetError(null);
    const platformAgent = platformAgentForExecutionTarget(
      platformSnapshot,
      nextTarget,
    );
    if (platformAgent) {
      try {
        await addPlatformAgentToWorkspace(platformAgent.id);
      } catch (error) {
        setCloudAgentTargetError(
          error instanceof Error ? error.message : "云智能体同步失败",
        );
        return;
      }
    }
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
    if (selectedThreadId !== null) {
      persistThreadExecutionTarget(selectedThreadId, nextTarget);
    }
  }
  const visibleContextItems = paletteFilter(contextPaletteItems, paletteQuery);
  const visibleSlashItems = paletteFilter(slashPaletteItems, paletteQuery);
  const visibleAddItems = paletteFilter(addPaletteItems, paletteQuery);
  const sidebarSeenThreadUpdates = useCommandSidebarSeenThreadUpdates(
    linkedThreads,
    selectedThreadId,
  );
  const commandLinkedThreads: CommandLinkedThread[] = useMemo(
    () =>
      linkedThreads
        .filter(
          (thread) =>
            (thread.forkedFromId === null ||
              thread.forkedFromId === undefined) &&
            !isInternalControlWorkflowThread(thread) &&
            !isInternalControlExpertThread(thread),
        )
        .map((thread) => {
          const seenUpdatedAt =
            selectedThreadId === thread.id
              ? thread.updatedAt
              : (sidebarSeenThreadUpdates[thread.id] ?? 0);
          const state = commandSidebarThreadState(thread, seenUpdatedAt);
          const scope = commandSidebarThreadScope(thread);
          const workspacePath =
            workspaceAuthority === "control"
              ? (controlWorkspaceNav?.name ?? "")
              : (thread.cwd ?? "");
          const workspaceLabel =
            workspacePath
              .replace(/\\/gu, "/")
              .replace(/\/+$/gu, "")
              .split("/")
              .filter(Boolean)
              .pop() ?? (locale === "zh" ? "无工作空间" : "No workspace");
          return {
            cwd: workspaceAuthority === "legacy" ? (thread.cwd ?? null) : null,
            id: thread.id,
            preview: thread.preview,
            scope,
            scopeLabel: commandSidebarThreadScopeLabel(scope, locale),
            state,
            stateLabel: commandSidebarThreadStateLabel(state, locale),
            title: sidebarThreadTitle(
              thread,
              locale === "zh" ? "未命名会话" : "Untitled thread",
            ),
            updatedAt: thread.updatedAt,
            updatedLabel: formatRelativeTime(thread.updatedAt, locale),
            workspaceLabel,
          };
        }),
    [
      linkedThreads,
      locale,
      selectedThreadId,
      sidebarSeenThreadUpdates,
      controlWorkspaceNav?.name,
      workspaceAuthority,
    ],
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

  function openLinkedThread(threadId: string) {
    setActiveLinkedThreadId(threadId);
    setNewTaskDraft(false);
    switchView("command");
    onSelectLinkedThread?.(threadId);
  }

  async function reloadWorkflowDefinitions() {
    if (workspaceAuthority === "control") {
      if (!controlWorkflowRuntime) {
        setWorkflows([]);
        setWorkflowsStatus("unavailable");
        return;
      }
      setWorkflowsStatus("loading");
      try {
        setWorkflows([...(await controlWorkflowRuntime.listWorkflows())]);
        setWorkflowsStatus("ready");
      } catch {
        setWorkflows([]);
        setWorkflowsStatus("unavailable");
      }
      return;
    }
    if (!executionTargetClient?.listWorkflowConfigs || !cwd) {
      setWorkflows([]);
      setWorkflowsStatus("unavailable");
      return;
    }
    setWorkflowsStatus("loading");
    try {
      const response = await executionTargetClient.listWorkflowConfigs(cwd);
      setWorkflows(response.data);
      setWorkflowsStatus("ready");
    } catch {
      setWorkflows([]);
      setWorkflowsStatus("unavailable");
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
    if (shouldCreateNewThread) {
      pendingThreadExecutionTargetRef.current = executionTarget;
    } else if (selectedThreadId !== null) {
      persistThreadExecutionTarget(selectedThreadId, executionTarget);
    }
    submitCommandComposer({
      cwd: workspaceAuthority === "legacy" ? cwd || null : null,
      images: commandImages.map(({ detail, url }) => ({ detail, url })),
      onSend,
      onSendNewThread,
      settings: commandComposerRuntimeSettings({
        executionTarget,
        ...(workspaceAuthority === "legacy" || executionTarget === "crewon"
          ? { model }
          : {}),
        permission,
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
    setCommandImages([]);
    setNewTaskDraft(false);
  }

  function sendAssistantComposerValue(submittedValue = assistantComposerValue) {
    const trimmed = submittedValue.trim();
    if (isSending || !trimmed || !onSendAssistant) {
      return;
    }
    const scheduleRequest = assistantScheduleRequest(trimmed);
    if (automationControlConfigured && scheduleRequest !== null) {
      void openAssistantSchedule(scheduleRequest);
      return;
    }
    setAssistantComposerValue("");
    const settings = commandComposerRuntimeSettings({
      executionTarget: "crewon",
      model,
      permission,
      ...(effectiveReasoningEffort
        ? { reasoningEffort: effectiveReasoningEffort }
        : {}),
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

  async function openAssistantSchedule(draftText = assistantComposerValue) {
    const targetThread =
      assistantThread ?? (await onEnsureAssistantThread?.()) ?? null;
    scheduleDraftRequestIdRef.current += 1;
    setScheduleCreateDraft(
      assistantAutomationDraft(
        draftText,
        scheduleDraftRequestIdRef.current,
        locale,
      ),
    );
    setScheduleTargetThreadId(targetThread?.id ?? selectedThreadId);
    setScheduleModalOpen(true);
    switchView("schedule");
  }

  function closeScheduleModal() {
    setScheduleModalOpen(false);
    setScheduleCreateDraft(null);
    setScheduleTargetThreadId(null);
  }

  function openScheduleModal() {
    setScheduleCreateDraft(null);
    setScheduleTargetThreadId(null);
    setScheduleModalOpen(true);
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
    if (item.action === "intent-goal" || item.action === "intent-plan") {
      const selected = item.action === "intent-goal" ? "goal" : "plan";
      setExecutionIntent((current) => nextExecutionIntent(current, selected));
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
    const controlDefinition = isControlOfficeDefinitionRecord(record);
    if (
      !key ||
      (controlDefinition ? !controlOfficeRoomAdapter : !officeRoomAdapter)
    ) {
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
      if (controlDefinition) {
        await controlOfficeRoomAdapter!.open(record);
      } else {
        await officeRoomAdapter!.open(record);
      }
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
    if (
      workspaceAuthority === "control"
        ? !officeControlClient
        : !executionTargetClient || !cwd || !officeRoomAdapter
    ) {
      return;
    }
    setOfficeCreateBusy(true);
    setOfficeCreateError(null);
    try {
      const result =
        workspaceAuthority === "control"
          ? {
              record: await createControlOffice({
                client: officeControlClient!,
                locale,
                members: input.members,
                title: input.title,
              }),
              warnings: [],
            }
          : await createCommandOffice(
              executionTargetClient!,
              cwd,
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
    setExecutionTarget(
      workspaceAuthority === "control"
        ? `team:${record.config.expertsId}`
        : `experts:${record.config.expertsId}`,
    );
    setScene("office");
    setSceneMode("coordinate");
    setActiveLinkedThreadId(null);
    setNewTaskDraft(true);
    onChangeComposerValue(record.config.goal);
    switchView("command");
    textareaRef.current?.focus();
  }

  async function addPlatformAgentToWorkspace(agentId: number) {
    if (!executionTargetClient?.saveAgentConfig || !cwd) {
      throw new Error("App Server 或当前工作区不可用，无法加入智能体");
    }
    const index = platformSnapshot.agents.findIndex(
      (agent) => agent.id === agentId,
    );
    const agent = platformSnapshot.agents[index];
    if (!agent) {
      throw new Error("云智能体已不存在，请刷新资源后重试");
    }
    await executionTargetClient.saveAgentConfig(
      cwd,
      platformAgentToConfig(agent, platformSnapshot, index),
    );
    setTeamRefreshNonce((current) => current + 1);
  }

  async function createExpertTeam(input: CommandTeamCapabilityCreateInput) {
    if (
      input.kind !== "experts" ||
      (workspaceAuthority === "control"
        ? !controlExpertRuntime || teamCatalog.agents.length === 0
        : !expertWorkspaceKey || !executionTargetClient?.createExpertTeam)
    ) {
      return;
    }
    setExpertCreateBusy(true);
    setExpertCreateError(null);
    try {
      const { kind: _kind, ...definition } = input;
      const controlCreated =
        workspaceAuthority === "control"
          ? await controlExpertRuntime!.createExpertTeam({
              definition,
              agents: teamCatalog.agents,
            })
          : null;
      const createdRecord =
        controlCreated?.record ??
        (
          await executionTargetClient!.createExpertTeam!(
            expertWorkspaceKey!,
            definition,
          )
        ).record;
      if (controlCreated !== null) {
        setExecutionTargetCatalog((current) => ({
          ...current,
          offices: [...current.offices, controlCreated.office],
        }));
      }
      setExpertTeams((current) => [
        createdRecord,
        ...current.filter(
          (record) =>
            record.config.expertsId !== createdRecord.config.expertsId,
        ),
      ]);
      setExpertTeamsStatus("ready");
      setExpertCreateOpen(false);
      setTeamRefreshNonce((current) => current + 1);
      openExpertTeam(createdRecord);
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
    if (
      input.kind !== "workflow" ||
      (workspaceAuthority === "control"
        ? !controlWorkflowRuntime
        : !cwd || !executionTargetClient?.createWorkflowConfig)
    ) {
      return;
    }
    setWorkflowCreateBusy(true);
    setWorkflowCreateError(null);
    try {
      if (workspaceAuthority === "control") {
        await controlWorkflowRuntime!.createWorkflow({
          title: input.title,
          description: input.goal,
          nodes: input.nodes.map((node) =>
            node.type === "humanGate"
              ? node
              : {
                  type: node.type,
                  title: node.title,
                  instruction: node.instruction,
                  agentVersionId: node.agentId,
                },
          ),
        });
      } else {
        await executionTargetClient!.createWorkflowConfig!(cwd, {
          description: input.goal,
          lead: input.lead,
          name: input.title,
          nodes: input.nodes.map((node) =>
            node.type === "humanGate"
              ? {
                  type: "humanGate" as const,
                  instruction: node.instruction,
                  title: node.title,
                }
              : {
                  type: "agent" as const,
                  agentId: node.agentId,
                  agentName:
                    teamCatalog.agents.find(
                      (record) => record.config.agentId === node.agentId,
                    )?.config.name ?? node.title,
                  instruction: node.instruction,
                  title: node.title,
                },
          ),
        });
      }
      await reloadWorkflowDefinitions();
      setWorkflowCreateOpen(false);
    } catch (error) {
      setWorkflowCreateError(
        error instanceof Error ? error.message : "无法创建协作流",
      );
    } finally {
      setWorkflowCreateBusy(false);
    }
  }

  const currentWorkspace =
    workspaceAuthority === "legacy"
      ? basename(cwd || (locale === "zh" ? "工作空间" : "Workspace"))
      : null;
  const selectedOfficeRecordKey = selectedOfficeRecord
    ? officeRecordKey(selectedOfficeRecord)
    : null;
  const canCreateOffice = Boolean(
    connectionState === "connected" &&
      (workspaceAuthority === "control"
        ? officeControlClient
        : officeRoomAdapter && executionTargetClient && cwd),
  );
  const canCreateExpertTeam = Boolean(
    connectionState === "connected" &&
      (workspaceAuthority === "control"
        ? controlExpertRuntime && teamCatalog.agents.length > 0
        : expertWorkspaceKey && executionTargetClient?.createExpertTeam),
  );
  const canCreateWorkflow = Boolean(
    connectionState === "connected" &&
      (workspaceAuthority === "control"
        ? controlWorkflowRuntime && teamCatalog.agents.length > 0
        : cwd && executionTargetClient?.createWorkflowConfig) &&
      workflowsStatus !== "unavailable",
  );
  const officeRuntime =
    officeRoomAdapter || officeControlClient
      ? {
          definitionOnly: false,
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
                {isControlOfficeDefinitionRecord(selectedOfficeRecord)
                  ? controlOfficeRoomAdapter?.render(
                      selectedOfficeRecord,
                      closeRuntimeOffice,
                      () => undefined,
                      {
                        contextItems: contextPaletteItems,
                        modelOptions: effectiveModelOptions,
                        slashItems: slashPaletteItems,
                      },
                    )
                  : officeRoomAdapter?.render(
                      selectedOfficeRecord,
                      closeRuntimeOffice,
                      () => {
                        const deletedKey =
                          officeRecordKey(selectedOfficeRecord);
                        setTeamCatalog((current) => ({
                          ...current,
                          offices: current.offices.filter(
                            (record) => officeRecordKey(record) !== deletedKey,
                          ),
                        }));
                        setSelectedOfficeRecord(null);
                        closeRuntimeOffice();
                      },
                      {
                        contextItems: contextPaletteItems,
                        modelOptions: effectiveModelOptions,
                        slashItems: slashPaletteItems,
                      },
                    )}
              </>
            )
          ) : null,
          selectedRecordKey: selectedOfficeRecordKey,
          status: teamCatalog.officeStatus,
          workspaceCwd: workspaceAuthority === "legacy" ? cwd : undefined,
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
        ? "对话服务已连接"
        : "Conversation service connected"
      : connectionState === "connecting"
        ? locale === "zh"
          ? "正在连接对话服务"
          : "Connecting to conversation service"
        : connectionState === "demo"
          ? locale === "zh"
            ? "演示模式"
            : "Demo mode"
          : locale === "zh"
            ? "对话服务已断开"
            : "Conversation service disconnected";
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
        cwd={workspaceAuthority === "legacy" ? cwd : ""}
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
          controlWorkspace={
            workspaceAuthority === "control"
              ? (controlWorkspaceNav ?? undefined)
              : undefined
          }
          isSearchOpen={sidebarSearchOpen}
          cwd={workspaceAuthority === "legacy" ? cwd : ""}
          linkedThreads={commandLinkedThreads}
          locale={locale}
          platform={platform}
          query={sidebarSearchQuery}
          selectedLinkedThreadId={activeLinkedThreadId}
          slots={slots}
          workspaceAuthority={workspaceAuthority}
          onCloseSearch={() => {
            setSidebarSearchOpen(false);
            setSidebarSearchQuery("");
          }}
          onCreateWorkspace={
            workspaceAuthority === "legacy" ? onChangeWorkspaceCwd : undefined
          }
          onNewThread={(workspaceCwd) => {
            setActiveLinkedThreadId(null);
            setNewTaskDraft(true);
            if (workspaceAuthority === "legacy") {
              onChangeWorkspaceCwd?.(workspaceCwd);
            }
            onChangeComposerValue("");
            switchView("command");
            textareaRef.current?.focus();
          }}
          onOpenLinkedThread={openLinkedThread}
          onOpenSettings={onOpenSettings}
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
                commandThreadRoom
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
                      className="max-w-[180px]"
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
                      className="max-w-[138px]"
                      disabled={
                        workspaceAuthority === "control" &&
                        executionTarget !== "crewon"
                      }
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
                      className="max-w-[180px]"
                      icon={<ShieldCheck aria-hidden="true" />}
                      options={localizedPermissionOptions}
                      value={permission}
                      onChange={setPermission}
                    />
                    {executionIntent !== "none" ? (
                      <button
                        aria-label={
                          executionIntent === "goal"
                            ? locale === "zh"
                              ? "取消目标执行意图"
                              : "Clear goal execution intent"
                            : locale === "zh"
                              ? "取消计划执行意图"
                              : "Clear plan execution intent"
                        }
                        className="execution-intent-chip"
                        data-execution-intent={executionIntent}
                        title={locale === "zh" ? "点击取消" : "Click to clear"}
                        type="button"
                        onClick={() => setExecutionIntent("none")}
                      >
                        {executionIntent === "goal" ? (
                          <Target aria-hidden="true" />
                        ) : (
                          <ListChecks aria-hidden="true" />
                        )}
                        <span>
                          {executionIntent === "goal"
                            ? locale === "zh"
                              ? "目标"
                              : "Goal"
                            : locale === "zh"
                              ? "计划"
                              : "Plan"}
                        </span>
                        <X aria-hidden="true" />
                      </button>
                    ) : null}
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
                    {workspaceAuthority ===
                    "control" ? null : showCommandThread ? (
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
                        {locale === "zh" ? "重新连接" : "Reconnect"}
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
                    className="max-w-[138px]"
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
                      className="max-w-[180px]"
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
            onCreateSchedule={
              automationControlConfigured ? openAssistantSchedule : undefined
            }
            onModeChange={onModeChange}
            onStop={onStop}
          />
          <ProjectsView
            active={activeView === "projects"}
            locale={locale}
            tasks={commandLinkedThreads}
            onNewTask={() => {
              setActiveLinkedThreadId(null);
              setNewTaskDraft(true);
              onChangeComposerValue("");
              switchView("command");
              textareaRef.current?.focus();
            }}
            onOpenTask={openLinkedThread}
          />
          <AgentsView
            active={activeView === "agents"}
            catalogFilter={catalogFilter}
            catalogSearch={catalogSearch}
            platformState={platformState}
            resourceStates={platformResourceStates}
            snapshot={platformSnapshot}
            localAgents={
              workspaceAuthority === "control"
                ? executionTargetCatalog.agents
                : []
            }
            onReload={reloadPlatformResources}
            onCatalogFilterChange={setCatalogFilter}
            onCatalogSearchChange={setCatalogSearch}
            onAddAgent={addPlatformAgentToWorkspace}
            onSaveCapability={onSaveCapability}
          />
          <KnowledgeCatalogView
            active={activeView === "knowledge"}
            platformState={platformState}
            resourceStates={platformResourceStates}
            snapshot={platformSnapshot}
            onReload={reloadPlatformResources}
          />
          <AutomationView
            active={activeView === "schedule"}
            connected={automationControlConnected}
            controlConfigured={automationControlConfigured}
            createDraft={scheduleCreateDraft}
            modalOpen={scheduleModalOpen}
            runtime={automationRuntime}
            selectedThreadId={scheduleTargetThreadId ?? selectedThreadId}
            spaceAuthorityKey={cwd.trim() || "__standalone__"}
            onCloseModal={closeScheduleModal}
            onOpenModal={openScheduleModal}
            onOpenThread={onSelectLinkedThread}
          />
          <TeamView
            active={activeView === "team"}
            officeRuntime={officeRuntime}
            officeRoomId={officeRoomId}
            teamMode={teamMode}
            workflows={workflows}
            workflowStatus={workflowsStatus}
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
              canCreateWorkflow
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
            onReloadWorkflows={reloadWorkflowDefinitions}
            onRunWorkflow={async (workflow, input) => {
              if (workspaceAuthority === "control") {
                if (!controlWorkflowRuntime || !selectedThreadId) {
                  throw new Error("请先选择一个活动任务再运行协作流");
                }
                const result = await controlWorkflowRuntime.runWorkflow({
                  workflowVersionId: workflow.config.workflowId,
                  threadId: selectedThreadId,
                  prompt: input,
                });
                await reloadWorkflowDefinitions();
                return result;
              }
              if (!cwd || !executionTargetClient?.runWorkflowConfig) {
                throw new Error("App Server 尚未提供协作流执行能力");
              }
              return executionTargetClient.runWorkflowConfig(
                cwd,
                workflow.config.workflowId,
                input,
              );
            }}
            onCancelWorkflow={async (workflow, executionId) => {
              if (workspaceAuthority === "control") {
                if (!controlWorkflowRuntime) {
                  throw new Error("Control 协作流暂不可用");
                }
                const result = await controlWorkflowRuntime.cancelWorkflow({
                  workflowVersionId: workflow.config.workflowId,
                  executionId,
                });
                await reloadWorkflowDefinitions();
                return result;
              }
              if (!cwd || !executionTargetClient?.cancelWorkflowRun) {
                throw new Error("App Server 尚未提供协作流取消能力");
              }
              return executionTargetClient.cancelWorkflowRun(
                cwd,
                workflow.config.workflowId,
                executionId,
              );
            }}
            onResolveWorkflowGate={async (
              workflow,
              executionId,
              nodeId,
              decision,
              comment,
            ) => {
              if (workspaceAuthority === "control") {
                if (!controlWorkflowRuntime) {
                  throw new Error("Control 协作流暂不可用");
                }
                const result = await controlWorkflowRuntime.resolveGate({
                  workflowVersionId: workflow.config.workflowId,
                  executionId,
                  nodeId,
                  decision,
                  comment,
                });
                await reloadWorkflowDefinitions();
                return result;
              }
              if (!cwd || !executionTargetClient?.resolveWorkflowGate) {
                throw new Error("App Server 尚未提供 Human Gate 处理能力");
              }
              return executionTargetClient.resolveWorkflowGate(
                cwd,
                workflow.config.workflowId,
                executionId,
                nodeId,
                decision,
                comment,
              );
            }}
            onSelectExpert={openExpertTeam}
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
              supportsGoal={workspaceAuthority === "legacy"}
              supportsRoleReuse={workspaceAuthority === "control"}
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
              workflowAgents={teamCatalog.agents.flatMap(({ config }) =>
                config.agentId
                  ? [
                      {
                        description: config.role,
                        id: config.agentId,
                        modelName: config.model,
                        name: config.name,
                        systemPrompt: config.systemPrompt,
                      },
                    ]
                  : [],
              )}
              workflowRequiresVerification={workspaceAuthority === "control"}
              workspaceCwd={cwd}
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
