import { ArrowUp, AtSign, CheckCircle2, Mic, Paperclip } from "lucide-react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  officeRooms,
  quickScenarios,
  sceneTabs,
  workflowRooms,
} from "./commandWorkspaceData";
import {
  CommandSidebar,
  Palette,
  type CommandLinkedThread,
  type PaletteItemWithCommand,
} from "./CommandWorkspaceChrome";
import { CommandThreadRoom } from "./CommandWorkspaceConversation";
import {
  AgentsView,
  AssistView,
  KnowledgeCatalogView,
  ProjectsView,
  ScheduleView,
  TeamView,
} from "./CommandWorkspaceViews";
import { classNames, connectionLabel } from "./commandWorkspaceUtils";
import {
  emptyAgentPlatformSnapshot,
  insertTokenIntoComposerValue,
  selectCommandHomeSlots,
  type CommandHomeSlots,
  type CommandScene,
  type CommandShellView,
} from "./commandWorkspaceState";
import {
  readAgentPlatformSnapshot,
  type AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { Locale } from "../../lib/i18n";
import type { ConnectionState } from "../../lib/shared/connectionState";
import { formatRelativeTime } from "../../lib/shared/text";
import {
  commandComposerRuntimeSettings,
  fallbackCommandModelOptions,
  type CommandComposerPermission,
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
  onNewThread?: () => void;
  onRetryConnection: () => void;
  onSend: (text: string, threadSettings?: ThreadRuntimeSettings) => void;
  onSelectLinkedThread?: (threadId: string | null) => void;
  onSlashCommandSelect?: (command: ComposerSlashCommand) => void;
  onStop?: () => void;
};

type PlatformLoadState = "loading" | "ready" | "fallback";
type TeamMode = "office" | "workflow" | "experts";
type CommandComposerMode = "agent" | "goal" | "plan";
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
  "knowledge",
  "schedule",
  "team",
];

type CommandSelectOption<TValue extends string = string> = {
  detail?: string;
  tone?: "danger" | "normal" | "warning";
  value: TValue;
  label: string;
};

const composerModeOptions: CommandSelectOption<CommandComposerMode>[] = [
  { label: "计划", value: "plan" },
  { label: "目标", value: "goal" },
  { label: "智能体", value: "agent" },
];

