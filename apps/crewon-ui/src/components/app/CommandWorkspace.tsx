import { ListChecks, Plus, ShieldCheck, Target } from "lucide-react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { CommandOfficeCreateDialog } from "./CommandOfficeCreateDialog";
import { syncDownloadedAgentPlatformConfigs } from "./commandAgentPlatformSync";
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
import {
  ScheduleView,
  type ScheduleClient,
} from "./CommandWorkspaceSchedule";
import { classNames } from "./commandWorkspaceUtils";
import {
  agentPlatformResourceStates as selectAgentPlatformResourceStates,
  emptyAgentPlatformSnapshot,
  insertTokenIntoComposerValue,
  selectCommandHomeSlots,
  type CommandHomeSlots,
  type CommandShellView,
} from "./commandWorkspaceState";
import {
  commandSceneContextItems,
  commandSceneSlashItems,
} from "./commandWorkspaceSceneResources";
import {
  readAgentPlatformSnapshot,
  type AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
import { isLegacyGeneratedAgentPlaceholder } from "../../lib/agent-config/legacyAgentPlaceholder";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { Locale } from "../../lib/i18n";
import type { ConnectionState } from "../../lib/shared/connectionState";
import { formatRelativeTime } from "../../lib/shared/text";
import {
  executionTargetOptionsFromDomain,
  scenePresets,
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
  } | null;
  scheduleClient?: ScheduleClient | null;
  isSending: boolean;
  linkedThreads?: Thread[];
  locale?: Locale;
  modelOptions?: CommandModelOption[];
  officeRoomAdapter?: CommandOfficeRoomAdapter | null;
  selectedThread?: Thread | null;
  selectedThreadId?: string | null;
  slashCommands?: ComposerSlashCommand[];
  streamingText?: string;
  workMode: WorkMode;
  onAttachContext: (workspaceCwd?: string | null) => void;
  onChangeComposerValue: (value: string) => void;
  onChangeWorkspaceCwd?: (cwd: string | null) => void;
  onClearAssistantThread?: () => void | Promise<void>;
  onModeChange: (mode: WorkMode) => void;
  onRetryConnection: () => void;
  onSend: (text: string, threadSettings?: ThreadRuntimeSettings) => void;
  onSendAssistant?: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
  ) => void;
  onSendNewThread?: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
    workspaceCwd?: string | null,
  ) => void;
  onSelectLinkedThread?: (threadId: string | null) => void;
  onSlashCommandSelect?: (command: ComposerSlashCommand) => void;
  onStop?: () => void;
};

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

