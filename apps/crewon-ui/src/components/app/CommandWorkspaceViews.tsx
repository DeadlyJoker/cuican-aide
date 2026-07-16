import {
  BookOpen,
  Bot,
  Layers3,
  Search,
  Wrench,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  CommandOfficeRoom,
  type CommandOfficeRoomProps,
} from "./CommandOfficeRoom";
import { classNames } from "./commandWorkspaceUtils";
import { CatalogResourceDialog } from "../catalog/CatalogResourceDialog";
import {
  downloadCatalogResource,
  type CatalogResourceSummary,
} from "../../lib/agent-platform/agentPlatformCatalog";
import type {
  AgentPlatformResourceCategory,
  AgentPlatformResourceState,
  AgentPlatformResourceStates,
  AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";

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
  meta: string[];
  status?: string;
  statusTone?: "success" | "warn";
  title: string;
  resource?: CatalogResourceSummary;
};

type TeamMode = "office" | "workflow" | "experts";

const resourceCategoryLabels: Record<AgentPlatformResourceCategory, string> = {
  agents: "Agent",
  skills: "Skill",
  mcp: "MCP",
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
  const inlineLabel = category === "knowledge" ? label : ` ${label}`;
  const subjectLabel = category === "knowledge" ? label : `${label} `;
  if (state.status === "ready" && count > 0) {
    return null;
  }

  let message = `当前账号暂无${inlineLabel}。`;
  if (state.status === "loading") {
    message =
      count > 0
        ? `正在更新 ${label}，继续显示上次成功加载的 ${count} 项。`
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
          {category === "knowledge" ? "重试知识库" : `重试 ${label}`}
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

function FilterTabs({
  active,
  group,
  label,
  options,
  onChange,
}: {
  active: string;
  group: string;
  label: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="catalog-mode-tabs" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          aria-pressed={active === option.value}
          className={classNames(
            "filter-chip mode-tab",
            active === option.value && "active",
          )}
          data-filter-group={group}
          data-filter={option.value}
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function SourceTabs({
  active,
  group,
  label,
  options,
  onChange,
}: {
  active: string;
  group: string;
  label: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="catalog-source-tabs" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          aria-pressed={active === option.value}
          className={classNames(
            "filter-chip source-tab",
            active === option.value && "active",
          )}
          data-filter-group={group}
          data-filter={option.value}
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

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
}: {
  item: CatalogItem;
  progress?: number;
  onDownload?: (resource: CatalogResourceSummary) => void;
  onOpen?: (resource: CatalogResourceSummary) => void;
}) {
  const resource = item.resource;
  const canDownload =
    resource?.type === "skills" &&
    resource.source === "catalog" &&
    resource.download_available !== false;
  const resourceStatus = resource
    ? resource.type === "skills"
        ? resource.source === "catalog"
        ? resource.update_available
          ? "有更新"
          : resource.downloaded
            ? "已下载"
            : "可下载"
        : "在线 Skill"
      : resource.type === "agents"
        ? resource.enabled && resource.api_enabled
          ? "在线 Agent"
          : "在线 · 只读"
        : resource.type === "mcp_servers"
          ? resource.connected
            ? "在线 · 已连接"
            : "在线 · 未连接"
          : "在线 · 只读"
    : null;
  return (
    <article
      className={classNames("catalog-card", item.accent)}
      data-card-filter={item.filter}
      data-od-id={item.id}
    >
      <div className="catalog-icon" aria-hidden="true">
        {item.icon}
      </div>
      <div className="catalog-card-body">
        <div className="catalog-card-head">
          <span>{item.label}</span>
          <strong>{item.title}</strong>
        </div>
        {item.detail ? <p>{item.detail}</p> : null}
        {resource ? (
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
        ) : (
          <div className="catalog-meta">
            {item.meta.map((meta) => (
              <span key={meta}>{meta}</span>
            ))}
          </div>
        )}
      </div>
      {resource ? (
        <div className="catalog-card-actions">
          <button
            className="button compact"
            type="button"
            onClick={() => onOpen?.(resource)}
          >
            查看
          </button>
          {canDownload ? (
            <>
              <button
                className="button compact"
                disabled={
                  progress !== undefined ||
                  (Boolean(resource.downloaded) && !resource.update_available)
                }
                type="button"
                onClick={() => onDownload?.(resource)}
              >
                {progress !== undefined
                  ? "下载中…"
                  : resource.update_available
                    ? "更新"
                    : resource.downloaded
                      ? "已下载"
                      : "下载"}
              </button>
              {progress !== undefined ? (
                <progress max="100" value={progress} />
              ) : null}
            </>
          ) : null}
        </div>
      ) : item.action ? (
        <button className="button compact" type="button">
          {item.action}
        </button>
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
      label: "员工",
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
}) {
  const [selectedResource, setSelectedResource] = useState<{
    resource: CatalogResourceSummary;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({});
  const syncedCards = useMemo(() => syncedAgentCatalog(snapshot), [snapshot]);
  const cards = syncedCards;
  const visibleCards = cards.filter(
    (item) =>
      (catalogFilter === "all" || hasFilter(item, catalogFilter)) &&
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
    skills: snapshot.skills.length,
    mcp: snapshot.mcpServers.length,
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
    if (resource.type !== "skills" || resource.source !== "catalog") {
      setDownloadError("只有目录 Skill 可以下载");
      return;
    }
    const key = `${resource.type}:${resource.id}`;
    setDownloadProgress((current) => ({ ...current, [key]: 1 }));
    setDownloadError(null);
    try {
      await downloadCatalogResource("skills", resource.id);
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
                label: "员工",
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
              placeholder="搜索员工、技能或服务"
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
          </div>
        </header>

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
        onRefresh={refresh}
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
      icon: <BookOpen aria-hidden="true" />,
      id: `agent-platform:knowledge_bases:${knowledgeBase.id}`,
      label: "知识库",
      meta: [],
      resource,
      title: knowledgeBase.name,
    };
  });
  const visibleCards = cards.filter((item) => includesQuery(item, query));

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
          <div>
            <h2>知识库</h2>
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
        <section className="capability-catalog knowledge-catalog">
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

function CalendarPanel({
  agenda,
  hidden,
  kind,
}: {
  agenda: Array<[string, string, string, string, "success" | "warn" | ""]>;
  hidden: boolean;
  kind: "personal" | "teamflow";
}) {
  const title = kind === "personal" ? "个人日程" : "小队日程";
  return (
    <section
      className="schedule-calendar-panel"
      data-card-filter={`calendar ${kind}`}
      data-od-id={
        kind === "personal"
          ? "schedule-calendar-personal"
          : "schedule-calendar-team"
      }
      hidden={hidden}
    >
      <div
        className="calendar-month"
        aria-label={kind === "personal" ? "个人日历" : "小队日历"}
      >
        <div className="calendar-month-head">
          <strong>2026 年 7 月</strong>
          <span>{title}</span>
        </div>
        <div className="calendar-grid">
          {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
            <span key={day}>{day}</span>
          ))}
          {Array.from({ length: 21 }, (_, index) => (
            <button
              className={classNames(
                [8, 14, 16].includes(index) && "has-event",
                index === 16 && "is-selected",
              )}
              key={index}
              type="button"
            >
              {index + 1}
            </button>
          ))}
        </div>
      </div>
      <div className="calendar-agenda">
        <div className="panel-head">
          <h3>{kind === "personal" ? "7 月 17 日安排" : "小队执行安排"}</h3>
          <span
            className={classNames(
              "status",
              kind === "personal" ? "success" : "warn",
            )}
          >
            {kind === "personal" ? "2/3 完成" : "1 项卡点"}
          </span>
        </div>
        {agenda.map(([time, titleText, detail, status, tone]) => (
          <article className="agenda-item" key={`${time}-${titleText}`}>
            <span className="time-block">{time}</span>
            <div>
              <strong>{titleText}</strong>
              <p>{detail}</p>
            </div>
            <span className={classNames("status", tone)}>{status}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

export function ScheduleView({
  active,
  modalOpen,
  scheduleMode,
  scheduleSource,
  onCloseModal,
  onModeChange,
  onOpenModal,
  onSourceChange,
}: {
  active: boolean;
  modalOpen: boolean;
  scheduleMode: string;
  scheduleSource: string;
  onCloseModal: () => void;
  onModeChange: (mode: string) => void;
  onOpenModal: () => void;
  onSourceChange: (source: string) => void;
}) {
  const [query, setQuery] = useState("");
  const arrangementCards: CatalogItem[] = [
    {
      accent: "schedule-card",
      action: "创建",
      detail: "给自己创建周期提醒、材料整理、审批跟进等自动化任务安排。",
      filter: "arrangement personal",
      icon: "我",
      id: "schedule-arrange-personal",
      label: "Personal",
      meta: ["个人日程", "单次 / 周期", "可推送"],
      title: "创建个人任务安排",
    },
    {
      accent: "schedule-card",
      action: "创建",
      detail: "为小队创建 Code Review、日报、Gate 超时和 Channel 推送安排。",
      filter: "arrangement teamflow",
      icon: "队",
      id: "schedule-arrange-team",
      label: "Team",
      meta: ["小队日程", "自动执行", "Gate"],
      title: "创建小队任务安排",
    },
  ];
  const visibleArrangementCards = arrangementCards.filter(
    (item) =>
      scheduleMode === "arrangement" &&
      hasFilter(item, scheduleSource) &&
      includesQuery(item, query),
  );

  return (
    <section
      className={classNames("shell-view shell-page-view", active && "active")}
      data-filter-scope=""
      data-od-id="shell-view-schedule"
      data-shell-view="schedule"
      hidden={!active}
    >
      <div className="page-stack" data-filter-scope="">
        <header
          className="catalog-market-header function-market-header"
          data-od-id="schedule-header-inline"
        >
          <FilterTabs
            active={scheduleMode}
            group="schedule-mode"
            label="日程视图筛选"
            options={[
              { label: "日程", value: "calendar" },
              { label: "安排", value: "arrangement" },
            ]}
            onChange={onModeChange}
          />
          <div className="catalog-header-actions">
            <CatalogSearch
              label="搜索日程"
              placeholder="搜索日程、安排、结果"
              value={query}
              onChange={setQuery}
            />
            <button className="button" type="button">
              同步日程
            </button>
            <button
              className="button primary"
              type="button"
              onClick={onOpenModal}
            >
              新建安排
            </button>
          </div>
        </header>

        <section
          className="catalog-source-bar"
          data-od-id="schedule-filters-inline"
        >
          <SourceTabs
            active={scheduleSource}
            group="schedule-source"
            label="日程范围筛选"
            options={[
              { label: "个人日程", value: "personal" },
              { label: "小队日程", value: "teamflow" },
            ]}
            onChange={onSourceChange}
          />
          <span className="catalog-context-note">
            今天 4 项安排 · 2 项执行中 · 1 个结果待确认
          </span>
        </section>

        <CalendarPanel
          agenda={[
            [
              "09:00",
              "审批待确认 Gate",
              "安排：审阅需求拆解；状态：等待你确认；产出：任务分解摘要。",
              "待确认",
              "warn",
            ],
            [
              "11:30",
              "个人周报草稿",
              "安排：汇总本周项目变化；状态：执行完成；产出：周报草稿可编辑。",
              "已产出",
              "success",
            ],
            [
              "16:00",
              "设计走查提醒",
              "安排：检查能力库与日程页；状态：待开始；产出：检查清单。",
              "待开始",
              "",
            ],
          ]}
          hidden={scheduleMode !== "calendar" || scheduleSource !== "personal"}
          kind="personal"
        />
        <CalendarPanel
          agenda={[
            [
              "10:00",
              "Code Review 安排",
              "安排：PR 更新后触发审阅智能体；状态：运行中；产出：高风险结果推到 Gate。",
              "运行中",
              "success",
            ],
            [
              "14:00",
              "需求 Gate 超时",
              "安排：72h 未确认自动驳回；状态：待人介入；产出：驳回说明草稿。",
              "待确认",
              "warn",
            ],
            [
              "17:30",
              "小队日报推送",
              "安排：汇总执行状态、失败重试和完成报告；状态：待开始；产出：Channel 草稿。",
              "待开始",
              "",
            ],
          ]}
          hidden={scheduleMode !== "calendar" || scheduleSource !== "teamflow"}
          kind="teamflow"
        />

        <section
          className="capability-catalog function-catalog schedule-arrangement-catalog"
          data-od-id="schedule-arrangement-catalog"
          hidden={scheduleMode !== "arrangement"}
        >
          {visibleArrangementCards.map((item) => (
            <CatalogCard item={item} key={item.id} />
          ))}
        </section>
        <div
          className="filter-empty-state"
          data-filter-empty=""
          hidden={
            scheduleMode !== "arrangement" || visibleArrangementCards.length > 0
          }
        >
          没有匹配项
        </div>
        <div id="schedule-log" className="sr-log" aria-live="polite" />
      </div>

      <div
        className={classNames("modal-backdrop", modalOpen && "open")}
        hidden={!modalOpen}
        id="schedule-arrangement-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-arrangement-title"
      >
        <section
          className="arrangement-modal-card"
          data-od-id="schedule-arrangement-modal"
        >
          <header className="arrangement-modal-header">
            <h2 id="schedule-arrangement-title">创建任务安排</h2>
            <button
              className="icon-action compact"
              type="button"
              aria-label="关闭"
              onClick={onCloseModal}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <label className="form-field">
            <span>名称</span>
            <input type="text" defaultValue="每日交付状态同步" />
          </label>
          <label className="form-field">
            <span>任务提示词</span>
            <textarea defaultValue="汇总当天执行状态、卡点和结果产出，只推送需要确认的内容。" />
          </label>
          <div className="modal-chip-row" aria-label="执行配置">
            <span>Auto</span>
            <span>技能</span>
            <span>产品专家</span>
            <span className="warn">完全访问权限</span>
          </div>
          <div className="form-field">
            <span>执行频率</span>
            <div className="frequency-tabs">
              <button className="active" type="button">
                周期
              </button>
              <button type="button">按间隔</button>
              <button type="button">单次</button>
            </div>
          </div>
          <footer className="arrangement-modal-actions">
            <button className="button" type="button" onClick={onCloseModal}>
              取消
            </button>
            <button
              className="button primary"
              type="button"
              onClick={onCloseModal}
            >
              创建
            </button>
          </footer>
        </section>
      </div>
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
  singleChatWorkspaceCwd,
  teamMode,
  teamWorkspaceCwd,
  teamWorkspaceOptions,
  onCreateOffice,
  onRefresh,
  onTeamModeChange,
  onTeamWorkspaceChange,
}: {
  active: boolean;
  officeRuntime: Omit<CommandOfficeRoomProps, "isOpen"> | null;
  officeRoomId: string | null;
  singleChatWorkspaceCwd: string;
  teamMode: TeamMode;
  teamWorkspaceCwd: string;
  teamWorkspaceOptions: Array<{ label: string; value: string }>;
  onCreateOffice?: () => void;
  onRefresh?: () => void;
  onTeamModeChange: (mode: TeamMode) => void;
  onTeamWorkspaceChange: (cwd: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const officeStatus = officeRuntime?.status ?? "unavailable";
  return (
    <section
      className={classNames(
        "shell-view shell-page-view",
        active && "active",
        officeRoomId && "office-room-active",
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
            onChange={(value) => onTeamModeChange(value as TeamMode)}
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
              data-team-action="workflow"
              disabled
              hidden={teamMode !== "workflow"}
              title="等待 Workflow 后端列表、创建与运行接口接入"
            >
              创建协作流
            </button>
            <button
              className="button primary"
              type="button"
              data-team-action="experts"
              disabled
              hidden={teamMode !== "experts"}
              title="等待专家团定义与单聊运行接口接入"
            >
              创建专家团
            </button>
          </div>
        </header>

        <section
          className="catalog-source-bar"
          data-od-id="team-filters-inline"
        >
          {teamMode === "experts" ? (
            <div className="team-workspace-scope is-single-chat">
              <span className="team-workspace-scope-label">
                专家团工作空间
              </span>
              <strong title={singleChatWorkspaceCwd}>
                {singleChatWorkspaceCwd || "无工作空间"}
              </strong>
            </div>
          ) : (
            <label className="team-workspace-scope">
              <span className="team-workspace-scope-label">
                {teamMode === "office"
                  ? "办公室工作空间"
                  : "协作流工作空间"}
              </span>
              <span className="team-workspace-picker">
                <select
                  aria-label={
                    teamMode === "office"
                      ? "办公室群聊工作空间"
                      : "协作流运行工作空间"
                  }
                  title={teamWorkspaceCwd}
                  value={teamWorkspaceCwd}
                  onChange={(event) =>
                    onTeamWorkspaceChange(event.target.value)
                  }
                >
                  {teamWorkspaceOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="team-workspace-path" title={teamWorkspaceCwd}>
                  {teamWorkspaceCwd || "未选择工作空间"}
                </span>
              </span>
            </label>
          )}
          <span className="catalog-context-note team-workspace-note">
            {teamMode === "office"
              ? "群聊空间 · 可 @ 任意员工 · 不影响主页单聊"
              : teamMode === "workflow"
                ? "群聊协作 · 工作空间归属本次运行"
                : "单聊模式 · 只与团长对话"}
          </span>
        </section>

        <section
          className={classNames(
            "team-office-shell",
            officeRoomId && "is-room-open",
          )}
          data-card-filter="office"
          data-office-shell=""
          data-od-id="team-office-shell"
          hidden={teamMode !== "office" && !officeRoomId}
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

        <section
          className="team-workflow-shell"
          data-card-filter="workflow"
          data-od-id="team-workflow-shell"
          data-workflow-shell=""
          hidden={teamMode !== "workflow"}
        >
          <TeamCapabilityUnavailable
            boundary="协作流运行工作空间"
            description="当前 App Server 尚未提供协作流的列表、创建和运行接口。前端不会再用静态节点、假进度或本地消息模拟成功。"
            title="协作流真实运行态尚未接入"
            workspaceCwd={teamWorkspaceCwd}
          />
        </section>

        <section
          className="team-experts-shell"
          data-card-filter="experts"
          data-od-id="team-experts-shell"
          hidden={teamMode !== "experts"}
        >
          <TeamCapabilityUnavailable
            boundary="专家团单聊工作空间"
            description="专家团属于单聊执行目标，但当前还没有真实的专家团定义、团长会话和后台成员运行接口。前端不会生成罐头回复或虚构后台协作。"
            title="专家团真实单聊运行态尚未接入"
            workspaceCwd={singleChatWorkspaceCwd}
          />
        </section>

        <div id="team-log" className="sr-log" aria-live="polite" />
      </div>
    </section>
  );
}
