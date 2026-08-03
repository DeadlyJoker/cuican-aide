import {
  BookOpen,
  Bot,
  Download,
  Eye,
  Layers3,
  Plus,
  RefreshCw,
  Search,
  Wrench,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  CommandOfficeRoom,
  type CommandOfficeRoomProps,
} from "./CommandOfficeRoom";
import { CommandExpertsPanel } from "./CommandExpertsPanel";
import { CommandWorkflowPanel } from "./CommandWorkflowPanel";
import { SegmentedTabs } from "./SegmentedTabs";
import { classNames } from "./commandWorkspaceUtils";
import {
  capabilityPresetById,
  mcpEditorDraftForPreset,
  mcpPresetSetup,
  orderedCapabilityPresets,
  type CapabilityEditorDraft,
  type CapabilityEditorSaveHandler,
  type CapabilityLocation,
} from "../../lib/capability/capabilityCatalog";
import { CapabilityEditorDialog } from "../catalog/CapabilityEditorDialog";
import { CapabilityLogo } from "../catalog/CapabilityLogo";
import { CatalogResourceDialog } from "../catalog/CatalogResourceDialog";
import {
  installCatalogSkill,
  type CatalogResourceSummary,
} from "../../lib/agent-platform/agentPlatformCatalog";
import type {
  AgentPlatformResourceCategory,
  AgentPlatformResourceState,
  AgentPlatformResourceStates,
  AgentPlatformSnapshot,
  PlatformWorkflow,
  PlatformWorkflowExecution,
} from "../../lib/agent-platform/agentPlatformClient";
import type { ExpertTeamRecordReference } from "../../lib/experts/expertTeamRecord";

type FilterOption = {
  label: string;
  value: string;
  icon?: ReactNode;
};

type CatalogItem = {
  accent: string;
  action?: string;
  detail: string;
  filter: string;
  icon: ReactNode;
  id: string;
  label: string;
  location?: CapabilityLocation;
  logo?: string;
  meta: string[];
  preset?: { id: string; kind: "mcp" | "skill" };
  status?: string;
  statusTone?: "success" | "warn";
  title: string;
  resource?: CatalogResourceSummary;
};

type TeamMode = "office" | "workflow" | "experts";

const resourceCategoryLabels: Record<AgentPlatformResourceCategory, string> = {
  agents: "Agent",
  skills: "技能",
  mcp: "服务",
  knowledge: "知识库",
};

function CatalogCategoryState({
  category,
  count,
  state,
  onRetry,
}: {
  category: AgentPlatformResourceCategory;
  count: number;
  state: AgentPlatformResourceState;
  onRetry: (category: AgentPlatformResourceCategory) => Promise<void>;
}) {
  const label = resourceCategoryLabels[category];
  const inlineLabel = category === "agents" ? ` ${label}` : label;
  const subjectLabel = category === "agents" ? `${label} ` : label;
  const actionLabel = category === "agents" ? ` ${label}` : label;
  if (state.status === "ready" && count > 0) {
    return null;
  }

  let message = `当前账号暂无${inlineLabel}。`;
  if (state.status === "loading") {
    message =
      count > 0
        ? `正在更新${actionLabel}，继续显示上次成功加载的 ${count} 项。`
        : `正在读取当前账号的${inlineLabel}…`;
  } else if (state.status === "error") {
    message =
      count > 0
        ? `${subjectLabel}加载失败，继续显示上次成功加载的 ${count} 项。`
        : `${subjectLabel}暂时无法加载，请重试。`;
  }

  return (
    <div
      className={classNames("catalog-category-state", `is-${state.status}`)}
      data-resource-category={category}
      role={state.status === "error" ? "alert" : "status"}
    >
      <div>
        <strong>{message}</strong>
        {state.status === "error" && state.error ? (
          <span className="catalog-category-error-detail">{state.error}</span>
        ) : null}
      </div>
      {state.status === "error" ? (
        <button
          className="button compact"
          type="button"
          onClick={() => void onRetry(category)}
        >
          {category === "knowledge" ? "重试知识库" : `重试${actionLabel}`}
        </button>
      ) : null}
    </div>
  );
}

