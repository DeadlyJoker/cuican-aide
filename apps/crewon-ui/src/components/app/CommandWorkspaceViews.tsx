import {
  ArrowLeft,
  ArrowUp,
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
import type { CommandHomeSlots } from "./commandWorkspaceState";
import { classNames, connectionLabel } from "./commandWorkspaceUtils";
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

function CatalogCard({ item }: { item: CatalogItem }) {
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
        <p>{item.detail}</p>
        <div className="catalog-meta">
          {item.meta.map((meta) => (
            <span
              className={meta.includes("来源") || meta.includes("队列") ? "source-badge" : undefined}
              key={meta}
            >
              {meta}
            </span>
          ))}
        </div>
      </div>
      {item.action ? (
        <button className="button compact" type="button">
          {item.action}
        </button>
      ) : item.status ? (
        <span className={classNames("status", item.statusTone)}>{item.status}</span>
      ) : (
        <button className="icon-action compact" type="button" aria-label={`添加 ${item.title}`}>
          +
        </button>
      )}
    </article>
  );
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
          <span className="visually-hidden">{connectionLabel(connectionState)}</span>
          <button className="icon-action compact" type="button" aria-label="连接设置">
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
          <section className="command-input assistant-home-composer" data-od-id="assistant-composer">
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
            <button className="shortcut-proxy" type="button" data-context-open="" hidden aria-hidden="true" tabIndex={-1} />
            <button className="shortcut-proxy" type="button" data-slash-open="" hidden aria-hidden="true" tabIndex={-1} />
            <div className="input-tools" data-od-id="assistant-composer-tools">
              <div className="composer-controls" data-od-id="assistant-composer-control-row">
                <div className="control-select mode-dropdown" aria-label="任务类型">
                  <select data-task-mode="" aria-label="任务类型" defaultValue="plan">
                    <option value="plan">计划</option>
                    <option value="goal">目标</option>
                    <option value="agent">智能体</option>
                  </select>
                </div>
                <div className="control-select model-dropdown" aria-label="模型选择">
                  <select data-model-select="" aria-label="模型选择" defaultValue="gpt-5.6-sol">
                    <option value="gpt-5.6-sol">gpt-5.6-sol</option>
                    <option value="gpt-5.6">gpt-5.6</option>
                    <option value="gpt-5.5">gpt-5.5</option>
                    <option value="gpt-5-codex">gpt-5-codex</option>
                  </select>
                </div>
                <div className="control-select permission-dropdown" aria-label="权限选择">
                  <select data-permission-select="" aria-label="权限选择" defaultValue="approve-for-me">
                    <option value="approve-for-me">替我审批</option>
                    <option value="request-approval">请求批准</option>
                    <option value="full-access">完全访问</option>
                  </select>
                </div>
              </div>
              <div className="composer-actions">
                <button className="icon-action prompt-action" type="button" aria-label="优化提示词">
                  Aa
                </button>
                <button className="icon-action" type="button" aria-label="语音输入">
                  <Mic aria-hidden="true" />
                </button>
                <button className="send-button" type="button" aria-label="发送" onClick={onSend}>
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
        <header className="catalog-market-header function-market-header" data-od-id="projects-header-inline">
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

        <section className="catalog-source-bar" data-od-id="project-filters-inline">
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
          <span className="catalog-context-note">Stage Gate：需求确认 · running 56%</span>
        </section>

        <section className="capability-catalog function-catalog" data-od-id="project-task-catalog">
          {visibleProjects.map((item) => (
            <CatalogCard item={item} key={item.id} />
          ))}
          <div className="filter-empty-state" data-filter-empty="" hidden={visibleProjects.length > 0}>
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
                  className={classNames("capability-row", item.id.includes("requirement") && "is-priority")}
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

          <aside className="side-rail" data-od-id="project-flow-inspector-inline">
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
                  ["parallel -> merge", "并行分发给多个角色，合并为共享上下文。", "并行"],
                  ["gate -> end", "人类确认关键决策，再进入交付或回退。", "卡点"],
                ].map(([title, detail, status]) => (
                  <div className="capability-row" key={title}>
                    <div>
                      <strong>{title}</strong>
                      <p>{detail}</p>
                    </div>
                    <span className={classNames("status", status === "卡点" && "warn")}>
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
              <p>只传 PRD 能力域、当前页面壳、审批策略，不把完整历史对话塞给 Agent。</p>
              <p>{resourceStatus}</p>
            </section>
          </aside>
        </section>
      </div>
    </section>
  );
}

