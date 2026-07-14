import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Bot,
  Layers3,
  Mic,
  Search,
  Settings2,
  Wrench,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { officeRooms, workflowRooms } from "./commandWorkspaceData";
import { classNames, connectionLabel } from "./commandWorkspaceUtils";
import { CatalogResourceDialog } from "../catalog/CatalogResourceDialog";
import {
  downloadCatalogResource,
  refreshAgentPlatformCatalog,
  type CatalogResourceSummary,
} from "../../lib/agent-platform/agentPlatformCatalog";
import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";
import type { ConnectionState } from "../../lib/shared/connectionState";

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
        {item.resource ? (
          <span
            className={classNames(
              "catalog-download-status",
              item.resource.update_available && "update",
              item.resource.downloaded && "downloaded",
            )}
          >
            {item.resource.update_available
              ? "有更新"
              : item.resource.downloaded
                ? "已下载"
                : "未下载"}
          </span>
        ) : (
          <div className="catalog-meta">
            {item.meta.map((meta) => (
              <span key={meta}>{meta}</span>
            ))}
          </div>
        )}
      </div>
      {item.resource ? (
        <div className="catalog-card-actions">
          <button
            className="button compact"
            disabled={!item.resource.downloaded}
            type="button"
            onClick={() => onOpen?.(item.resource!)}
          >
            查看
          </button>
          <button
            className="button compact"
            disabled={
              progress !== undefined ||
              (Boolean(item.resource.downloaded) &&
                !item.resource.update_available)
            }
            type="button"
            onClick={() => onDownload?.(item.resource!)}
          >
            {progress !== undefined
              ? "下载中…"
              : item.resource.update_available
                ? "更新"
                : item.resource.downloaded
                  ? "已下载"
                  : "下载"}
          </button>
          {progress !== undefined ? (
            <progress max="100" value={progress} />
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
      download_available: true,
      downloaded: agent.downloaded,
      downloaded_at: agent.downloaded_at,
      update_available: agent.update_available,
      source_updated_at: agent.source_updated_at,
    };
    return {
      accent: "employee-card",
      detail: resource.description,
      filter: "employee",
      icon: "A",
      id: `catalog-agent-${agent.id}`,
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
      download_available: true,
      downloaded: skill.downloaded,
      downloaded_at: skill.downloaded_at,
      update_available: skill.update_available,
      source_updated_at: skill.source_updated_at,
    };
    return {
      accent: "skill-card",
      detail: resource.description,
      filter: "skill",
      icon: "S",
      id: `catalog-skill-${skill.id}`,
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
      download_available: true,
      downloaded: server.downloaded,
      downloaded_at: server.downloaded_at,
      update_available: server.update_available,
      source_updated_at: server.source_updated_at,
    };
    return {
      accent: "service-card",
      detail: resource.description,
      filter: "service",
      icon: "M",
      id: `catalog-mcp-${server.id}`,
      label: "服务",
      meta: [],
      resource,
      title: resource.name,
    };
  });
  return [...employees, ...skills, ...services];
}