const permissionOptions: CommandSelectOption<CommandComposerPermission>[] = [
  {
    detail: "工作区内自动执行，必要时请求升级",
    label: "替我审批",
    value: "approve-for-me",
  },
  {
    detail: "执行前请求确认",
    label: "请求批准",
    value: "request-approval",
  },
  {
    detail: "不经审批地使用完整文件系统权限",
    label: "完全访问",
    tone: "warning",
    value: "full-access",
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
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  className: string;
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
            role="option"
            type="button"
            onClick={() => {
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

function contextItems(
  slots: CommandHomeSlots,
  cwd: string,
): PaletteItemWithCommand[] {
  const items: PaletteItemWithCommand[] = [
    {
      kind: "file",
      label: "文件",
      title: basename(cwd || "workspace"),
      detail: cwd || "当前工作区",
    },
    {
      kind: "conversation",
      label: "会话",
      title: slots.workflow.title,
      detail: slots.workflow.detail,
    },
    {
      kind: "workspace",
      label: "空间",
      title: slots.knowledge.title,
      detail: slots.knowledge.detail,
    },
  ];
  if (/^agent-\d+$/.test(slots.agent.value)) {
    items.push({
      kind: "agent",
      label: "智能体",
      title: slots.agent.title,
      detail: slots.agent.detail,
    });
  }
  if (/^knowledge-\d+$/.test(slots.knowledge.value)) {
    items.push({
      kind: "knowledge",
      label: "知识库",
      title: slots.knowledge.title,
      detail: slots.knowledge.detail,
    });
  }
  return items;
}

function slashItems(
  slots: CommandHomeSlots,
  slashCommands: ComposerSlashCommand[],
): PaletteItemWithCommand[] {
  const commandItems: PaletteItemWithCommand[] = slashCommands.map(
    (command) => ({
      command,
      detail: command.description,
      kind:
        command.kind === "mcp"
          ? "mcp"
          : command.kind === "skill"
            ? "skill"
            : "agent",
      label: command.meta,
      title: command.label,
      token: command.token,
    }),
  );
  const fallbackItems: PaletteItemWithCommand[] = [
    ...slots.skills
      .filter((item) => /^skill-\d+$/.test(item.value))
      .map((item) => ({
        detail: item.detail,
        kind: "skill" as const,
        label: item.label,
        title: item.title,
        token: item.title,
      })),
    ...slots.mcps
      .filter((item) => /^mcp-\d+$/.test(item.value))
      .map((item) => ({
        detail: item.detail,
        kind: "mcp" as const,
        label: item.label,
        title: item.title,
        token: item.title,
      })),
    {
      detail: slots.workflow.detail,
      kind: "workflow",
      label: slots.workflow.label,
      title: slots.workflow.title,
      token: slots.workflow.title,
    },
  ];
  return [...commandItems, ...fallbackItems].slice(0, 12);
}

export function CommandWorkspace({
  activeTurnId = null,
  composerValue,
  connectionState,
  cwd,
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
  onNewThread,
  onRetryConnection,
  onSend,
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
  const [scene, setScene] = useState<CommandScene>(
    workMode === "office" ? "office" : "code",
  );
  const [composerMode, setComposerMode] = useState<CommandComposerMode>("plan");
  const [model, setModel] = useState(fallbackCommandModelOptions[0].value);
  const [modelSelectionTouched, setModelSelectionTouched] = useState(false);
  const [agent, setAgent] = useState("product-review");
  const [permission, setPermission] =
    useState<CommandComposerPermission>("approve-for-me");
  const [workspace, setWorkspace] = useState("product");
  const [openPalette, setOpenPalette] = useState<"context" | "slash" | null>(
    null,
  );
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
    () => contextItems(slots, cwd),
    [cwd, slots],
  );
  const slashPaletteItems = useMemo(
    () => slashItems(slots, slashCommands),
    [slots, slashCommands],
  );
  const visibleContextItems = paletteFilter(contextPaletteItems, paletteQuery);
  const visibleSlashItems = paletteFilter(slashPaletteItems, paletteQuery);
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
    setActiveView(view);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#view-${view}`);
    }
  }

  function switchScene(nextScene: CommandScene) {
    setScene(nextScene);
    onModeChange(nextScene === "office" ? "office" : "code");
  }

  function prefillScenario(prompt: string, nextScene: CommandScene) {
    switchScene(nextScene);
    onChangeComposerValue(prompt);
    textareaRef.current?.focus();
  }

  function refinePrompt() {
    const current = composerValue.trim();
    const refined = current
      ? `请优化以下任务描述，保留目标、约束和验收项：${current}`
      : "请帮我把任务描述整理成目标、上下文、约束、交付物和验收标准。";
    onChangeComposerValue(refined);
    textareaRef.current?.focus();
  }

  function sendComposerValue() {
    const trimmed = composerValue.trim();
    if (isSending || !trimmed) {
      return;
    }
    onChangeComposerValue("");
    onSend(trimmed, commandComposerRuntimeSettings({ model, permission }));
  }

  function openComposerPalette(kind: "context" | "slash") {
    setOpenPalette(kind);
    setPaletteQuery("");
  }

  function closeComposerPalette() {
    setOpenPalette(null);
    setPaletteQuery("");
  }

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
  const showCommandThread = activeView === "command" && Boolean(selectedThread);
  const commandThreadRunning =
    Boolean(activeTurnId) ||
    Boolean(selectedThread?.turns.some((turn) => turn.status === "inProgress"));
  const composerRuntimeLabel = isSending
    ? "发送中"
    : commandThreadRunning && composerValue.trim()
      ? "继续补充指令"
      : commandThreadRunning
        ? "Agent 正在执行，可继续输入补充指令"
        : composerValue.trim()
          ? "草稿未发送"
          : connectionLabel(connectionState);
  const composerStateLabel =
    showCommandThread && !commandThreadRunning && !composerValue.trim()
      ? "内容由 AI 生成，请核实重要信息"
      : composerRuntimeLabel;
  const composerSendLabel = commandThreadRunning ? "发送补充指令" : "发送任务";

  return (
    <section
      className="screen-shell command-screen desktop-command-screen"
      data-od-id="desktop-command-screen"
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
            switchView("command");
            onNewThread?.();
            textareaRef.current?.focus();
          }}
          onOpenLinkedThread={(threadId) => {
            setActiveLinkedThreadId(threadId);
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
            <button
              className="workspace-pill"
              type="button"
              data-od-id="workspace-pill"
              onClick={() => switchView("projects")}
            >
              <span aria-hidden="true" />
              <strong>{currentWorkspace} · 已同步</strong>
            </button>

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
                  <header
                    className="home-title"
                    data-od-id="desktop-command-header"
                  >
                    <h1>
                      <span>Crewon</span>
                      <br />
                      <span>创建可编排的 Agent 小队</span>
                    </h1>
                  </header>

                  <div
                    className="scene-tabs scene-pills"
                    data-od-id="scene-tabs"
                  >
                    {sceneTabs.map((tab) => (
                      <button
                        className={classNames(scene === tab.key && "active")}
                        key={tab.key}
                        type="button"
                        aria-pressed={scene === tab.key}
                        data-scene-target={tab.key}
                        title={tab.description}
                        onClick={() => switchScene(tab.key)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  <div className="quick-row" data-od-id="quick-scenarios">
                    {quickScenarios.map((scenario) => (
                      <button
                        className={classNames(
                          scenario.scene !== scene && "is-hidden",
                        )}
                        data-scene={scenario.scene}
                        key={`${scenario.scene}-${scenario.label}`}
                        type="button"
                        onClick={() =>
                          prefillScenario(scenario.prompt, scenario.scene)
                        }
                      >
                        {scenario.label}
                      </button>
                    ))}
                  </div>
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
                  placeholder="例如：整理今天的项目事项，安排会议、跟进阻塞，并把结论写入知识库"
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
                  hidden
                  tabIndex={-1}
                  type="button"
                  onClick={() => openComposerPalette("context")}
                />
                <button
                  aria-hidden="true"
                  className="shortcut-proxy"
                  data-slash-open=""
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
                    <CommandComposerSelect
                      ariaLabel="任务类型"
                      className="mode-dropdown"
                      options={composerModeOptions}
                      value={composerMode}
                      onChange={setComposerMode}
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
                    <label
                      className="control-select agent-dropdown"
                      data-agent-menu=""
                      hidden={composerMode !== "agent"}
                    >
                      <span className="visually-hidden">智能体配置</span>
                      <select
                        aria-label="智能体配置"
                        data-agent-select=""
                        value={agent}
                        onChange={(event) => setAgent(event.target.value)}
                      >
                        <option value="product-review">
                          {slots.agent.title}
                        </option>
                        <option value="engineering-handoff">
                          开发交付智能体
                        </option>
                        <option value="visual-polish">视觉打磨智能体</option>
                        <option value="meeting-prep">会议准备智能体</option>
                      </select>
                    </label>
                    <CommandComposerSelect
                      ariaLabel="权限选择"
                      className={classNames(
                        "permission-dropdown",
                        permission === "full-access" && "is-warning",
                      )}
                      options={permissionOptions}
                      value={permission}
                      onChange={setPermission}
                    />
                  </div>

                  <div
                    className="composer-actions"
                    data-od-id="composer-action-row"
                  >
                    <button
                      aria-label="优化提示词"
                      className="icon-action prompt-action"
                      type="button"
                      onClick={refinePrompt}
                    >
                      Aa
                    </button>
                    <button
                      aria-label="添加上下文"
                      className="icon-action"
                      type="button"
                      onClick={() => {
                        onAttachContext();
                        openComposerPalette("context");
                      }}
                    >
                      <Paperclip aria-hidden="true" />
                    </button>
                    <button
                      aria-label="搜索资源"
                      className="icon-action"
                      type="button"
                      onClick={() => openComposerPalette("slash")}
                    >
                      <AtSign aria-hidden="true" />
                    </button>
                    <button
                      aria-label="语音输入"
                      className="icon-action"
                      type="button"
                    >
                      <Mic aria-hidden="true" />
                    </button>
                    <button
                      aria-busy={isSending}
                      aria-label={composerSendLabel}
                      className="send-button"
                      disabled={isSending || !composerValue.trim()}
                      title={composerSendLabel}
                      type="button"
                      onClick={sendComposerValue}
                    >
                      <ArrowUp aria-hidden="true" />
                    </button>
                  </div>
                </div>

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
                  <label
                    className="workspace-picker"
                    data-od-id="workspace-picker"
                  >
                    <span className="visually-hidden">工作空间</span>
                    <select
                      aria-label="工作空间"
                      className="workspace-select"
                      data-workspace-select=""
                      value={workspace}
                      onChange={(event) => setWorkspace(event.target.value)}
                    >
                      <option value={workspace}>{currentWorkspace}</option>
                    </select>
                  </label>
                  <span className="composer-state">{resourceStatus}</span>
                  {connectionState === "disconnected" ? (
                    <button
                      className="button compact"
                      type="button"
                      onClick={onRetryConnection}
                    >
                      重试 app-server
                    </button>
                  ) : null}
                  <span className="composer-state connection-state">
                    <CheckCircle2 aria-hidden="true" />
                    {composerStateLabel}
                  </span>
                </div>
              </section>
            </section>

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
            platformState={platformState}
            snapshot={platformSnapshot}
            onReload={reloadPlatformResources}
            onCatalogFilterChange={setCatalogFilter}
            onCatalogSearchChange={setCatalogSearch}
          />
          <KnowledgeCatalogView
            active={activeView === "knowledge"}
            platformState={platformState}
            snapshot={platformSnapshot}
            onReload={reloadPlatformResources}
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