function agentCatalog(slots: CommandHomeSlots): CatalogItem[] {
  return [
    {
      accent: "employee-card",
      detail: slots.agent.detail,
      filter: "employee personal",
      icon: "产",
      id: "employee-card-product-review",
      label: "员工",
      meta: ["PRD", "Gate", "只读"],
      title: slots.agent.title,
    },
    {
      accent: "employee-card",
      detail: "把设计意图转成开发任务、边界条件和验收清单。",
      filter: "employee personal",
      icon: "交",
      id: "employee-card-engineering-handoff",
      label: "员工",
      meta: ["MRD", "任务拆解", "写草稿"],
      title: "开发交付智能体",
    },
    {
      accent: "employee-card",
      detail: "检查层级、密度、间距和组件一致性，避免功能页漂移。",
      filter: "employee market",
      icon: "视",
      id: "employee-card-visual-polish",
      label: "员工",
      meta: ["来源：市场", "UI QA", "组件", "建议态"],
      title: "视觉打磨智能体",
    },
    {
      accent: "employee-card",
      detail: "整理决策记录、待审批事项和对齐摘要，发送前保留人工确认。",
      filter: "employee market",
      icon: "会",
      id: "employee-card-meeting-prep",
      label: "员工",
      meta: ["来源：市场", "Channel", "纪要", "Gate"],
      title: "会议准备智能体",
    },
    {
      accent: "skill-card",
      detail: "读取 PR diff、运行静态检查，只把高风险结论送入 Gate。",
      filter: "skill market",
      icon: "CR",
      id: "skill-card-code-review",
      label: "Skill",
      meta: ["来源：市场", "/review", "只读", "高风险"],
      title: "code-review-system",
    },
    {
      accent: "skill-card",
      detail: slots.skills[0].detail,
      filter: "skill personal",
      icon: "页",
      id: "skill-card-page-review",
      label: "Skill",
      meta: ["/ui-review", "视觉", "建议态"],
      title: slots.skills[0].title,
    },
    {
      accent: "skill-card",
      detail: slots.skills[1]?.detail ?? "把变更压缩成开发可执行的验收点、风险和回归范围。",
      filter: "skill personal",
      icon: "交",
      id: "skill-card-handoff",
      label: "Skill",
      meta: ["/handoff", "验收", "导出"],
      title: slots.skills[1]?.title ?? "交付检查 Skill",
    },
    {
      accent: "skill-card",
      detail: "解释 Agent / Team 生命周期，生成串行、并行或嵌套 Workflow。",
      filter: "skill market",
      icon: "队",
      id: "skill-card-agent-management",
      label: "Skill",
      meta: ["来源：市场", "/team", "Workflow", "Gate"],
      title: "小队编排 Skill",
    },
    {
      accent: "skill-card",
      detail: "读取网页、抽取结构化片段，并把来源回写到当前任务上下文。",
      filter: "skill market",
      icon: "WA",
      id: "skill-card-web-access",
      label: "Skill",
      meta: ["来源：市场", "/web", "引用", "只读"],
      title: "Web Access",
    },
    {
      accent: "skill-card",
      detail: "把会议、PRD 或验收点整理成可复制的文档草稿。",
      filter: "skill market",
      icon: "文",
      id: "skill-card-doc-generator",
      label: "Skill",
      meta: ["来源：市场", "/doc", "草稿", "导出"],
      title: "文档生成 Skill",
    },
    {
      accent: "skill-card",
      detail: "打开页面、点击表单、采集状态，用于低风险网页任务。",
      filter: "skill market",
      icon: "BR",
      id: "skill-card-browser-automation",
      label: "Skill",
      meta: ["来源：市场", "/browser", "沙箱", "Gate"],
      title: "浏览器自动化",
    },
    {
      accent: "skill-card",
      detail: "把用户反馈、缺陷记录和会议备注聚类成可执行问题。",
      filter: "skill market",
      icon: "馈",
      id: "skill-card-feedback-mining",
      label: "Skill",
      meta: ["来源：市场", "/feedback", "聚类", "建议态"],
      title: "反馈归因 Skill",
    },
    {
      accent: "service-card",
      detail: slots.mcps[0].detail,
      filter: "service personal",
      icon: "FS",
      id: "service-card-filesystem",
      label: "Service",
      meta: ["@文件", "项目内", "就绪"],
      title: slots.mcps[0].title,
    },
    {
      accent: "service-card",
      detail: "读取 Issue、PR 和提交状态；写入评论或触发 Action 前需要 Gate。",
      filter: "service market",
      icon: "GH",
      id: "service-card-github",
      label: "Service",
      meta: ["来源：市场", "@PR", "待授权", "Gate"],
      title: "GitHub MCP",
    },
    {
      accent: "service-card",
      detail: "只检索办公室授权的知识集合，并把引用来源写入上下文。",
      filter: "service personal",
      icon: "KB",
      id: "service-card-knowledge",
      label: "Service",
      meta: ["@知识库", "引用", "正常"],
      title: "知识库 RAG",
    },
    {
      accent: "service-card",
      detail: "读取会议、提醒和自动化窗口；创建外部事件需要 Gate。",
      filter: "service market",
      icon: "日",
      id: "service-card-calendar",
      label: "Service",
      meta: ["来源：市场", "@日程", "只读", "正常"],
      title: "日历服务",
    },
  ];
}