function includesQuery(item: CatalogItem, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [item.label, item.title, item.detail, ...item.meta]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

function hasFilter(item: CatalogItem, filter: string) {
  return item.filter.split(/\s+/).includes(filter);
}

function resourceLocation(
  source: CatalogResourceSummary["source"],
): CapabilityLocation {
  return source === "local" ? "local" : "cloud";
}

/*
 * Both aliases resolve to the one segmented control. Source and filter tabs used
 * to look different -- 58px underlines against 28px chips -- even though both
 * switch between a small set of views.
 */
const FilterTabs = SegmentedTabs;
const SourceTabs = SegmentedTabs;

function CatalogSearch({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="catalog-search" aria-label={label}>
      <Search aria-hidden="true" />
      <input
        placeholder={placeholder}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function CatalogCard({
  item,
  progress,
  onDownload,
  onOpen,
  onPreset,
}: {
  item: CatalogItem;
  progress?: number;
  onDownload?: (resource: CatalogResourceSummary) => void;
  onOpen?: (resource: CatalogResourceSummary) => void;
  onPreset?: (preset: { id: string; kind: "mcp" | "skill" }) => void;
}) {
  const resource = item.resource;
  const canDownload = resource?.type === "skills";
  const resourceStatus = resource
    ? resource.type === "skills"
      ? resource.source === "catalog"
        ? resource.update_available
          ? "有更新"
          : resource.downloaded
            ? "云端已同步"
            : "技能 · 可添加"
        : "技能 · 可安装"
      : resource.type === "agents"
        ? resource.enabled && resource.api_enabled
          ? "智能体 · 可用"
          : "智能体 · 只读"
        : resource.type === "mcp_servers"
          ? resource.connected
            ? "服务 · 已连接"
            : "服务 · 未连接"
          : "知识库 · 可检索"
    : null;
  return (
    <article
      className={classNames("catalog-card", item.accent)}
      data-card-filter={item.filter}
      data-od-id={item.id}
    >
      <div
        className={classNames("catalog-icon", item.logo && "has-logo")}
        aria-hidden="true"
      >
        {item.logo ? (
          <CapabilityLogo fallback={String(item.icon)} logo={item.logo} />
        ) : (
          item.icon
        )}
      </div>
      <div className="catalog-card-body">
        <div className="catalog-card-head">
          <span>{item.label}</span>
          <strong>{item.title}</strong>
        </div>
        {item.detail ? <p>{item.detail}</p> : null}
        {resource ? (
          <div className="catalog-resource-meta">
            {item.location ? (
              <span
                className={classNames(
                  "catalog-location-badge",
                  `is-${item.location}`,
                )}
              >
                {item.location === "local" ? "本地" : "云端"}
              </span>
            ) : null}
            <span
              className={classNames(
                "catalog-download-status",
                resource.update_available && "update",
                (resource.downloaded || resource.source !== "catalog") &&
                  "downloaded",
              )}
            >
              {resourceStatus}
            </span>
          </div>
        ) : (
          <div className="catalog-meta">
            {item.location ? (
              <span
                className={classNames(
                  "catalog-location-badge",
                  `is-${item.location}`,
                )}
              >
                {item.location === "local" ? "本地" : "云端"}
              </span>
            ) : null}
            {item.meta.map((meta) => (
              <span key={meta}>{meta}</span>
            ))}
          </div>
        )}
      </div>
      {resource ? (
        <div className="catalog-card-actions">
          <button
            aria-label={`查看 ${item.title}`}
            className="icon-action compact catalog-card-action"
            type="button"
            onClick={() => onOpen?.(resource)}
          >
            <Eye aria-hidden="true" />
          </button>
          {canDownload ? (
            <>
              <button
                aria-label={`${
                  progress !== undefined
                    ? "正在安装"
                    : resource.update_available
                      ? "更新"
                      : resource.downloaded
                        ? "重新安装"
                        : "安装"
                } ${item.title}`}
                className="icon-action compact catalog-card-action"
                disabled={progress !== undefined}
                type="button"
                onClick={() => onDownload?.(resource)}
              >
                {resource.update_available || resource.downloaded ? (
                  <RefreshCw aria-hidden="true" />
                ) : (
                  <Download aria-hidden="true" />
                )}
              </button>
              {progress !== undefined ? (
                <progress max="100" value={progress} />
              ) : null}
            </>
          ) : null}
        </div>
      ) : item.action ? (
        item.preset ? (
          <button
            aria-label={`${item.action} ${item.title}`}
            className="icon-action compact catalog-card-action"
            type="button"
            onClick={() => item.preset && onPreset?.(item.preset)}
          >
            <Plus aria-hidden="true" />
          </button>
        ) : (
          <button className="button compact" type="button">
            {item.action}
          </button>
        )
      ) : item.status ? (
        <span className={classNames("status", item.statusTone)}>
          {item.status}
        </span>
      ) : (
        <button
          className="icon-action compact"
          type="button"
          aria-label={`添加 ${item.title}`}
        >
          +
        </button>
      )}
    </article>
  );
}

function presetCapabilityCatalog(): CatalogItem[] {
  return orderedCapabilityPresets().map((preset) => ({
    accent: preset.kind === "skill" ? "skill-card" : "service-card",
    action: "添加",
    detail: preset.description,
    filter: preset.kind === "skill" ? "skill" : "service",
    icon: preset.glyph,
    id: `crewon:preset:${preset.kind}:${preset.id}`,
    label: preset.kind === "skill" ? "技能" : "服务",
    location: preset.location,
    logo: preset.logo,
    meta: [preset.category, "预制"],
    preset: { id: preset.id, kind: preset.kind },
    title: preset.title,
  }));
}

function syncedAgentCatalog(snapshot: AgentPlatformSnapshot): CatalogItem[] {
  const employees = snapshot.agents.map((agent): CatalogItem => {
    const resource: CatalogResourceSummary = {
      id: agent.id,
      type: "agents",
      name: agent.name,
      description: agent.description || "",
      owner_username: agent.owner_username,
      model: agent.model_info?.model_name || agent.model_info?.name,
      api_enabled: Boolean(agent.api_enabled),
      invocation_url: agent.invocation_url,
      enabled: agent.is_active,
      download_available: false,
      downloaded: agent.downloaded,
      downloaded_at: agent.downloaded_at,
      update_available: agent.update_available,
      source_updated_at: agent.source_updated_at,
      source: agent.resource_source,
    };
    return {
      accent: "employee-card",
      detail: resource.description,
      filter: "employee",
      icon: "A",
      id: `agent-platform:agents:${agent.id}`,
      label: "智能体",
      location: resourceLocation(resource.source),
      logo: "assistant",
      meta: [],
      resource,
      title: agent.name,
    };
  });
  const skills = snapshot.skills.map((skill): CatalogItem => {
    const resource: CatalogResourceSummary = {
      id: skill.id,
      type: "skills",
      name: skill.name,
      description: skill.description || "",
      owner_username: skill.owner_username,
      category: skill.category,
      tags: skill.tags ?? [],
      version: skill.version,
      file_count: skill.file_count ?? 0,
      has_scripts: Boolean(skill.has_scripts),
      download_available: skill.resource_source === "catalog",
      downloaded: skill.downloaded,
      downloaded_at: skill.downloaded_at,
      update_available: skill.update_available,
      source_updated_at: skill.source_updated_at,
      source: skill.resource_source,
    };
    return {
      accent: "skill-card",
      detail: resource.description,
      filter: "skill",
      icon: "S",
      id: `agent-platform:skills:${skill.id}`,
      label: "技能",
      location: resourceLocation(resource.source),
      logo: "skill",
      meta: [],
      resource,
      title: skill.name,
    };
  });
  const services = snapshot.mcpServers.map((server): CatalogItem => {
    const resource: CatalogResourceSummary = {
      id: server.id,
      type: "mcp_servers",
      name: server.alias || server.name,
      description: server.description || "",
      owner_username: server.owner_username,
      category: server.category,
      enabled: server.is_enabled,
      connected: Boolean(server.is_connected),
      tool_count: server.tool_count ?? 0,
      download_available: false,
      downloaded: server.downloaded,
      downloaded_at: server.downloaded_at,
      update_available: server.update_available,
      source_updated_at: server.source_updated_at,
      source: server.resource_source,
    };
    return {
      accent: "service-card",
      detail: resource.description,
      filter: "service",
      icon: "M",
      id: `agent-platform:mcp_servers:${server.id}`,
      label: "服务",
      location: resourceLocation(resource.source),
      logo: "mcp",
      meta: [],
      resource,
      title: resource.name,
    };
  });
  return [...employees, ...skills, ...services];
}

const projectCatalog: CatalogItem[] = [
  {
    accent: "project-card",
    action: "批准",
    detail: "展示任务分解、角色分配、预估时长；批准后进入并行执行。",
    filter: "current gate teamflow",
    icon: "审",
    id: "project-card-requirement-gate",
    label: "Gate",
    meta: ["小队队列", "待批准", "高优先级"],
    title: "需求确认 Gate",
  },
  {
    accent: "project-card",
    detail: "前端实现、测试生成、文档更新并行执行，输出进入共享 Context。",
    filter: "current agent teamflow",
    icon: "并",
    id: "project-card-parallel-nodes",
    label: "Workflow",
    meta: ["小队队列", "3/6", "运行中"],
    status: "运行中",
    statusTone: "success",
    title: "并行任务节点",
  },
  {
    accent: "project-card",
    action: "请求",
    detail: "读取 Issue 前需要 Owner 确认；失败后进入重试 1/3。",
    filter: "current gate teamflow",
    icon: "GH",
    id: "project-card-github-auth",
    label: "MCP",
    meta: ["小队队列", "待授权", "Gate"],
    title: "GitHub MCP 授权",
  },
  {
    accent: "project-card",
    detail: "节点完成后保留文件、报告、权限使用和敏感访问记录。",
    filter: "current handoff teamflow",
    icon: "档",
    id: "project-card-audit-archive",
    label: "Handoff",
    meta: ["小队队列", "交付中", "180 天"],
    status: "待完成",
    title: "产物与审计归档",
  },
  {
    accent: "project-card",
    action: "打开",
    detail: "只保留需要你确认的说明、差异和下一步动作。",
    filter: "current personal",
    icon: "我",
    id: "project-card-my-review",
    label: "Personal",
    meta: ["个人关注", "待审阅", "今天"],
    title: "我的审阅任务",
  },
];

export function ProjectsView({
  active,
  resourceStatus,
}: {
  active: boolean;
  resourceStatus: string;
}) {
  const [projectMode, setProjectMode] = useState("current");
  const [projectSource, setProjectSource] = useState("teamflow");
  const [query, setQuery] = useState("");
  const visibleProjects = projectCatalog.filter(
    (item) =>
      hasFilter(item, projectMode) &&
      hasFilter(item, projectSource) &&
      includesQuery(item, query),
  );

  return (
    <section
      className={classNames("shell-view shell-page-view", active && "active")}
      data-od-id="shell-view-projects"
      data-shell-view="projects"
      hidden={!active}
    >
      <div className="page-stack" data-filter-scope="">
        <header
          className="catalog-market-header function-market-header"
          data-od-id="projects-header-inline"
        >
          <FilterTabs
            active={projectMode}
            group="project-mode"
            label="项目视图筛选"
            options={[
              { label: "当前任务", value: "current" },
              { label: "Gate", value: "gate" },
              { label: "交付", value: "handoff" },
            ]}
            onChange={setProjectMode}
          />
          <div className="catalog-header-actions">
            <CatalogSearch
              label="搜索项目任务"
              placeholder="搜索任务、Gate、MCP"
              value={query}
              onChange={setQuery}
            />
            <button className="button" type="button">
              同步
            </button>
            <button className="button primary" type="button">
              发起任务
            </button>
          </div>
        </header>

        <section
          className="catalog-source-bar"
          data-od-id="project-filters-inline"
        >
          <SourceTabs
            active={projectSource}
            group="project-source"
            label="项目来源筛选"
            options={[
              { label: "小队队列", value: "teamflow" },
              { label: "个人关注", value: "personal" },
            ]}
            onChange={setProjectSource}
          />
          <span className="catalog-context-note">
            Stage Gate：需求确认 · running 56%
          </span>
        </section>

        <section
          className="capability-catalog function-catalog"
          data-od-id="project-task-catalog"
        >
          {visibleProjects.map((item) => (
            <CatalogCard item={item} key={item.id} />
          ))}
          <div
            className="filter-empty-state"
            data-filter-empty=""
            hidden={visibleProjects.length > 0}
          >
            没有匹配项
          </div>
        </section>

        <section className="workspace-grid">
          <section className="page-panel" data-od-id="project-execution-inline">
            <div className="panel-head">
              <h3>Workflow 执行队列</h3>
              <span className="status warn">可中断</span>
            </div>
            <div className="compact-list" id="project-log" aria-live="polite">
              {projectCatalog.slice(0, 4).map((item) => (
                <article
                  className={classNames(
                    "capability-row",
                    item.id.includes("requirement") && "is-priority",
                  )}
                  key={`queue-${item.id}`}
                >
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                  {item.action ? (
                    <button className="button compact" type="button">
                      {item.action}
                    </button>
                  ) : (
                    <span className={classNames("status", item.statusTone)}>
                      {item.status ?? "待完成"}
                    </span>
                  )}
                </article>
              ))}
            </div>
          </section>

          <aside
            className="side-rail"
            data-od-id="project-flow-inspector-inline"
          >
            <section className="rail-panel">
              <div className="panel-head">
                <h3>执行状态机</h3>
                <span className="status">6 态</span>
              </div>
              <div className="step-list">
                {[
                  ["done", "pending · 排队"],
                  ["done", "initialized · 已解析"],
                  ["active", "running · 并行执行"],
                  ["active", "waiting_approval · Gate"],
                  ["", "completed · 交付"],
                  ["", "failed/retrying · 恢复"],
                ].map(([state, label]) => (
                  <div className={classNames("step-row", state)} key={label}>
                    <span />
                    <strong>{label}</strong>
                  </div>
                ))}
              </div>
            </section>
            <section className="rail-panel">
              <div className="panel-head">
                <h3>节点类型</h3>
                <span className="status">start/task/gate</span>
              </div>
              <div className="compact-list">
                {[
                  ["start -> task", "接收需求后拆成可执行节点。", "核心"],
                  [
                    "parallel -> merge",
                    "并行分发给多个角色，合并为共享上下文。",
                    "并行",
                  ],
                  [
                    "gate -> end",
                    "人类确认关键决策，再进入交付或回退。",
                    "卡点",
                  ],
                ].map(([title, detail, status]) => (
                  <div className="capability-row" key={title}>
                    <div>
                      <strong>{title}</strong>
                      <p>{detail}</p>
                    </div>
                    <span
                      className={classNames(
                        "status",
                        status === "卡点" && "warn",
                      )}
                    >
                      {status}
                    </span>
                  </div>
                ))}
              </div>
            </section>
            <section className="rail-panel">
              <div className="panel-head">
                <h3>最小上下文</h3>
                <span className="status success">已锁定</span>
              </div>
              <p>
                只传 PRD 能力域、当前页面壳、审批策略，不把完整历史对话塞给
                Agent。
              </p>
              <p>{resourceStatus}</p>
            </section>
          </aside>
        </section>
      </div>
    </section>
  );
}

export function AgentsView({
  active,
  catalogFilter,
  catalogSearch,
  platformState,
  resourceStates,
  snapshot,
  onReload,
  onCatalogFilterChange,
  onCatalogSearchChange,
  onSaveCapability,
}: {
  active: boolean;
  catalogFilter: string;
  catalogSearch: string;
  platformState: "loading" | "ready" | "fallback";
  resourceStates: AgentPlatformResourceStates;
  snapshot: AgentPlatformSnapshot;
  onReload: (category?: AgentPlatformResourceCategory) => Promise<void>;
  onCatalogFilterChange: (filter: string) => void;
  onCatalogSearchChange: (query: string) => void;
  onSaveCapability?: CapabilityEditorSaveHandler;
}) {
  const [selectedResource, setSelectedResource] = useState<{
    resource: CatalogResourceSummary;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({});
  const [editorDraft, setEditorDraft] = useState<CapabilityEditorDraft | null>(
    null,
  );
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorAuthorizationUrl, setEditorAuthorizationUrl] = useState<
    string | null
  >(null);
  const [locationFilter, setLocationFilter] = useState<
    "all" | CapabilityLocation
  >("all");
  const syncedCards = useMemo(() => syncedAgentCatalog(snapshot), [snapshot]);
  const presetCards = useMemo(presetCapabilityCatalog, []);
  const cards = useMemo(
    () => [...presetCards, ...syncedCards],
    [presetCards, syncedCards],
  );
  const visibleCards = cards.filter(
    (item) =>
      (catalogFilter === "all" || hasFilter(item, catalogFilter)) &&
      (locationFilter === "all" || item.location === locationFilter) &&
      includesQuery(item, catalogSearch),
  );
  const displayedCategories: AgentPlatformResourceCategory[] =
    catalogFilter === "employee"
      ? ["agents"]
      : catalogFilter === "skill"
        ? ["skills"]
        : catalogFilter === "service"
          ? ["mcp"]
          : ["agents", "skills", "mcp"];
  const categoryCounts: Record<AgentPlatformResourceCategory, number> = {
    agents: snapshot.agents.length,
    skills:
      snapshot.skills.length +
      presetCards.filter((item) => item.preset?.kind === "skill").length,
    mcp:
      snapshot.mcpServers.length +
      presetCards.filter((item) => item.preset?.kind === "mcp").length,
    knowledge: snapshot.knowledgeBases.length,
  };
  const selectedCardCount = displayedCategories.reduce(
    (total, category) => total + categoryCounts[category],
    0,
  );
  const stateCategories = displayedCategories.filter(
    (category) =>
      resourceStates[category].status !== "ready" ||
      categoryCounts[category] === 0,
  );

  async function refresh() {
    setRefreshing(true);
    try {
      await onReload();
    } finally {
      setRefreshing(false);
    }
  }

  async function download(resource: CatalogResourceSummary) {
    if (resource.type !== "skills") {
      setDownloadError("只有技能可以安装");
      return;
    }
    const key = `${resource.type}:${resource.id}`;
    setDownloadProgress((current) => ({ ...current, [key]: 1 }));
    setDownloadError(null);
    try {
      if (!onSaveCapability) {
        throw new Error("App Server 未连接，无法安装技能到当前工作区");
      }
      await installCatalogSkill(resource, onSaveCapability);
      await onReload();
    } catch (reason) {
      setDownloadError(
        reason instanceof Error ? reason.message : "资源下载失败",
      );
    } finally {
      setDownloadProgress((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  function openBlankEditor(kind: "mcp" | "skill") {
    setEditorError(null);
    setEditorAuthorizationUrl(null);
    setEditorDraft(
      kind === "skill"
        ? {
            kind,
            name: "new-skill",
            description: "可复用的 CrewON 工作流。",
            workflow:
              "- 确认目标、输入和验收标准。\n- 按步骤执行并保留证据。\n- 输出结果、风险和验证记录。",
          }
        : mcpEditorDraftForPreset("filesystem"),
    );
  }

  function openPresetEditor(preset: { id: string; kind: "mcp" | "skill" }) {
    const definition = capabilityPresetById(preset.id, preset.kind);
    if (!definition) {
      return;
    }
    setEditorError(null);
    setEditorAuthorizationUrl(null);
    setEditorDraft(
      definition.kind === "skill"
        ? {
            kind: "skill",
            name: definition.id,
            description: definition.description,
            workflow: definition.workflow,
          }
        : mcpEditorDraftForPreset(definition.id),
    );
  }

  async function saveEditorDraft() {
    if (!editorDraft || !onSaveCapability) {
      return;
    }
    const oauthWindow =
      editorDraft.kind === "mcp" &&
      mcpPresetSetup(editorDraft.presetId).oauth &&
      typeof window !== "undefined"
        ? window.open("about:blank", "crewon-mcp-oauth")
        : null;
    setEditorBusy(true);
    setEditorError(null);
    setEditorAuthorizationUrl(null);
    try {
      const result = await onSaveCapability(editorDraft);
      if (result?.authorizationUrl) {
        if (oauthWindow) {
          oauthWindow.opener = null;
          oauthWindow.location.href = result.authorizationUrl;
        } else {
          setEditorAuthorizationUrl(result.authorizationUrl);
          setEditorError(
            "登录窗口被浏览器拦截，请点击“继续登录授权”完成连接。",
          );
          return;
        }
      } else {
        oauthWindow?.close();
      }
      setEditorDraft(null);
    } catch (error) {
      oauthWindow?.close();
      setEditorError(error instanceof Error ? error.message : "保存能力失败");
    } finally {
      setEditorBusy(false);
    }
  }

  return (
    <section
      className={classNames("shell-view shell-page-view", active && "active")}
      data-filter-scope=""
      data-od-id="shell-view-agents"
      data-shell-view="agents"
      hidden={!active}
    >
      <div className="page-stack" data-filter-scope="">
        <header
          className="catalog-market-header"
          data-od-id="agents-header-inline"
        >
          <FilterTabs
            active={catalogFilter}
            group="category"
            label="能力分类筛选"
            options={[
              {
                icon: <Bot aria-hidden="true" />,
                label: "智能体",
                value: "employee",
              },
              {
                icon: <Wrench aria-hidden="true" />,
                label: "技能",
                value: "skill",
              },
              {
                icon: <Layers3 aria-hidden="true" />,
                label: "服务",
                value: "service",
              },
            ]}
            onChange={onCatalogFilterChange}
          />
          <div className="catalog-header-actions">
            <CatalogSearch
              label="搜索能力"
              placeholder="搜索智能体、技能或服务"
              value={catalogSearch}
              onChange={onCatalogSearchChange}
            />
            <button
              className="button compact"
              disabled={refreshing}
              type="button"
              onClick={refresh}
            >
              {refreshing ? "更新中…" : "刷新资源"}
            </button>
            <button
              className="button compact"
              type="button"
              onClick={() => openBlankEditor("skill")}
            >
              创建技能
            </button>
            <button
              className="button compact primary"
              type="button"
              onClick={() => openBlankEditor("mcp")}
            >
              创建服务
            </button>
          </div>
        </header>

        <div
          className="catalog-location-filter"
          role="group"
          aria-label="运行位置筛选"
        >
          <span>运行位置</span>
          {(["all", "local", "cloud"] as const).map((location) => (
            <button
              aria-pressed={locationFilter === location}
              className={classNames(
                "catalog-location-filter-button",
                locationFilter === location && "active",
              )}
              key={location}
              type="button"
              onClick={() => setLocationFilter(location)}
            >
              {location === "all"
                ? "全部"
                : location === "local"
                  ? "本地"
                  : "云端"}
            </button>
          ))}
          <span className="catalog-location-summary">
            本地 {cards.filter((item) => item.location === "local").length} ·
            云端 {cards.filter((item) => item.location === "cloud").length}
          </span>
        </div>

        {downloadError ? (
          <p className="catalog-download-error" role="alert">
            {downloadError}
          </p>
        ) : null}
        {stateCategories.length > 0 ? (
          <div className="catalog-category-states">
            {stateCategories.map((category) => (
              <CatalogCategoryState
                category={category}
                count={categoryCounts[category]}
                key={category}
                state={resourceStates[category]}
                onRetry={onReload}
              />
            ))}
          </div>
        ) : null}
        <section
          className="capability-catalog"
          data-od-id="agent-capability-catalog"
          data-catalog-filter={catalogFilter}
        >
          {visibleCards.map((item) => (
            <CatalogCard
              item={item}
              key={item.id}
              progress={
                item.resource
                  ? downloadProgress[
                      `${item.resource.type}:${item.resource.id}`
                    ]
                  : undefined
              }
              onDownload={download}
              onOpen={(resource) => setSelectedResource({ resource })}
              onPreset={openPresetEditor}
            />
          ))}
          {visibleCards.length === 0 && selectedCardCount > 0 ? (
            <div
              className="filter-empty-state"
              data-filter-empty=""
              role="status"
            >
              没有匹配项
            </div>
          ) : null}
        </section>
      </div>
      <CatalogResourceDialog
        resource={selectedResource?.resource ?? null}
        onClose={() => setSelectedResource(null)}
        onInstallSkill={download}
        onRefresh={refresh}
      />
      <CapabilityEditorDialog
        authorizationUrl={editorAuthorizationUrl}
        busy={editorBusy}
        draft={editorDraft}
        error={editorError}
        onChange={setEditorDraft}
        onClose={() => {
          if (!editorBusy) {
            setEditorDraft(null);
            setEditorAuthorizationUrl(null);
          }
        }}
        onSave={saveEditorDraft}
      />
    </section>
  );
}

export function KnowledgeCatalogView({
  active,
  resourceStates,
  snapshot,
  onReload,
}: {
  active: boolean;
  platformState: "loading" | "ready" | "fallback";
  resourceStates: AgentPlatformResourceStates;
  snapshot: AgentPlatformSnapshot;
  onReload: (category?: AgentPlatformResourceCategory) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [selectedResource, setSelectedResource] = useState<{
    resource: CatalogResourceSummary;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [locationFilter, setLocationFilter] = useState<
    "all" | CapabilityLocation
  >("all");
  const cards = snapshot.knowledgeBases.map((knowledgeBase): CatalogItem => {
    const resource: CatalogResourceSummary = {
      id: knowledgeBase.id,
      type: "knowledge_bases",
      name: knowledgeBase.name,
      description: knowledgeBase.description || "",
      owner_username: knowledgeBase.owner_username,
      document_count: knowledgeBase.document_count ?? 0,
      chunk_count: knowledgeBase.chunk_count ?? 0,
      embedding_model: knowledgeBase.embedding_model,
      download_available: false,
      downloaded: knowledgeBase.downloaded,
      downloaded_at: knowledgeBase.downloaded_at,
      update_available: knowledgeBase.update_available,
      source_updated_at: knowledgeBase.source_updated_at,
      source: knowledgeBase.resource_source,
    };
    return {
      accent: "knowledge-card",
      detail: resource.description,
      filter: "knowledge personal",
      icon: "KB",
      id: `agent-platform:knowledge_bases:${knowledgeBase.id}`,
      label: "知识库",
      location: resourceLocation(resource.source),
      logo: "knowledge",
      meta: [],
      resource,
      title: knowledgeBase.name,
    };
  });
  const visibleCards = cards.filter(
    (item) =>
      (locationFilter === "all" || item.location === locationFilter) &&
      includesQuery(item, query),
  );
  const localCount = cards.filter((item) => item.location === "local").length;
  const cloudCount = cards.filter((item) => item.location === "cloud").length;

  async function refresh() {
    setRefreshing(true);
    try {
      await onReload();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section
      className={classNames("shell-view shell-page-view", active && "active")}
      data-shell-view="knowledge"
      hidden={!active}
    >
      <div className="page-stack">
        <header className="catalog-market-header">
          <div className="catalog-mode-tabs" aria-label="知识库分类">
            <span className="filter-chip mode-tab active">
              <BookOpen aria-hidden="true" />
              <span>知识库</span>
            </span>
          </div>
          <div className="catalog-header-actions">
            <CatalogSearch
              label="搜索知识库"
              placeholder="搜索知识库名称或描述"
              value={query}
              onChange={setQuery}
            />
            <button
              className="button compact"
              disabled={refreshing}
              type="button"
              onClick={refresh}
            >
              {refreshing ? "更新中…" : "刷新资源"}
            </button>
          </div>
        </header>
        <div
          className="catalog-location-filter"
          role="group"
          aria-label="运行位置筛选"
        >
          <span>运行位置</span>
          {(
            [
              ["all", "全部"],
              ["local", "本地"],
              ["cloud", "云端"],
            ] as const
          ).map(([value, label]) => (
            <button
              aria-pressed={locationFilter === value}
              className={classNames(
                "catalog-location-filter-button",
                locationFilter === value && "active",
              )}
              key={value}
              type="button"
              onClick={() => setLocationFilter(value)}
            >
              {label}
            </button>
          ))}
          <span className="catalog-location-summary">
            本地 {localCount} · 云端 {cloudCount}
          </span>
        </div>
        {resourceStates.knowledge.status !== "ready" || cards.length === 0 ? (
          <div className="catalog-category-states">
            <CatalogCategoryState
              category="knowledge"
              count={cards.length}
              state={resourceStates.knowledge}
              onRetry={onReload}
            />
          </div>
        ) : null}
        <section
          className="capability-catalog knowledge-catalog"
          data-catalog-filter="knowledge"
        >
          {visibleCards.map((item) => (
            <CatalogCard
              item={item}
              key={item.id}
              onOpen={(resource) => setSelectedResource({ resource })}
            />
          ))}
          {visibleCards.length === 0 && cards.length > 0 ? (
            <div className="filter-empty-state" role="status">
              没有匹配的知识库
            </div>
          ) : null}
        </section>
      </div>
      <CatalogResourceDialog
        resource={selectedResource?.resource ?? null}
        onClose={() => setSelectedResource(null)}
        onRefresh={refresh}
      />
    </section>
  );
}

function TeamCapabilityUnavailable({
  boundary,
  description,
  title,
  workspaceCwd,
}: {
  boundary: string;
  description: string;
  title: string;
  workspaceCwd: string;
}) {
  return (
    <section
      className="team-office-empty team-capability-unavailable"
      data-team-capability-state="backend-unavailable"
    >
      <header className="team-office-empty-head">
        <span className="team-office-empty-kicker">REAL RUNTIME REQUIRED</span>
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <div className="team-office-capability-grid" aria-label="接入要求">
        <article className="team-office-capability">
          <div>
            <strong>真实定义</strong>
            <p>只展示服务端返回的配置、成员和授权资源。</p>
          </div>
        </article>
        <article className="team-office-capability">
          <div>
            <strong>真实运行态</strong>
            <p>创建、执行、恢复和状态更新全部经过 App Server。</p>
          </div>
        </article>
        <article className="team-office-capability">
          <div>
            <strong>{boundary}</strong>
            <p title={workspaceCwd}>{workspaceCwd || "使用默认执行环境"}</p>
          </div>
        </article>
      </div>
      <footer className="team-office-empty-footer">
        <span
          className="team-office-connection-state"
          data-state="unavailable"
          role="status"
        >
          未展示演示数据，创建入口已安全关闭
        </span>
      </footer>
    </section>
  );
}

export function TeamView({
  active,
  officeRuntime,
  officeRoomId,
  teamMode,
  workflows,
  expertTeams,
  expertTeamsStatus,
  onCreateOffice,
  onCreateWorkflow,
  onCreateExpertTeam,
  onRefresh,
  onReloadWorkflows,
  onRunWorkflow,
  onSelectExpert,
  onTeamModeChange,
}: {
  active: boolean;
  officeRuntime: Omit<CommandOfficeRoomProps, "isOpen"> | null;
  officeRoomId: string | null;
  teamMode: TeamMode;
  workflows: PlatformWorkflow[];
  expertTeams: ExpertTeamRecordReference[];
  expertTeamsStatus: "loading" | "ready" | "unavailable";
  onCreateOffice?: () => void;
  onCreateWorkflow?: () => void;
  onCreateExpertTeam?: () => void;
  onRefresh?: () => void;
  onReloadWorkflows: () => Promise<void>;
  onRunWorkflow: (
    workflow: PlatformWorkflow,
    input: string,
  ) => Promise<PlatformWorkflowExecution>;
  onSelectExpert: (record: ExpertTeamRecordReference) => void;
  onTeamModeChange: (mode: TeamMode) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowRoomOpen, setWorkflowRoomOpen] = useState(false);
  const officeStatus = officeRuntime?.status ?? "unavailable";
  return (
    <section
      className={classNames(
        "shell-view shell-page-view",
        active && "active",
        officeRoomId && "office-room-active",
        workflowRoomOpen && "workflow-room-active",
      )}
      data-filter-scope=""
      data-od-id="shell-view-team"
      data-shell-view="team"
      hidden={!active}
    >
      <div className="page-stack" data-filter-scope="">
        <header
          className="catalog-market-header function-market-header"
          data-od-id="team-header-inline"
        >
          <FilterTabs
            active={teamMode}
            group="team-mode"
            label="团队视图筛选"
            options={[
              { label: "办公室", value: "office" },
              { label: "协作流", value: "workflow" },
              { label: "专家团", value: "experts" },
            ]}
            onChange={(value) => {
              const nextMode = value as TeamMode;
              if (nextMode !== "workflow") {
                setWorkflowRoomOpen(false);
              }
              onTeamModeChange(nextMode);
            }}
          />
          <div className="catalog-header-actions">
            {teamMode === "office" ? (
              <CatalogSearch
                label="搜索办公室"
                placeholder="搜索办公室、目标或成员"
                value={searchQuery}
                onChange={setSearchQuery}
              />
            ) : null}
            <button
              className="button"
              type="button"
              disabled={!onRefresh || officeStatus === "loading"}
              hidden={teamMode !== "office"}
              onClick={onRefresh}
            >
              {officeStatus === "loading" ? "同步中…" : "同步真实数据"}
            </button>
            {teamMode === "workflow" && onCreateWorkflow ? (
              <button
                className="button primary"
                type="button"
                data-team-action="workflow"
                onClick={onCreateWorkflow}
              >
                创建协作流
              </button>
            ) : null}
            <button
              className="button primary"
              type="button"
              data-team-action="office"
              disabled={!onCreateOffice}
              hidden={teamMode !== "office"}
              onClick={onCreateOffice}
            >
              创建办公室
            </button>
            <button
              className="button primary"
              type="button"
              data-team-action="experts"
              disabled={!onCreateExpertTeam}
              hidden={teamMode !== "experts"}
              onClick={onCreateExpertTeam}
            >
              创建专家团
            </button>
          </div>
        </header>

        {teamMode === "office" || officeRoomId ? (
          <section
            className={classNames(
              "team-office-shell",
              officeRoomId && "is-room-open",
            )}
            data-card-filter="office"
            data-office-shell=""
            data-od-id="team-office-shell"
          >
            {officeRuntime ? (
              <CommandOfficeRoom
                {...officeRuntime}
                isOpen={Boolean(officeRoomId)}
                query={searchQuery}
              />
            ) : (
              <CommandOfficeRoom
                isOpen={false}
                query={searchQuery}
                records={[]}
                room={null}
                selectedRecordKey={null}
                status="unavailable"
                onOpen={() => undefined}
              />
            )}
          </section>
        ) : null}

        <section
          className={classNames(
            "team-workflow-shell",
            workflowRoomOpen && "is-room-open",
          )}
          data-card-filter="workflow"
          data-od-id="team-workflow-shell"
          data-workflow-shell=""
          hidden={teamMode !== "workflow"}
        >
          <CommandWorkflowPanel
            workflows={workflows}
            onReload={onReloadWorkflows}
            onRun={onRunWorkflow}
            onRoomOpenChange={setWorkflowRoomOpen}
          />
        </section>

        <section
          className="team-experts-shell"
          data-card-filter="experts"
          data-od-id="team-experts-shell"
          hidden={teamMode !== "experts"}
        >
          <CommandExpertsPanel
            records={expertTeams}
            onSelect={onSelectExpert}
          />
          {expertTeamsStatus === "loading" ? (
            <div className="team-capability-inline-status" role="status">
              正在读取专家团…
            </div>
          ) : expertTeamsStatus === "unavailable" ? (
            <div
              className="team-capability-inline-status is-error"
              role="status"
            >
              专家团服务暂时不可用，请确认当前工作空间已注册。
            </div>
          ) : null}
        </section>

        <div id="team-log" className="sr-log" aria-live="polite" />
      </div>
    </section>
  );
}