export function AssistView({
  active,
  composerValue,
  connectionState,
  onChangeComposerValue,
  onSend,
}: {
  active: boolean;
  composerValue: string;
  connectionState: ConnectionState;
  onChangeComposerValue: (value: string) => void;
  onSend: () => void;
}) {
  return (
    <section
      className={classNames(
        "shell-view shell-page-view assistant-only-view",
        active && "active",
      )}
      data-od-id="shell-view-assist"
      data-shell-view="assist"
      hidden={!active}
    >
      <div className="assistant-canvas" data-od-id="assistant-canvas">
        <div className="assistant-top-status" data-od-id="assistant-top-status">
          <span>已连接：</span>
          <strong>
            <span aria-hidden="true" />
            <span>Crewon 助理</span>
          </strong>
          <span className="visually-hidden">
            {connectionLabel(connectionState)}
          </span>
          <button
            className="icon-action compact"
            type="button"
            aria-label="连接设置"
          >
            <Settings2 aria-hidden="true" />
          </button>
        </div>

        <div
          className="assistant-log-canvas"
          id="assist-log"
          aria-live="polite"
          data-od-id="assistant-log-canvas"
        />

        <div className="assistant-bottom-zone">
          <section
            className="command-input assistant-home-composer"
            data-od-id="assistant-composer"
          >
            <label className="visually-hidden" htmlFor="assist-input">
              助理输入
            </label>
            <textarea
              id="assist-input"
              aria-describedby="assist-composer-status"
              data-composer=""
              data-od-id="assistant-composer-input"
              placeholder="把这个需求拆成 Workflow 节点、角色分工和 Stage Gate。 @ 引用上下文，/ 搜索 Skill 和 MCP。"
              value={composerValue}
              onChange={(event) => onChangeComposerValue(event.target.value)}
            />
            <button
              className="shortcut-proxy"
              type="button"
              data-context-open=""
              hidden
              aria-hidden="true"
              tabIndex={-1}
            />
            <button
              className="shortcut-proxy"
              type="button"
              data-slash-open=""
              hidden
              aria-hidden="true"
              tabIndex={-1}
            />
            <div className="input-tools" data-od-id="assistant-composer-tools">
              <div
                className="composer-controls"
                data-od-id="assistant-composer-control-row"
              >
                <div
                  className="control-select mode-dropdown"
                  aria-label="任务类型"
                >
                  <select
                    data-task-mode=""
                    aria-label="任务类型"
                    defaultValue="plan"
                  >
                    <option value="plan">计划</option>
                    <option value="goal">目标</option>
                    <option value="agent">智能体</option>
                  </select>
                </div>
                <div
                  className="control-select model-dropdown"
                  aria-label="模型选择"
                >
                  <select
                    data-model-select=""
                    aria-label="模型选择"
                    defaultValue="gpt-5.6-sol"
                  >
                    <option value="gpt-5.6-sol">gpt-5.6-sol</option>
                    <option value="gpt-5.6">gpt-5.6</option>
                    <option value="gpt-5.5">gpt-5.5</option>
                    <option value="gpt-5-codex">gpt-5-codex</option>
                  </select>
                </div>
                <div
                  className="control-select permission-dropdown"
                  aria-label="权限选择"
                >
                  <select
                    data-permission-select=""
                    aria-label="权限选择"
                    defaultValue="approve-for-me"
                  >
                    <option value="approve-for-me">替我审批</option>
                    <option value="request-approval">请求批准</option>
                    <option value="full-access">完全访问</option>
                  </select>
                </div>
              </div>
              <div className="composer-actions">
                <button
                  className="icon-action prompt-action"
                  type="button"
                  aria-label="优化提示词"
                >
                  Aa
                </button>
                <button
                  className="icon-action"
                  type="button"
                  aria-label="语音输入"
                >
                  <Mic aria-hidden="true" />
                </button>
                <button
                  className="send-button"
                  type="button"
                  aria-label="发送"
                  onClick={onSend}
                >
                  <ArrowUp aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="composer-state-row assistant-state-row">
              <span
                id="assist-composer-status"
                className="composer-state"
                role="status"
                aria-live="polite"
              >
                内容由 AI 生成，请核实重要信息
              </span>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
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
  snapshot,
  onReload,
  onCatalogFilterChange,
  onCatalogSearchChange,
}: {
  active: boolean;
  catalogFilter: string;
  catalogSearch: string;
  platformState: "loading" | "ready" | "fallback";
  snapshot: AgentPlatformSnapshot;
  onReload: () => Promise<void>;
  onCatalogFilterChange: (filter: string) => void;
  onCatalogSearchChange: (query: string) => void;
}) {
  const [selectedResource, setSelectedResource] =
    useState<CatalogResourceSummary | null>(null);
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

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshAgentPlatformCatalog();
      await onReload();
    } finally {
      setRefreshing(false);
    }
  }

  async function download(resource: CatalogResourceSummary) {
    const key = `${resource.type}:${resource.id}`;
    setDownloadProgress((current) => ({ ...current, [key]: 1 }));
    setDownloadError(null);
    try {
      await downloadCatalogResource(resource.type, resource.id);
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
              {refreshing ? "更新中…" : "更新目录"}
            </button>
          </div>
        </header>

        {downloadError ? (
          <p className="catalog-download-error" role="alert">
            {downloadError}
          </p>
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
              onOpen={setSelectedResource}
            />
          ))}
          {visibleCards.length === 0 ? (
            <div
              className="filter-empty-state"
              data-filter-empty=""
              role="status"
            >
              {platformState === "loading"
                ? "正在读取当前账号的 Agent、Skill 和 MCP…"
                : platformState === "fallback"
                  ? "资源目录暂时不可用，请确认 agent-platform 已启动后重试。"
                  : cards.length === 0
                    ? "当前账号暂无可用资源。请先在 agent-platform 创建或授权资源，再更新目录。"
                    : "没有匹配项"}
            </div>
          ) : null}
        </section>
      </div>
      <CatalogResourceDialog
        resource={selectedResource}
        onClose={() => setSelectedResource(null)}
        onRefresh={refresh}
      />
    </section>
  );
}