const permissionOptions: CommandComposerSelectOption<CommandComposerPermission>[] =
  [
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
  selectedThread = null,
  selectedThreadId = null,
  slashCommands = [],
  streamingText = "",
  workMode,
  onAttachContext,
  onChangeComposerValue,
  onChangeWorkspaceCwd,
  onClearAssistantThread,
  onModeChange,
  onRetryConnection,
  onSend,
  onSendAssistant,
  onSendNewThread,
  onSelectLinkedThread,
  onSlashCommandSelect,
  onStop,
}: CommandWorkspaceProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const assistantTextareaRef = useRef<HTMLTextAreaElement>(null);
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
    "add" | "context" | "slash" | null
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
  const [officeRoomWarning, setOfficeRoomWarning] = useState<string | null>(
    null,
  );
  const [selectedOfficeRecord, setSelectedOfficeRecord] =
    useState<OfficeConfigRecordReference | null>(null);
  const [officeRoomError, setOfficeRoomError] = useState<string | null>(null);
  const officeOpenRequestRef = useRef(0);
  const downloadedAgentSyncKeyRef = useRef<string | null>(null);

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
    const workspaceCwd = teamWorkspaceCwd.trim();
    const listAgentConfigs = executionTargetClient?.listAgentConfigs.bind(
      executionTargetClient,
    );
    const saveAgentConfig = executionTargetClient?.saveAgentConfig?.bind(
      executionTargetClient,
    );
    if (
      connectionState !== "connected" ||
      platformState !== "ready" ||
      !workspaceCwd ||
      !listAgentConfigs ||
      !saveAgentConfig
    ) {
      return;
    }

    const downloadedAgents = platformSnapshot.agents.filter(
      (agent) => agent.downloaded,
    );
    const syncKey = JSON.stringify({
      workspaceCwd,
      agents: downloadedAgents.map((agent) => ({
        id: agent.id,
        downloadedAt: agent.downloaded_at ?? null,
        sourceUpdatedAt: agent.source_updated_at ?? null,
      })),
    });
    if (
      downloadedAgents.length === 0 ||
      downloadedAgentSyncKeyRef.current === syncKey
    ) {
      return;
    }
    downloadedAgentSyncKeyRef.current = syncKey;

    let cancelled = false;
    void syncDownloadedAgentPlatformConfigs({
      client: { listAgentConfigs, saveAgentConfig },
      cwd: workspaceCwd,
      snapshot: platformSnapshot,
    }).then(
      (saved) => {
        if (!cancelled && saved > 0) {
          setTeamRefreshNonce((current) => current + 1);
        }
      },
      () => {
        if (!cancelled && downloadedAgentSyncKeyRef.current === syncKey) {
          downloadedAgentSyncKeyRef.current = null;
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    connectionState,
    executionTargetClient,
    platformSnapshot,
    platformState,
    teamWorkspaceCwd,
  ]);

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
    () => commandSceneContextItems(scene, platformSnapshot, cwd),
    [cwd, platformSnapshot, scene],
  );
  const slashPaletteItems = useMemo(
    () => commandSceneSlashItems(platformSnapshot, slashCommands),
    [platformSnapshot, slashCommands],
  );
  const addPaletteItems = useMemo<PaletteItemWithCommand[]>(
    () => [
      {
        action: "attach-files",
        detail: "从当前工作空间选择要加入任务的内容",
        kind: "file",
        label: "文件",
        title: "文件和文件夹",
      },
      ...contextPaletteItems.filter((item) => item.kind === "knowledge"),
      ...slashPaletteItems.filter(
        (item) => item.kind === "skill" || item.kind === "mcp",
      ),
    ],
    [contextPaletteItems, slashPaletteItems],
  );
  const executionTargets = useMemo(
    () => executionTargetOptionsFromDomain(executionTargetCatalog),
    [executionTargetCatalog],
  );
  const scenePreset = scenePresets[scene];
  const workspaceOptions = useMemo<CommandComposerSelectOption[]>(() => {
    const paths = [cwd, ...linkedThreads.map((thread) => thread.cwd ?? "")]
      .map((path) => path.trim())
      .filter(
        (path, index, allPaths) => path && allPaths.indexOf(path) === index,
      );
    return [
      {
        detail: "不绑定项目文件夹，使用默认执行环境",
        label: "无工作空间",
        value: noWorkspaceValue,
      },
      ...paths.map((path) => ({
        detail: path,
        label: basename(path),
        value: path,
      })),
    ];
  }, [cwd, linkedThreads]);
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
    if (!executionTargets.some((target) => target.value === executionTarget)) {
      setExecutionTarget("crewon");
    }
  }, [executionTarget, executionTargets]);
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
  const platformResourceStates = selectAgentPlatformResourceStates(
    platformSnapshot,
  );
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
    const shouldCreateNewThread = newTaskDraft || !selectedThread;
    (shouldCreateNewThread ? (onSendNewThread ?? onSend) : onSend)(
      trimmed,
      commandComposerRuntimeSettings({
        executionTarget,
        model,
        permission,
        scene,
        sceneMode,
        executionIntent,
      }),
      cwd || null,
    );
    setNewTaskDraft(false);
    setExecutionIntent("none");
  }

  function sendAssistantComposerValue(
    submittedValue = assistantComposerValue,
  ) {
    const trimmed = submittedValue.trim();
    if (isSending || !trimmed || !onSendAssistant) {
      return;
    }
    setAssistantComposerValue("");
    onSendAssistant(
      trimmed,
      commandComposerRuntimeSettings({
        executionTarget: "crewon",
        model,
        permission,
        executionIntent: "none",
      }),
    );
  }

  function openComposerPalette(kind: "add" | "context" | "slash") {
    setOpenPalette(kind);
    setPaletteQuery("");
  }

  function toggleComposerPalette(kind: "add" | "context" | "slash") {
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
    const nextValue =
      insertTokenIntoComposerValue({
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
    if (item.command) {
      onSlashCommandSelect?.(item.command);
    }
    const currentValue =
      activeView === "assist" ? assistantComposerValue : composerValue;
    const nextValue =
      insertTokenIntoComposerValue({
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
      onAttachContext(cwd || null);
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

  const currentWorkspace = basename(cwd || "工作空间");
  const selectedOfficeRecordKey = selectedOfficeRecord
    ? officeRecordKey(selectedOfficeRecord)
    : null;
  const canCreateOffice = Boolean(
    officeRoomAdapter &&
      executionTargetClient &&
      teamWorkspaceCwd &&
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
        onRetry: onRetryConnection,
      }
    : null;
  const showCommandThread =
    activeView === "command" && Boolean(selectedThread) && !newTaskDraft;
  const commandThreadRunning =
    Boolean(activeTurnId) ||
    Boolean(selectedThread?.turns.some((turn) => turn.status === "inProgress"));
  const connectionStatusLabel =
    connectionState === "connected"
      ? "App Server 已连接"
      : connectionState === "connecting"
        ? "正在连接 App Server"
        : connectionState === "demo"
          ? "演示模式"
          : "App Server 已断开";
  const composerActivityLabel = isSending
    ? "发送中"
    : commandThreadRunning && composerValue.trim()
      ? "继续补充指令"
      : commandThreadRunning
        ? "Agent 正在执行，可继续输入补充指令"
        : composerValue.trim()
          ? "草稿未发送"
          : null;
  const composerSendLabel = commandThreadRunning ? "发送补充指令" : "发送任务";

  return (
    <section
      className="screen-shell command-screen desktop-command-screen"
      data-od-id="desktop-command-screen"
      data-force-new-task={newTaskDraft ? "true" : "false"}
      data-locale={locale}
    >
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
                      ariaLabel="执行主体"
                      className="execution-target-dropdown"
                      options={executionTargets}
                      value={executionTarget}
                      onChange={setExecutionTarget}
                    />
                    <CommandComposerSelect
                      ariaLabel="模型选择"
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
                afterTextarea={
                  <>
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
                ariaLabel="任务输入"
                className={classNames(
                  "command-input",
                  showCommandThread && "thread-command-input",
                )}
                controls={
                  <>
                    <button
                      aria-label="添加上下文"
                      className="icon-action composer-plus-action"
                      data-palette-trigger="add"
                      type="button"
                      onClick={() => toggleComposerPalette("add")}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                    <CommandComposerSelect
                      ariaLabel="权限选择"
                      className="permission-dropdown"
                      icon={<ShieldCheck aria-hidden="true" />}
                      options={permissionOptions}
                      value={permission}
                      onChange={setPermission}
                    />
                    <div
                      aria-label="执行意图"
                      className="execution-intent-switch"
                      role="group"
                    >
                      <button
                        aria-pressed={executionIntent === "goal"}
                        className="execution-intent-button"
                        data-execution-intent="goal"
                        title="持续追求当前任务目标"
                        type="button"
                        onClick={() =>
                          setExecutionIntent((current) =>
                            nextExecutionIntent(current, "goal"),
                          )
                        }
                      >
                        <Target aria-hidden="true" />
                        <span>目标</span>
                      </button>
                      <button
                        aria-pressed={executionIntent === "plan"}
                        className="execution-intent-button"
                        data-execution-intent="plan"
                        title="先制定计划，不直接执行"
                        type="button"
                        onClick={() =>
                          setExecutionIntent((current) =>
                            nextExecutionIntent(current, "plan"),
                          )
                        }
                      >
                        <ListChecks aria-hidden="true" />
                        <span>计划</span>
                      </button>
                    </div>
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
                      placeholder="添加文件、知识库、Skill 或 MCP"
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
                      placeholder="搜索文件、会话或工作空间"
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
                      placeholder="搜索 Skill 或 MCP，例如 页面审阅、Filesystem"
                      query={paletteQuery}
                      onClose={closeComposerPalette}
                      onQueryChange={setPaletteQuery}
                      onSelect={insertSlashItem}
                    />
                  </>
                }
                paletteOpen={Boolean(openPalette)}
                placeholder={scenePreset.placeholder}
                sendLabel={showCommandThread ? composerSendLabel : "开始任务"}
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
                        ariaLabel="工作空间选择"
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
                        重试 app-server
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
                stateDataOdId="composer-state-row"
                stateId="composer-status"
                submitBehavior="enter"
                submitting={isSending}
                textareaDataOdId="composer-input"
                textareaRef={textareaRef}
                value={composerValue}
                onChange={onChangeComposerValue}
                onClosePalette={closeComposerPalette}
                onOpenPalette={openComposerPalette}
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
                    ariaLabel="模型选择"
                    className="model-dropdown"
                    options={effectiveModelOptions}
                    value={model}
                    onChange={(nextModel) => {
                      setModelSelectionTouched(true);
                      setModel(nextModel);
                    }}
                  />
                }
                afterTextarea={
                  <>
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
                ariaLabel="助理输入"
                className="command-input thread-command-input assistant-home-composer"
                controls={
                  <>
                    <button
                      aria-label="添加附件或能力"
                      className="icon-action composer-plus-action"
                      data-palette-trigger="add"
                      type="button"
                      onClick={() => toggleComposerPalette("add")}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                    <CommandComposerSelect
                      ariaLabel="权限选择"
                      className="permission-dropdown"
                      icon={<ShieldCheck aria-hidden="true" />}
                      options={permissionOptions}
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
                      placeholder="添加附件、知识库、Skill 或 MCP"
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
                      placeholder="搜索可引用的上下文"
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
                      placeholder="搜索 Skill 或 MCP"
                      query={paletteQuery}
                      onClose={closeComposerPalette}
                      onQueryChange={setPaletteQuery}
                      onSelect={insertSlashItem}
                    />
                  </>
                }
                paletteOpen={Boolean(openPalette)}
                placeholder="告诉助理你想了解、整理或持续跟进的事情…"
                running={Boolean(assistantActiveTurnId)}
                sendLabel={assistantActiveTurnId ? "发送补充指令" : "发送"}
                state={
                  <>
                    <span
                      className="composer-state"
                      id="assistant-composer-status"
                    >
                      单一会话 · 默认执行环境 · 上下文自动压缩
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
                stopLabel="停止"
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
            onCreateOffice={
              canCreateOffice
                ? () => {
                    setOfficeCreateError(null);
                    setOfficeCreateOpen(true);
                  }
                : undefined
            }
            onRefresh={() => setTeamRefreshNonce((current) => current + 1)}
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
        </section>
      </section>
    </section>
  );
}