export function AgentsView({
  active,
  catalogFilter,
  catalogSearch,
  slots,
  onCatalogFilterChange,
  onCatalogSearchChange,
}: {
  active: boolean;
  catalogFilter: string;
  catalogSearch: string;
  slots: CommandHomeSlots;
  onCatalogFilterChange: (filter: string) => void;
  onCatalogSearchChange: (query: string) => void;
}) {
  const [source, setSource] = useState("market");
  const cards = useMemo(() => agentCatalog(slots), [slots]);
  const visibleCards = cards.filter(
    (item) =>
      (catalogFilter === "all" || hasFilter(item, catalogFilter)) &&
      hasFilter(item, source) &&
      includesQuery(item, catalogSearch),
  );

  return (
    <section
      className={classNames("shell-view shell-page-view", active && "active")}
      data-filter-scope=""
      data-od-id="shell-view-agents"
      data-shell-view="agents"
      hidden={!active}
    >
      <div className="page-stack" data-filter-scope="">
        <header className="catalog-market-header" data-od-id="agents-header-inline">
          <FilterTabs
            active={catalogFilter}
            group="category"
            label="能力分类筛选"
            options={[
              { icon: <Bot aria-hidden="true" />, label: "员工", value: "employee" },
              { icon: <Wrench aria-hidden="true" />, label: "技能", value: "skill" },
              { icon: <Layers3 aria-hidden="true" />, label: "服务", value: "service" },
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
            <button className="button primary compact" type="button">
              新建个人能力
            </button>
          </div>
        </header>

        <section className="catalog-source-bar" data-od-id="agent-filters-inline">
          <SourceTabs
            active={source}
            group="source"
            label="来源筛选"
            options={[
              { label: "个人能力", value: "personal" },
              { label: "市场", value: "market" },
            ]}
            onChange={setSource}
          />
        </section>

        <section className="capability-catalog" data-od-id="agent-capability-catalog">
          {visibleCards.map((item) => (
            <CatalogCard item={item} key={item.id} />
          ))}
          <div className="filter-empty-state" data-filter-empty="" hidden={visibleCards.length > 0}>
            没有匹配项
          </div>
        </section>
      </div>
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
      data-od-id={kind === "personal" ? "schedule-calendar-personal" : "schedule-calendar-team"}
      hidden={hidden}
    >
      <div className="calendar-month" aria-label={kind === "personal" ? "个人日历" : "小队日历"}>
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
          <span className={classNames("status", kind === "personal" ? "success" : "warn")}>
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
        <header className="catalog-market-header function-market-header" data-od-id="schedule-header-inline">
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
            <button className="button primary" type="button" onClick={onOpenModal}>
              新建安排
            </button>
          </div>
        </header>

        <section className="catalog-source-bar" data-od-id="schedule-filters-inline">
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
          <span className="catalog-context-note">今天 4 项安排 · 2 项执行中 · 1 个结果待确认</span>
        </section>

        <CalendarPanel
          agenda={[
            ["09:00", "审批待确认 Gate", "安排：审阅需求拆解；状态：等待你确认；产出：任务分解摘要。", "待确认", "warn"],
            ["11:30", "个人周报草稿", "安排：汇总本周项目变化；状态：执行完成；产出：周报草稿可编辑。", "已产出", "success"],
            ["16:00", "设计走查提醒", "安排：检查能力库与日程页；状态：待开始；产出：检查清单。", "待开始", ""],
          ]}
          hidden={scheduleMode !== "calendar" || scheduleSource !== "personal"}
          kind="personal"
        />
        <CalendarPanel
          agenda={[
            ["10:00", "Code Review 安排", "安排：PR 更新后触发审阅智能体；状态：运行中；产出：高风险结果推到 Gate。", "运行中", "success"],
            ["14:00", "需求 Gate 超时", "安排：72h 未确认自动驳回；状态：待人介入；产出：驳回说明草稿。", "待确认", "warn"],
            ["17:30", "小队日报推送", "安排：汇总执行状态、失败重试和完成报告；状态：待开始；产出：Channel 草稿。", "待开始", ""],
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
        <div className="filter-empty-state" data-filter-empty="" hidden={scheduleMode !== "arrangement" || visibleArrangementCards.length > 0}>
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
        <section className="arrangement-modal-card" data-od-id="schedule-arrangement-modal">
          <header className="arrangement-modal-header">
            <h2 id="schedule-arrangement-title">创建任务安排</h2>
            <button className="icon-action compact" type="button" aria-label="关闭" onClick={onCloseModal}>
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
              <button className="active" type="button">周期</button>
              <button type="button">按间隔</button>
              <button type="button">单次</button>
            </div>
          </div>
          <footer className="arrangement-modal-actions">
            <button className="button" type="button" onClick={onCloseModal}>
              取消
            </button>
            <button className="button primary" type="button" onClick={onCloseModal}>
              创建
            </button>
          </footer>
        </section>
      </div>
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
        <header className="catalog-market-header function-market-header" data-od-id="team-header-inline">
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
            <button className="button primary" type="button" data-team-action="office" hidden={teamMode !== "office"}>
              创建办公室
            </button>
            <button className="button primary" type="button" data-team-action="workflow" hidden={teamMode !== "workflow"}>
              创建协作流
            </button>
            <button className="button primary" type="button" data-team-action="experts" hidden={teamMode !== "experts"}>
              创建专家团
            </button>
          </div>
        </header>

        <section className="catalog-source-bar" data-od-id="team-filters-inline">
          <span className="catalog-context-note">
            团队能力来自左侧智能体页 · 办公室可 @ 任意员工 · 专家团只和组长对话
          </span>
        </section>

        <section
          className={classNames("team-office-shell", officeRoomId && "is-room-open")}
          data-card-filter="office"
          data-office-shell=""
          data-od-id="team-office-shell"
          hidden={teamMode !== "office" && !officeRoomId}
        >
          <div className="office-card-grid" data-office-list="" aria-label="办公室卡片" hidden={Boolean(officeRoomId)}>
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
                  <em className={classNames("status", room.statusTone)}>{room.status}</em>
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
          className={classNames("team-workflow-shell", workflowRoomId && "is-room-open")}
          data-card-filter="workflow"
          data-od-id="team-workflow-shell"
          data-workflow-shell=""
          hidden={teamMode !== "workflow" && !workflowRoomId}
        >
          <div className="workflow-list" data-workflow-list="" aria-label="协作流列表" hidden={Boolean(workflowRoomId)}>
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
                  <em className={classNames("status", room.statusTone)}>{room.status}</em>
                </span>
                <span className="workflow-list-meta">
                  <span className="workflow-list-copy">{room.stage}</span>
                  <span className="workflow-member-strip" aria-label="协作流成员">
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

        <section className="team-experts-shell" data-card-filter="experts" data-od-id="team-experts-shell" hidden={teamMode !== "experts"}>
          <div className="expert-team-grid" aria-label="专家团卡片">
            {[
              ["主页可选", "产品交付专家团", "用户只和组长智能体多轮澄清；员工在后台协作，不展示办公室群聊。", "设为主页可选"],
              ["后台执行", "代码审查专家团", "组长接收需求，后台调度 Code Review Skill、Filesystem MCP 和 GitHub MCP。", "后台执行"],
              ["草稿", "会议准备专家团", "组长负责澄清会议目标，后台员工整理议程、参会人上下文和材料清单。", "继续配置"],
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
      data-od-id={isWorkflow ? "team-workflow-room-inline" : "team-office-room-inline"}
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
        <div className={isWorkflow ? "workflow-room-title-block" : "office-room-title-block"}>
          <span>{isWorkflow ? "协作流群聊" : "办公室群聊"}</span>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <div className={isWorkflow ? "workflow-room-actions" : "office-room-actions"}>
          <span className={classNames("status", isWorkflow && "warn")}>
            {isWorkflow ? "按节点推进" : "执行中"}
          </span>
          <button className="button compact" type="button" onClick={() => onTabChange("members")}>
            成员
          </button>
        </div>
      </header>

      {isWorkflow ? (
        <main className="workflow-room-stage">
          <section className="workflow-execution-strip" data-od-id="workflow-execution-strip" aria-label="执行步节点流">
            {[
              ["01", "接收目标", "协作流组长智能体", "完成", "is-done"],
              ["02", "界面风险审阅", "产品审阅智能体", "运行中", "is-running"],
              ["03", "实现拆解", "开发交付智能体", "排队", ""],
              ["04", "人工 Gate", "真实员工 · 设计负责人", "待确认", ""],
            ].map(([step, stepTitle, owner, state, className]) => (
              <article className={classNames("workflow-step-node", className)} key={step}>
                <span>{step}</span>
                <div>
                  <strong>{stepTitle}</strong>
                  <p>{owner}</p>
                </div>
                <em className={classNames("status", className === "is-done" && "success", className === "is-running" && "warn")}>
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
        className={isWorkflow ? "workflow-tab-panel office-chat-panel" : "office-tab-panel office-chat-panel"}
        data-tab-panel=""
        hidden={tab !== "chat"}
        id={`${prefix}-chat-panel`}
      >
        <div className={isWorkflow ? "workflow-room-thread" : "office-room-thread"} role="log" aria-label="团队群聊">
          {messages.map((message, index) => (
            <article
              className={classNames("office-room-message", index === 0 && "is-user")}
              key={message}
            >
              <span className="team-avatar">{index === 0 ? "你" : isWorkflow ? "流" : "组"}</span>
              <div>
                <strong>{index === 0 ? "你" : isWorkflow ? "协作流组长智能体" : "办公室组长智能体"}</strong>
                <p>{message}</p>
              </div>
            </article>
          ))}
        </div>
        <section className={classNames("command-input", isWorkflow ? "workflow-global-composer" : "office-global-composer")}>
          <textarea
            data-composer=""
            placeholder={isWorkflow ? "@ 指定阶段 Agent；/ 调用 Skill 或 MCP" : "@ 指定员工；留空默认交给办公室组长"}
            defaultValue={isWorkflow ? "继续推进这个协作流..." : "告诉组长目标、背景或下一步..."}
          />
          <div className="input-tools">
            <div className="composer-controls">
              <div className="control-select mode-dropdown" aria-label="任务类型">
                <select defaultValue="plan">
                  <option value="plan">计划</option>
                  <option value="goal">目标</option>
                  <option value="agent">智能体</option>
                </select>
              </div>
              <div className="control-select permission-dropdown" aria-label="权限选择">
                <select defaultValue="request-approval">
                  <option value="request-approval">请求批准</option>
                  <option value="approve-for-me">替我审批</option>
                  <option value="full-access">完全访问</option>
                </select>
              </div>
            </div>
            <div className="composer-actions">
              <button className="icon-action prompt-action" type="button" aria-label="优化提示词">
                Aa
              </button>
              <button className="send-button" type="button" aria-label="发送">
                <ArrowUp aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="composer-state-row">
            <span className="composer-state">{isWorkflow ? "协作流 · 等待输入" : "办公室 · 等待输入"}</span>
          </div>
        </section>
      </section>

      <section className="office-tab-panel office-run-panel" data-tab-panel="" hidden={tab !== "run"} id={`${prefix}-run-panel`}>
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

      <section className="office-tab-panel office-memory-panel" data-tab-panel="" hidden={tab !== "memory"} id={`${prefix}-memory-panel`}>
        <div className="office-memory-list">
          {["页面交付先保留蓝灰轻工作台语言", "高风险输出必须进入人工确认 Gate"].map((memory) => (
            <article className="office-memory-card" key={memory}>
              <span>决策</span>
              <strong>{memory}</strong>
              <p>来源：团队页群聊 · 可见：组长、产品审阅、开发交付</p>
              <button type="button">查看来源</button>
            </article>
          ))}
        </div>
      </section>

      <section className="office-tab-panel office-memory-panel" data-tab-panel="" hidden={tab !== "members"} id={`${prefix}-members-panel`}>
        <div className="office-memory-list">
          {["办公室组长智能体", "产品审阅智能体", "开发交付智能体", "真实员工 · 设计负责人"].map((member) => (
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