export function KnowledgeCatalogView({
  active,
  platformState,
  snapshot,
  onReload,
}: {
  active: boolean;
  platformState: "loading" | "ready" | "fallback";
  snapshot: AgentPlatformSnapshot;
  onReload: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [selectedResource, setSelectedResource] =
    useState<CatalogResourceSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({});
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
      download_available: true,
      downloaded: knowledgeBase.downloaded,
      downloaded_at: knowledgeBase.downloaded_at,
      update_available: knowledgeBase.update_available,
      source_updated_at: knowledgeBase.source_updated_at,
    };
    return {
      accent: "knowledge-card",
      detail: resource.description,
      filter: "knowledge personal",
      icon: <BookOpen aria-hidden="true" />,
      id: `catalog-knowledge-${knowledgeBase.id}`,
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
      await refreshAgentPlatformCatalog();
      await onReload();
    } finally {
      setRefreshing(false);
    }
  }

  async function download(resource: CatalogResourceSummary) {
    const key = `${resource.type}:${resource.id}`;
    setDownloadProgress((current) => ({ ...current, [key]: 1 }));
    setDownloadError(null);
    try {
      await downloadCatalogResource(resource.type, resource.id);
      await onReload();
    } catch (reason) {
      setDownloadError(
        reason instanceof Error ? reason.message : "知识库下载失败",
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
              {refreshing ? "更新中…" : "更新目录"}
            </button>
          </div>
        </header>
        {downloadError ? (
          <p className="catalog-download-error" role="alert">
            {downloadError}
          </p>
        ) : null}
        <section className="capability-catalog knowledge-catalog">
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
              onOpen={setSelectedResource}
            />
          ))}
          {visibleCards.length === 0 ? (
            <div className="filter-empty-state" role="status">
              {platformState === "loading"
                ? "正在读取当前账号的知识库…"
                : platformState === "fallback"
                  ? "知识库目录暂时不可用，请确认 agent-platform 已启动后重试。"
                  : cards.length === 0
                    ? "当前账号暂无可用知识库。请先在 agent-platform 创建或授权知识库，再更新目录。"
                    : "没有匹配的知识库"}
            </div>
          ) : null}
        </section>
      </div>
      <CatalogResourceDialog
        resource={selectedResource}
        onClose={() => setSelectedResource(null)}
        onRefresh={refresh}
      />
    </section>
  );
}

