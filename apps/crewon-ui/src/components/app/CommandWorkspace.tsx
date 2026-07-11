import { ArrowUp, ListChecks, Plus, ShieldCheck, Target } from "lucide-react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { officeRooms, workflowRooms } from "./commandWorkspaceData";
import {
  CommandSidebar,
  Palette,
  ResourceDock,
  type CommandLinkedThread,
  type PaletteItemWithCommand,
} from "./CommandWorkspaceChrome";
import { CommandThreadRoom } from "./CommandWorkspaceConversation";
import { CommandSceneHeader } from "./CommandSceneHeader";
import {
  AgentsView,
  AssistView,
  ProjectsView,
  ScheduleView,
  TeamView,
} from "./CommandWorkspaceViews";
import { classNames } from "./commandWorkspaceUtils";
import {
  emptyAgentPlatformSnapshot,
  insertTokenIntoComposerValue,
  selectCommandHomeSlots,
  type CommandHomeSlots,
  type CommandShellView,
} from "./commandWorkspaceState";
import {
  commandSceneContextItems,
  commandSceneResourceDockItems,
  commandSceneSlashItems,
} from "./commandWorkspaceSceneResources";
import {
  readAgentPlatformSnapshot,
  type AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
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
import type { AgentConfig, OfficeConfig } from "../../lib/domain/domainTypes";
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

type CommandWorkspaceProps = {
  activeTurnId?: string | null;
  composerValue: string;
  connectionState: ConnectionState;
  cwd: string;
  executionTargetClient?: {
    listAgentConfigs(cwd: string): Promise<{
      data: Array<{ config: AgentConfig; filePath: string }>;
    }>;
    listOfficeConfigs(cwd: string): Promise<{
      data: Array<{ config: OfficeConfig; filePath: string }>;
    }>;
  } | null;
  isSending: boolean;
  linkedThreads?: Thread[];
  locale?: Locale;
  modelOptions?: CommandModelOption[];
  selectedThread?: Thread | null;
  selectedThreadId?: string | null;
  slashCommands?: ComposerSlashCommand[];
  streamingText?: string;
  workMode: WorkMode;
  onAttachContext: () => void;
  onChangeComposerValue: (value: string) => void;
  onChangeWorkspaceCwd?: (cwd: string) => void;
  onModeChange: (mode: WorkMode) => void;
  onRetryConnection: () => void;
  onSend: (text: string, threadSettings?: ThreadRuntimeSettings) => void;
  onSendNewThread?: (
    text: string,
    threadSettings?: ThreadRuntimeSettings,
  ) => void;
  onSelectLinkedThread?: (threadId: string | null) => void;
  onSlashCommandSelect?: (command: ComposerSlashCommand) => void;
  onStop?: () => void;
};

type PlatformLoadState = "loading" | "ready" | "fallback";
type TeamMode = "office" | "workflow" | "experts";
export type CommandComposerKeyIntent =
  | "closePalette"
  | "openContext"
  | "openSlash"
  | "send"
  | null;
export type CommandComposerKeyIntentInput = {
  altKey: boolean;
  composerValue: string;
  ctrlKey: boolean;
  hasOpenPalette: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
};

const shellViewIds: CommandShellView[] = [
  "command",
  "assist",
  "projects",
  "agents",
  "schedule",
  "team",
];

type CommandSelectOption<TValue extends string = string> = {
  detail?: string;
  disabled?: boolean;
  tone?: "danger" | "normal" | "warning";
  value: TValue;
  label: string;
};

const permissionOptions: CommandSelectOption<CommandComposerPermission>[] = [
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

function CommandComposerSelect<TValue extends string>({
  ariaLabel,
  className,
  icon,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  className: string;
  icon?: ReactNode;
  options: CommandSelectOption<TValue>[];
  value: TValue;
  onChange: (value: TValue) => void;
}) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedOption =
    options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) {
      return;
    }
    function closeOnPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={classNames("control-select", className)}
      data-open={open ? "true" : "false"}
    >
      <span className="visually-hidden">{ariaLabel}</span>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="select-trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        {selectedOption?.label ?? value}
      </button>
      <div className="select-menu" hidden={!open} id={menuId} role="listbox">
        {options.map((option) => (
          <button
            key={option.value}
            aria-selected={option.value === value}
            className="select-option"
            data-tone={option.tone ?? "normal"}
            data-value={option.value}
            disabled={option.disabled}
            role="option"
            type="button"
            onClick={() => {
              if (option.disabled) {
                return;
              }
              onChange(option.value);
              setOpen(false);
            }}
          >
            <span>
              <strong>{option.label}</strong>
              {option.detail ? <em>{option.detail}</em> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
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

export function commandComposerKeyIntent({
  altKey,
  composerValue,
  ctrlKey,
  hasOpenPalette,
  isComposing,
  key,
  metaKey,
  shiftKey,
}: CommandComposerKeyIntentInput): CommandComposerKeyIntent {
  if (isComposing) {
    return null;
  }

  if (key === "Escape" && hasOpenPalette) {
    return "closePalette";
  }

  if (key === "Enter") {
    if (hasOpenPalette) {
      return null;
    }
    if (metaKey || ctrlKey) {
      return "send";
    }
    if (!shiftKey && !altKey) {
      return "send";
    }
    return null;
  }

  if (!metaKey && !ctrlKey && !altKey) {
    if (key === "@") {
      return "openContext";
    }
    if (key === "/" && (!composerValue || /\s$/.test(composerValue))) {
      return "openSlash";
    }
  }

  return null;
}

export function CommandWorkspace({
  activeTurnId = null,
  composerValue,
  connectionState,
  cwd,
  executionTargetClient = null,
  isSending,
  linkedThreads = [],
  locale = "zh",
  modelOptions = fallbackCommandModelOptions,
  selectedThread = null,
  selectedThreadId = null,
  slashCommands = [],
  streamingText = "",
  workMode,
  onAttachContext,
  onChangeComposerValue,
  onChangeWorkspaceCwd,
  onModeChange,
  onRetryConnection,
  onSend,
  onSendNewThread,
  onSelectLinkedThread,
  onSlashCommandSelect,
  onStop,
}: CommandWorkspaceProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
  const [scene, setScene] = useState<CommandScene>("office");
  const [sceneMode, setSceneMode] = useState<SceneInteractionMode>("auto");
  const [model, setModel] = useState(fallbackCommandModelOptions[0].value);
  const [modelSelectionTouched, setModelSelectionTouched] = useState(false);
  const [executionTarget, setExecutionTarget] = useState("crewon");
  const [executionTargetCatalog, setExecutionTargetCatalog] = useState<{
    agents: Array<{ config: AgentConfig; filePath: string }>;
    offices: Array<{ config: OfficeConfig; filePath: string }>;
    status: "loading" | "ready" | "unavailable";
  }>({ agents: [], offices: [], status: "loading" });
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
  const [scheduleMode, setScheduleMode] = useState("calendar");
  const [scheduleSource, setScheduleSource] = useState("personal");
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [teamMode, setTeamMode] = useState<TeamMode>("office");
  const [officeRoomId, setOfficeRoomId] = useState<string | null>(null);
  const [workflowRoomId, setWorkflowRoomId] = useState<string | null>(null);
  const [officeTab, setOfficeTab] = useState("chat");
  const [workflowTab, setWorkflowTab] = useState("run");

  useEffect(() => {
    function syncHash() {
      setActiveView(shellViewFromHash());
    }
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!executionTargetClient || !cwd) {
      setExecutionTargetCatalog({
        agents: [],
        offices: [],
        status: "unavailable",
      });
      return;
    }
    setExecutionTargetCatalog((current) => ({ ...current, status: "loading" }));
    Promise.all([
      executionTargetClient.listAgentConfigs(cwd),
      executionTargetClient.listOfficeConfigs(cwd),
    ])
      .then(([agents, offices]) => {
        if (!cancelled) {
          setExecutionTargetCatalog({
            agents: agents.data,
            offices: offices.data,
            status: "ready",
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExecutionTargetCatalog({
            agents: [],
            offices: [],
            status: "unavailable",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, executionTargetClient]);

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
  const resourceDockItems = useMemo(
    () => commandSceneResourceDockItems(platformSnapshot),
    [platformSnapshot],
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
  const resourceStatus =
    platformState === "loading"
      ? "资源同步中，当前显示默认能力入口。"
      : platformState === "fallback"
        ? "本地 agent-platform 未连接，对话后端不受影响。"
        : platformHasResources
          ? "Agent-platform 资源已同步。"
          : "Agent-platform 暂无资源，当前显示默认能力入口。";

  function switchView(view: CommandShellView) {
    setActiveView(view);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#view-${view}`);
    }
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

  function sendComposerValue() {
    const trimmed = composerValue.trim();
    if (isSending || !trimmed) {
      return;
    }
    onChangeComposerValue("");
    (newTaskDraft ? (onSendNewThread ?? onSend) : onSend)(
      trimmed,
      commandComposerRuntimeSettings({
        executionTarget,
        model,
        permission,
        scene,
        sceneMode,
        executionIntent,
      }),
    );
    setNewTaskDraft(false);
    setExecutionIntent("none");
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
    onChangeComposerValue(
      insertTokenIntoComposerValue({
        prefix: "@",
        token: item.title,
        value: composerValue,
      }),
    );
    closeComposerPalette();
    textareaRef.current?.focus();
  }

  function insertSlashItem(item: PaletteItemWithCommand) {
    if (item.command) {
      onSlashCommandSelect?.(item.command);
    }
    onChangeComposerValue(
      insertTokenIntoComposerValue({
        prefix: "/",
        token: item.command?.token ?? item.token ?? item.title,
        value: composerValue,
      }),
    );
    closeComposerPalette();
    textareaRef.current?.focus();
  }

  function insertAddItem(item: PaletteItemWithCommand) {
    if (item.action === "attach-files") {
      closeComposerPalette();
      onAttachContext();
      return;
    }
    if (item.kind === "skill" || item.kind === "mcp" || item.command) {
      insertSlashItem(item);
      return;
    }
    insertContextItem(item);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const intent = commandComposerKeyIntent({
      altKey: event.altKey,
      composerValue,
      ctrlKey: event.ctrlKey,
      hasOpenPalette: Boolean(openPalette),
      isComposing: event.nativeEvent.isComposing,
      key: event.key,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });

    if (intent === "closePalette") {
      event.preventDefault();
      closeComposerPalette();
      return;
    }
    if (intent === "send") {
      event.preventDefault();
      sendComposerValue();
      return;
    }
    if (intent === "openContext") {
      event.preventDefault();
      openComposerPalette("context");
      return;
    }
    if (intent === "openSlash") {
      event.preventDefault();
      openComposerPalette("slash");
    }
  }

  const currentWorkspace = basename(cwd || "工作空间");
  const activeOfficeRoom =
    officeRooms.find((room) => room.id === officeRoomId) ?? officeRooms[0];
  const activeWorkflowRoom =
    workflowRooms.find((room) => room.id === workflowRoomId) ??
    workflowRooms[0];
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

              <section
                className={classNames(
                  "command-input",
                  showCommandThread && "thread-command-input",
                )}
                data-od-id="ai-composer"
              >
                <label className="visually-hidden" htmlFor="desktop-task-input">
                  任务输入
                </label>
                <textarea
                  aria-describedby="composer-status composer-error"
                  data-composer=""
                  data-od-id="composer-input"
                  id="desktop-task-input"
                  placeholder={scenePreset.placeholder}
                  ref={textareaRef}
                  value={composerValue}
                  onChange={(event) =>
                    onChangeComposerValue(event.currentTarget.value)
                  }
                  onKeyDown={handleComposerKeyDown}
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

                <div className="input-tools" data-od-id="composer-tools">
                  <div
                    className="composer-controls"
                    data-od-id="composer-control-row"
                  >
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
                  </div>

                  <div
                    className="composer-actions"
                    data-od-id="composer-action-row"
                  >
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
                    <button
                      aria-busy={isSending}
                      aria-label={
                        showCommandThread ? composerSendLabel : "开始任务"
                      }
                      className="send-button"
                      disabled={isSending || !composerValue.trim()}
                      title={showCommandThread ? composerSendLabel : "开始任务"}
                      type="button"
                      onClick={sendComposerValue}
                    >
                      <ArrowUp aria-hidden="true" />
                    </button>
                  </div>
                </div>

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

                <div
                  className="composer-state-row"
                  data-od-id="composer-state-row"
                  id="composer-status"
                >
                  <span
                    className="workspace-picker"
                    data-od-id="workspace-picker"
                  >
                    {currentWorkspace}
                  </span>
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
                </div>
              </section>
            </section>

            {platformState === "ready" && resourceDockItems.length > 0 ? (
              <ResourceDock
                platformState={platformState}
                resources={resourceDockItems}
                slots={slots}
              />
            ) : null}
          </section>

          <AssistView
            active={activeView === "assist"}
            composerValue={composerValue}
            connectionState={connectionState}
            onChangeComposerValue={onChangeComposerValue}
            onSend={sendComposerValue}
          />
          <ProjectsView
            active={activeView === "projects"}
            resourceStatus={resourceStatus}
          />
          <AgentsView
            active={activeView === "agents"}
            catalogFilter={catalogFilter}
            catalogSearch={catalogSearch}
            slots={slots}
            onCatalogFilterChange={setCatalogFilter}
            onCatalogSearchChange={setCatalogSearch}
          />
          <ScheduleView
            active={activeView === "schedule"}
            modalOpen={scheduleModalOpen}
            scheduleMode={scheduleMode}
            scheduleSource={scheduleSource}
            onCloseModal={() => setScheduleModalOpen(false)}
            onModeChange={setScheduleMode}
            onOpenModal={() => setScheduleModalOpen(true)}
            onSourceChange={setScheduleSource}
          />
          <TeamView
            active={activeView === "team"}
            activeOfficeRoom={activeOfficeRoom}
            activeWorkflowRoom={activeWorkflowRoom}
            officeRoomId={officeRoomId}
            officeTab={officeTab}
            teamMode={teamMode}
            workflowRoomId={workflowRoomId}
            workflowTab={workflowTab}
            onBackOffice={() => setOfficeRoomId(null)}
            onBackWorkflow={() => setWorkflowRoomId(null)}
            onOfficeTabChange={setOfficeTab}
            onOpenOffice={setOfficeRoomId}
            onOpenWorkflow={setWorkflowRoomId}
            onTeamModeChange={(mode) => {
              setTeamMode(mode);
              setOfficeRoomId(null);
              setWorkflowRoomId(null);
            }}
            onWorkflowTabChange={setWorkflowTab}
          />
        </section>
      </section>
    </section>
  );
}
