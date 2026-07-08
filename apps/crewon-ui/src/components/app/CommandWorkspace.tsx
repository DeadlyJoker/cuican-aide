import { ArrowUp, AtSign, CheckCircle2, Mic, Paperclip } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  officeRooms,
  quickScenarios,
  sceneTabs,
  workspaceNodes,
  workflowRooms,
} from "./commandWorkspaceData";
import {
  CommandSidebar,
  Palette,
  ResourceDock,
  type PaletteItemWithCommand,
} from "./CommandWorkspaceChrome";
import {
  AgentsView,
  AssistView,
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
import type { WorkMode } from "../../lib/workMode";

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
  composerValue: string;
  connectionState: ConnectionState;
  cwd: string;
  isSending: boolean;
  locale?: Locale;
  slashCommands?: ComposerSlashCommand[];
  workMode: WorkMode;
  onAttachContext: () => void;
  onChangeComposerValue: (value: string) => void;
  onModeChange: (mode: WorkMode) => void;
  onRetryConnection: () => void;
  onSend: (text: string) => void;
  onSlashCommandSelect?: (command: ComposerSlashCommand) => void;
};


type PlatformLoadState = "loading" | "ready" | "fallback";
type TeamMode = "office" | "workflow" | "experts";

const shellViewIds: CommandShellView[] = [
  "command",
  "assist",
  "projects",
  "agents",
  "schedule",
  "team",
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

function contextItems(slots: CommandHomeSlots, cwd: string): PaletteItemWithCommand[] {
  return [
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
    {
      kind: "agent",
      label: "智能体",
      title: slots.agent.title,
      detail: slots.agent.detail,
    },
    {
      kind: "knowledge",
      label: "知识库",
      title: "Knowledge base",
      detail: "团队文档、项目材料、长期记忆和可引用资源",
    },
  ];
}

function slashItems(
  slots: CommandHomeSlots,
  slashCommands: ComposerSlashCommand[],
): PaletteItemWithCommand[] {
  const commandItems: PaletteItemWithCommand[] = slashCommands.map((command) => ({
    command,
    detail: command.description,
    kind: command.kind === "mcp" ? "mcp" : command.kind === "skill" ? "skill" : "agent",
    label: command.meta,
    title: command.label,
    token: command.token,
  }));
  const fallbackItems: PaletteItemWithCommand[] = [
    ...slots.skills.map((item) => ({
      detail: item.detail,
      kind: "skill" as const,
      label: item.label,
      title: item.title,
      token: item.title,
    })),
    ...slots.mcps.map((item) => ({
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
  composerValue,
  connectionState,
  cwd,
  isSending,
  locale = "zh",
  slashCommands = [],
  workMode,
  onAttachContext,
  onChangeComposerValue,
  onModeChange,
  onRetryConnection,
  onSend,
  onSlashCommandSelect,
}: CommandWorkspaceProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeView, setActiveView] = useState<CommandShellView>(() =>
    shellViewFromHash(),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeSpaceId, setActiveSpaceId] = useState("product");
  const [activeConversation, setActiveConversation] = useState("小队创建草稿");
  const [scene, setScene] = useState<CommandScene>(
    workMode === "office" ? "office" : "code",
  );
  const [composerMode, setComposerMode] = useState("plan");
  const [model, setModel] = useState("auto");
  const [agent, setAgent] = useState("product-review");
  const [permission, setPermission] = useState("approve-for-me");
  const [workspace, setWorkspace] = useState("product");
  const [openPalette, setOpenPalette] = useState<"context" | "slash" | null>(
    null,
  );
  const [paletteQuery, setPaletteQuery] = useState("");
  const [platformState, setPlatformState] =
    useState<PlatformLoadState>("loading");
  const [platformSnapshot, setPlatformSnapshot] = useState<AgentPlatformSnapshot>(
    emptyAgentPlatformSnapshot,
  );
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
    onSend(trimmed);
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
    if (event.key === "Escape" && openPalette) {
      event.preventDefault();
      closeComposerPalette();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      sendComposerValue();
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === "@") {
        event.preventDefault();
        openComposerPalette("context");
      } else if (
        event.key === "/" &&
        (!composerValue || /\s$/.test(composerValue))
      ) {
        event.preventDefault();
        openComposerPalette("slash");
      }
    }
  }

  function toggleSpace(spaceId: string) {
    setCollapsedSpaces((current) => {
      const next = new Set(current);
      if (next.has(spaceId)) {
        next.delete(spaceId);
      } else {
        next.add(spaceId);
      }
      return next;
    });
  }

  function chooseConversation(spaceId: string, conversation: string) {
    setActiveSpaceId(spaceId);
    setActiveConversation(conversation);
    setWorkspace(spaceId);
  }

  const currentWorkspace =
    workspaceNodes.find((node) => node.id === activeSpaceId)?.title ??
    "Agent 小队交付空间";
  const activeOfficeRoom =
    officeRooms.find((room) => room.id === officeRoomId) ?? officeRooms[0];
  const activeWorkflowRoom =
    workflowRooms.find((room) => room.id === workflowRoomId) ?? workflowRooms[0];

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
          activeConversation={activeConversation}
          activeSpaceId={activeSpaceId}
          activeView={activeView}
          collapsedSpaces={collapsedSpaces}
          isSearchOpen={sidebarSearchOpen}
          query={sidebarSearchQuery}
          slots={slots}
          onChooseConversation={chooseConversation}
          onQueryChange={setSidebarSearchQuery}
          onSwitchView={switchView}
          onToggleCollapse={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onToggleSearch={() => setSidebarSearchOpen((open) => !open)}
          onToggleSpace={toggleSpace}
        />

        <section className="command-canvas" data-od-id="desktop-main-pane">
          <section
            className={classNames(
              "shell-view command-home-view",
              activeView === "command" && "active",
            )}
            data-shell-view="command"
            data-shell-view-title-zh="新建任务"
            data-shell-view-title-en="New task"
            data-od-id="shell-view-command"
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

            <section className="hero-center" data-od-id="primary-work-area">
              <header className="home-title" data-od-id="desktop-command-header">
                <h1>
                  <span>Crewon</span>
                  <br />
                  <span>创建可编排的 Agent 小队</span>
                </h1>
              </header>

              <div className="scene-tabs scene-pills" data-od-id="scene-tabs">
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

              <section className="command-input" data-od-id="ai-composer">
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
                  <div className="composer-controls" data-od-id="composer-control-row">
                    <label className="control-select mode-dropdown">
                      <span className="visually-hidden">任务类型</span>
                      <select
                        aria-label="任务类型"
                        data-task-mode=""
                        value={composerMode}
                        onChange={(event) => setComposerMode(event.target.value)}
                      >
                        <option value="plan">计划</option>
                        <option value="goal">目标</option>
                        <option value="agent">智能体</option>
                      </select>
                    </label>
                    <label className="control-select model-dropdown">
                      <span className="visually-hidden">模型选择</span>
                      <select
                        aria-label="模型选择"
                        data-model-select=""
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                      >
                        <option value="auto">自动选择</option>
                        <option value="fast">快速模型</option>
                        <option value="reasoning">推理模型</option>
                        <option value="vision">视觉模型</option>
                      </select>
                    </label>
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
                        <option value="product-review">{slots.agent.title}</option>
                        <option value="engineering-handoff">开发交付智能体</option>
                        <option value="visual-polish">视觉打磨智能体</option>
                        <option value="meeting-prep">会议准备智能体</option>
                      </select>
                    </label>
                    <label
                      className={classNames(
                        "control-select permission-dropdown",
                        permission === "full-access" && "is-warning",
                      )}
                    >
                      <span className="visually-hidden">权限选择</span>
                      <select
                        aria-label="权限选择"
                        data-permission-select=""
                        value={permission}
                        onChange={(event) => setPermission(event.target.value)}
                      >
                        <option value="approve-for-me">替我审批</option>
                        <option value="request-approval">请求批准</option>
                        <option value="full-access">完全访问</option>
                      </select>
                    </label>
                  </div>

                  <div className="composer-actions" data-od-id="composer-action-row">
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
                      aria-label="发送任务"
                      className="send-button"
                      disabled={isSending || !composerValue.trim()}
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
                  <label className="workspace-picker" data-od-id="workspace-picker">
                    <span className="visually-hidden">工作空间</span>
                    <select
                      aria-label="工作空间"
                      className="workspace-select"
                      data-workspace-select=""
                      value={workspace}
                      onChange={(event) => setWorkspace(event.target.value)}
                    >
                      {workspaceNodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="composer-state">{resourceStatus}</span>
                  {connectionState === "disconnected" ? (
                    <button className="button compact" type="button" onClick={onRetryConnection}>
                      重试 app-server
                    </button>
                  ) : null}
                  <span className="composer-state connection-state">
                    <CheckCircle2 aria-hidden="true" />
                    {isSending
                      ? "发送中"
                      : composerValue.trim()
                        ? "草稿未发送"
                        : connectionLabel(connectionState)}
                  </span>
                </div>
              </section>
            </section>

            <ResourceDock slots={slots} platformState={platformState} />
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