export function TeamView({
  active,
  activeOfficeRoom,
  activeWorkflowRoom,
  officeRoomId,
  officeTab,
  teamMode,
  workflowRoomId,
  workflowTab,
  onBackOffice,
  onBackWorkflow,
  onOfficeTabChange,
  onOpenOffice,
  onOpenWorkflow,
  onTeamModeChange,
  onWorkflowTabChange,
}: {
  active: boolean;
  activeOfficeRoom: (typeof officeRooms)[number];
  activeWorkflowRoom: (typeof workflowRooms)[number];
  officeRoomId: string | null;
  officeTab: string;
  teamMode: TeamMode;
  workflowRoomId: string | null;
  workflowTab: string;
  onBackOffice: () => void;
  onBackWorkflow: () => void;
  onOfficeTabChange: (tab: string) => void;
  onOpenOffice: (roomId: string) => void;
  onOpenWorkflow: (roomId: string) => void;
  onTeamModeChange: (mode: TeamMode) => void;
  onWorkflowTabChange: (tab: string) => void;
}) {
  return (
    <section
      className={classNames(
        "shell-view shell-page-view",
        active && "active",
        officeRoomId && "office-room-active",
        workflowRoomId && "workflow-room-active",
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
            <CatalogSearch
              label="搜索团队"
              placeholder="搜索办公室、协作流、专家团"
              value=""
              onChange={() => undefined}
            />
            <button className="button" type="button">
              同步能力库
            </button>
            <button
              className="button primary"
              type="button"
              data-team-action="office"
              hidden={teamMode !== "office"}
            >
              创建办公室
            </button>
            <button
              className="button primary"
              type="button"
              data-team-action="workflow"
              hidden={teamMode !== "workflow"}
            >
              创建协作流
            </button>
            <button
              className="button primary"
              type="button"
              data-team-action="experts"
              hidden={teamMode !== "experts"}
            >
              创建专家团
            </button>
          </div>
        </header>

        <section
          className="catalog-source-bar"
          data-od-id="team-filters-inline"
        >
          <span className="catalog-context-note">
            团队能力来自左侧智能体页 · 办公室可 @ 任意员工 · 专家团只和组长对话
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
          <div
            className="office-card-grid"
            data-office-list=""
            aria-label="办公室卡片"
            hidden={Boolean(officeRoomId)}
          >
            {officeRooms.map((room) => (
              <button
                className={classNames(
                  "office-card office-card-button",
                  officeRoomId === room.id && "is-active",
                )}
                data-office-open=""
                key={room.id}
                type="button"
                onClick={() => onOpenOffice(room.id)}
              >
                <span className="office-card-head">
                  <strong>{room.title}</strong>
                  <em className={classNames("status", room.statusTone)}>
                    {room.status}
                  </em>
                </span>
                <span className="office-card-copy">{room.subtitle}</span>
                <span className="office-card-foot">
                  <em>{room.current}</em>
                  <b>进入群聊</b>
                </span>
              </button>
            ))}
          </div>
          <RoomInline
            active={Boolean(officeRoomId)}
            messages={activeOfficeRoom.messages}
            subtitle={activeOfficeRoom.subtitle}
            tab={officeTab}
            title={activeOfficeRoom.title}
            type="office"
            onBack={onBackOffice}
            onTabChange={onOfficeTabChange}
          />
        </section>

        <section
          className={classNames(
            "team-workflow-shell",
            workflowRoomId && "is-room-open",
          )}
          data-card-filter="workflow"
          data-od-id="team-workflow-shell"
          data-workflow-shell=""
          hidden={teamMode !== "workflow" && !workflowRoomId}
        >
          <div
            className="workflow-list"
            data-workflow-list=""
            aria-label="协作流列表"
            hidden={Boolean(workflowRoomId)}
          >
            {workflowRooms.map((room) => (
              <button
                className={classNames(
                  "workflow-list-item",
                  workflowRoomId === room.id && "is-active",
                )}
                data-workflow-open=""
                key={room.id}
                type="button"
                onClick={() => onOpenWorkflow(room.id)}
              >
                <span className="workflow-list-main">
                  <strong>{room.title}</strong>
                  <em className={classNames("status", room.statusTone)}>
                    {room.status}
                  </em>
                </span>
                <span className="workflow-list-meta">
                  <span className="workflow-list-copy">{room.stage}</span>
                  <span
                    className="workflow-member-strip"
                    aria-label="协作流成员"
                  >
                    {room.members.map((member) => (
                      <small key={member}>{member}</small>
                    ))}
                    <em>{room.members.length} 成员</em>
                  </span>
                </span>
                <span className="workflow-list-foot">
                  <span className="workflow-list-progress" aria-hidden="true">
                    {room.progress.map((state, index) => (
                      <i className={state} key={`${room.id}-${index}`} />
                    ))}
                  </span>
                  <b>进入群聊</b>
                </span>
              </button>
            ))}
          </div>
          <RoomInline
            active={Boolean(workflowRoomId)}
            messages={activeWorkflowRoom.messages}
            subtitle={activeWorkflowRoom.stage}
            tab={workflowTab}
            title={activeWorkflowRoom.title}
            type="workflow"
            onBack={onBackWorkflow}
            onTabChange={onWorkflowTabChange}
          />
        </section>

        <section
          className="team-experts-shell"
          data-card-filter="experts"
          data-od-id="team-experts-shell"
          hidden={teamMode !== "experts"}
        >
          <div className="expert-team-grid" aria-label="专家团卡片">
            {[
              [
                "主页可选",
                "产品交付专家团",
                "用户只和组长智能体多轮澄清；员工在后台协作，不展示办公室群聊。",
                "设为主页可选",
              ],
              [
                "后台执行",
                "代码审查专家团",
                "组长接收需求，后台调度 Code Review Skill、Filesystem MCP 和 GitHub MCP。",
                "后台执行",
              ],
              [
                "草稿",
                "会议准备专家团",
                "组长负责澄清会议目标，后台员工整理议程、参会人上下文和材料清单。",
                "继续配置",
              ],
            ].map(([label, title, detail, action]) => (
              <article className="expert-team-card" key={title}>
                <div className="catalog-card-head">
                  <span>{label}</span>
                  <strong>{title}</strong>
                </div>
                <p>{detail}</p>
                <div className="expert-member-stack">
                  <span>组长：产品审阅智能体</span>
                  <span>员工：开发交付智能体</span>
                  <span>服务：Filesystem / GitHub</span>
                </div>
                <button className="button compact" type="button">
                  {action}
                </button>
              </article>
            ))}
          </div>
        </section>

        <div id="team-log" className="sr-log" aria-live="polite" />
      </div>
    </section>
  );
}

function RoomInline({
  active,
  messages,
  subtitle,
  tab,
  title,
  type,
  onBack,
  onTabChange,
}: {
  active: boolean;
  messages: string[];
  subtitle: string;
  tab: string;
  title: string;
  type: "office" | "workflow";
  onBack: () => void;
  onTabChange: (tab: string) => void;
}) {
  const tabNames = [
    ["chat", type === "office" ? "群聊" : "对话"],
    ["run", type === "office" ? "运行台" : "运行"],
    ["memory", "记忆"],
    ["members", "成员"],
  ];
  const isWorkflow = type === "workflow";
  return (
    <section
      className={isWorkflow ? "workflow-room-inline" : "office-room-inline"}
      data-od-id={
        isWorkflow ? "team-workflow-room-inline" : "team-office-room-inline"
      }
      data-office-room={isWorkflow ? undefined : ""}
      data-workflow-room={isWorkflow ? "" : undefined}
      hidden={!active}
      tabIndex={-1}
    >
      <header className={isWorkflow ? "workflow-room-top" : "office-room-top"}>
        <button className="button compact" type="button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          返回
        </button>
        <div
          className={
            isWorkflow ? "workflow-room-title-block" : "office-room-title-block"
          }
        >
          <span>{isWorkflow ? "协作流群聊" : "办公室群聊"}</span>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <div
          className={
            isWorkflow ? "workflow-room-actions" : "office-room-actions"
          }
        >
          <span className={classNames("status", isWorkflow && "warn")}>
            {isWorkflow ? "按节点推进" : "执行中"}
          </span>
          <button
            className="button compact"
            type="button"
            onClick={() => onTabChange("members")}
          >
            成员
          </button>
        </div>
      </header>

      {isWorkflow ? (
        <main className="workflow-room-stage">
          <section
            className="workflow-execution-strip"
            data-od-id="workflow-execution-strip"
            aria-label="执行步节点流"
          >
            {[
              ["01", "接收目标", "协作流组长智能体", "完成", "is-done"],
              ["02", "界面风险审阅", "产品审阅智能体", "运行中", "is-running"],
              ["03", "实现拆解", "开发交付智能体", "排队", ""],
              ["04", "人工 Gate", "真实员工 · 设计负责人", "待确认", ""],
            ].map(([step, stepTitle, owner, state, className]) => (
              <article
                className={classNames("workflow-step-node", className)}
                key={step}
              >
                <span>{step}</span>
                <div>
                  <strong>{stepTitle}</strong>
                  <p>{owner}</p>
                </div>
                <em
                  className={classNames(
                    "status",
                    className === "is-done" && "success",
                    className === "is-running" && "warn",
                  )}
                >
                  {state}
                </em>
              </article>
            ))}
          </section>
          <RoomPanels
            isWorkflow
            messages={messages}
            tab={tab}
            tabNames={tabNames}
            onTabChange={onTabChange}
          />
        </main>
      ) : (
        <RoomPanels
          isWorkflow={false}
          messages={messages}
          tab={tab}
          tabNames={tabNames}
          onTabChange={onTabChange}
        />
      )}
    </section>
  );
}

function RoomPanels({
  isWorkflow,
  messages,
  tab,
  tabNames,
  onTabChange,
}: {
  isWorkflow: boolean;
  messages: string[];
  tab: string;
  tabNames: string[][];
  onTabChange: (tab: string) => void;
}) {
  const prefix = isWorkflow ? "workflow" : "office";
  return (
    <main className={isWorkflow ? "workflow-chat-panel" : "office-room-main"}>
      <div className="office-room-tabs" data-tab-scope="">
        {tabNames.map(([name, label]) => (
          <button
            aria-selected={tab === name}
            className={classNames(tab === name && "active")}
            data-tab-target={`#${prefix}-${name}-panel`}
            key={name}
            type="button"
            onClick={() => onTabChange(name)}
          >
            {label}
          </button>
        ))}
      </div>

      <section
        className={
          isWorkflow
            ? "workflow-tab-panel office-chat-panel"
            : "office-tab-panel office-chat-panel"
        }
        data-tab-panel=""
        hidden={tab !== "chat"}
        id={`${prefix}-chat-panel`}
      >
        <div
          className={isWorkflow ? "workflow-room-thread" : "office-room-thread"}
          role="log"
          aria-label="团队群聊"
        >
          {messages.map((message, index) => (
            <article
              className={classNames(
                "office-room-message",
                index === 0 && "is-user",
              )}
              key={message}
            >
              <span className="team-avatar">
                {index === 0 ? "你" : isWorkflow ? "流" : "组"}
              </span>
              <div>
                <strong>
                  {index === 0
                    ? "你"
                    : isWorkflow
                      ? "协作流组长智能体"
                      : "办公室组长智能体"}
                </strong>
                <p>{message}</p>
              </div>
            </article>
          ))}
        </div>
        <section
          className={classNames(
            "command-input",
            isWorkflow ? "workflow-global-composer" : "office-global-composer",
          )}
        >
          <textarea
            data-composer=""
            placeholder={
              isWorkflow
                ? "@ 指定阶段 Agent；/ 调用 Skill 或 MCP"
                : "@ 指定员工；留空默认交给办公室组长"
            }
            defaultValue={
              isWorkflow
                ? "继续推进这个协作流..."
                : "告诉组长目标、背景或下一步..."
            }
          />
          <div className="input-tools">
            <div className="composer-controls">
              <div
                className="control-select mode-dropdown"
                aria-label="任务类型"
              >
                <select defaultValue="plan">
                  <option value="plan">计划</option>
                  <option value="goal">目标</option>
                  <option value="agent">智能体</option>
                </select>
              </div>
              <div
                className="control-select permission-dropdown"
                aria-label="权限选择"
              >
                <select defaultValue="request-approval">
                  <option value="request-approval">请求批准</option>
                  <option value="approve-for-me">替我审批</option>
                  <option value="full-access">完全访问</option>
                </select>
              </div>
            </div>
            <div className="composer-actions">
              <button
                className="icon-action prompt-action"
                type="button"
                aria-label="优化提示词"
              >
                Aa
              </button>
              <button className="send-button" type="button" aria-label="发送">
                <ArrowUp aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="composer-state-row">
            <span className="composer-state">
              {isWorkflow ? "协作流 · 等待输入" : "办公室 · 等待输入"}
            </span>
          </div>
        </section>
      </section>

      <section
        className="office-tab-panel office-run-panel"
        data-tab-panel=""
        hidden={tab !== "run"}
        id={`${prefix}-run-panel`}
      >
        <div className="office-kanban-board" aria-label="运行台看板">
          {[
            ["待接收", "补齐验收口径", "Human Gate"],
            ["执行中", "PRD 风险清单", "产品审阅"],
            ["Gate", "权限边界确认", "请求批准"],
            ["完成", "界面验收口径", "已归档"],
          ].map(([column, task, state]) => (
            <section className="office-kanban-column" key={column}>
              <header>
                <strong>{column}</strong>
                <span>1</span>
              </header>
              <article>
                <b>{task}</b>
                <p>状态同步到当前房间</p>
                <em>{state}</em>
              </article>
            </section>
          ))}
        </div>
      </section>

      <section
        className="office-tab-panel office-memory-panel"
        data-tab-panel=""
        hidden={tab !== "memory"}
        id={`${prefix}-memory-panel`}
      >
        <div className="office-memory-list">
          {[
            "页面交付先保留蓝灰轻工作台语言",
            "高风险输出必须进入人工确认 Gate",
          ].map((memory) => (
            <article className="office-memory-card" key={memory}>
              <span>决策</span>
              <strong>{memory}</strong>
              <p>来源：团队页群聊 · 可见：组长、产品审阅、开发交付</p>
              <button type="button">查看来源</button>
            </article>
          ))}
        </div>
      </section>

      <section
        className="office-tab-panel office-memory-panel"
        data-tab-panel=""
        hidden={tab !== "members"}
        id={`${prefix}-members-panel`}
      >
        <div className="office-memory-list">
          {[
            "办公室组长智能体",
            "产品审阅智能体",
            "开发交付智能体",
            "真实员工 · 设计负责人",
          ].map((member) => (
            <article className="office-room-member" key={member}>
              <span className="team-avatar">{member.slice(0, 1)}</span>
              <div>
                <strong>{member}</strong>
                <p>当前任务成员</p>
              </div>
              <em>Member</em>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
