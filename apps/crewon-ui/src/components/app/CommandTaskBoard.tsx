import type { Thread } from "@crewon-ui-model/v2/Thread";
import { AlertCircle, CheckCircle2, LoaderCircle, Search } from "lucide-react";
import { useMemo, useState } from "react";

import type { Locale } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/shared/text";
import { sidebarThreadTitle } from "../SidebarPresentation";

export type CommandTaskStage = "active" | "attention" | "ready";

type TaskBoardColumn = Readonly<{
  icon: typeof LoaderCircle;
  id: CommandTaskStage;
  label: string;
}>;

const MAX_VISIBLE_TASKS = 30;

export function commandTaskStage(thread: Thread): CommandTaskStage {
  if (
    thread.status?.type === "active" ||
    thread.turns?.some((turn) => turn.status === "inProgress")
  ) {
    return "active";
  }
  const latestTurn = thread.turns?.at(-1);
  if (
    thread.status?.type === "systemError" ||
    latestTurn?.status === "failed" ||
    latestTurn?.status === "interrupted"
  ) {
    return "attention";
  }
  return "ready";
}

function columns(locale: Locale): TaskBoardColumn[] {
  return locale === "zh"
    ? [
        { icon: LoaderCircle, id: "active", label: "进行中" },
        { icon: AlertCircle, id: "attention", label: "需处理" },
        { icon: CheckCircle2, id: "ready", label: "可继续" },
      ]
    : [
        { icon: LoaderCircle, id: "active", label: "Running" },
        { icon: AlertCircle, id: "attention", label: "Needs attention" },
        { icon: CheckCircle2, id: "ready", label: "Ready" },
      ];
}

export function CommandTaskBoard({
  locale,
  selectedThreadId,
  threads,
  onSelectThread,
  stages,
  query = "",
}: {
  locale: Locale;
  selectedThreadId: string | null;
  threads: readonly Thread[];
  onSelectThread?: (threadId: string) => void;
  stages?: readonly CommandTaskStage[];
  query?: string;
}) {
  const visibleThreads = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return [...threads]
      .filter((thread) => {
        const stage = commandTaskStage(thread);
        if (stages && !stages.includes(stage)) return false;
        if (!normalizedQuery) return true;
        return [thread.name, thread.preview, thread.cwd]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      })
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, MAX_VISIBLE_TASKS);
  }, [query, stages, threads]);

  return (
    <section
      className="command-task-board"
      aria-label={locale === "zh" ? "任务看板" : "Task board"}
    >
      <header className="command-task-board-header">
        <div>
          <strong>{locale === "zh" ? "任务看板" : "Task board"}</strong>
          <p>
            {locale === "zh"
              ? "来自真实会话状态；打开卡片继续处理"
              : "Derived from live conversation state; open a card to continue"}
          </p>
        </div>
        <span>{visibleThreads.length}</span>
      </header>
      <div className="command-task-board-columns">
        {columns(locale).map((column) => {
          const tasks = visibleThreads.filter(
            (thread) => commandTaskStage(thread) === column.id,
          );
          const Icon = column.icon;
          return (
            <section
              className="command-task-column"
              data-task-stage={column.id}
              key={column.id}
            >
              <header>
                <span>
                  <Icon aria-hidden="true" />
                  <strong>{column.label}</strong>
                </span>
                <em>{tasks.length}</em>
              </header>
              <div className="command-task-column-list">
                {tasks.length === 0 ? (
                  <p className="command-task-column-empty">
                    {locale === "zh" ? "暂无任务" : "No tasks"}
                  </p>
                ) : (
                  tasks.map((thread) => (
                    <button
                      aria-current={
                        selectedThreadId === thread.id ? "true" : undefined
                      }
                      className="command-task-card"
                      data-thread-id={thread.id}
                      key={thread.id}
                      type="button"
                      onClick={() => onSelectThread?.(thread.id)}
                    >
                      <strong>
                        {sidebarThreadTitle(
                          thread,
                          locale === "zh" ? "未命名任务" : "Untitled task",
                        )}
                      </strong>
                      <span>
                        {thread.preview ||
                          (locale === "zh"
                            ? "打开任务查看详情"
                            : "Open the task for details")}
                      </span>
                      <small>
                        {formatRelativeTime(thread.updatedAt, locale)}
                      </small>
                    </button>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

export function CommandProjectBoardView({
  active,
  locale,
  selectedThreadId,
  threads,
  onNewTask,
  onSelectThread,
}: {
  active: boolean;
  locale: Locale;
  selectedThreadId: string | null;
  threads: readonly Thread[];
  onNewTask: () => void;
  onSelectThread: (threadId: string) => void;
}) {
  const [mode, setMode] = useState<"current" | "gates" | "delivery">("current");
  const [query, setQuery] = useState("");
  const visibleStages =
    mode === "gates"
      ? (["attention"] as const)
      : mode === "delivery"
        ? (["ready"] as const)
        : undefined;
  return (
    <section
      className={
        active
          ? "shell-view shell-page-view active"
          : "shell-view shell-page-view"
      }
      data-od-id="shell-view-projects"
      data-shell-view="projects"
      hidden={!active}
    >
      <div className="page-stack command-project-board-page">
        <header className="command-project-board-toolbar">
          <div>
            <span>{locale === "zh" ? "项目与执行" : "Projects and runs"}</span>
            <h2>{locale === "zh" ? "任务" : "Tasks"}</h2>
            <p>
              {locale === "zh"
                ? "按真实会话和运行状态组织；打开任务即可继续工作。"
                : "Organized by live conversation and run state; open a task to continue."}
            </p>
          </div>
          <button className="button primary" type="button" onClick={onNewTask}>
            {locale === "zh" ? "发起任务" : "Start task"}
          </button>
        </header>
        <div className="command-project-board-controls">
          <div
            className="segmented-tabs"
            role="tablist"
            aria-label={locale === "zh" ? "项目视图" : "Project view"}
          >
            {(["current", "gates", "delivery"] as const).map((tab) => (
              <button
                aria-selected={mode === tab}
                className={mode === tab ? "active" : undefined}
                key={tab}
                role="tab"
                type="button"
                onClick={() => setMode(tab)}
              >
                {tab === "current"
                  ? locale === "zh"
                    ? "当前任务"
                    : "Current"
                  : tab === "gates"
                    ? locale === "zh"
                      ? "待处理"
                      : "Needs attention"
                    : locale === "zh"
                      ? "可交付"
                      : "Ready to deliver"}
              </button>
            ))}
          </div>
          <label
            className="catalog-search"
            aria-label={locale === "zh" ? "搜索任务" : "Search tasks"}
          >
            <Search aria-hidden="true" />
            <input
              placeholder={
                locale === "zh"
                  ? "搜索任务、目录或内容"
                  : "Search task, folder, or content"
              }
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <CommandTaskBoard
          locale={locale}
          query={query}
          selectedThreadId={selectedThreadId}
          stages={visibleStages}
          threads={threads}
          onSelectThread={onSelectThread}
        />
      </div>
    </section>
  );
}
