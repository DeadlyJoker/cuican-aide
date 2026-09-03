import {
  BookOpen,
  Bot,
  ChevronRight,
  CircleAlert,
  FileImage,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Laptop,
  Link2,
  LoaderCircle,
  Package,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { Locale } from "../../lib/i18n";
import "./TaskDetailPopover.css";

export const DEFAULT_TASK_DETAIL_POPOVER_ID = "task-detail-popover";

export type TaskDetailLoadable<T> = {
  status: "loading" | "ready" | "error" | "unavailable";
  data?: T;
  error?: string | null;
  unavailableReason?: string | null;
};

export type TaskDetailCollection<T> = {
  items: readonly T[];
  summary?: string | null;
  total?: number;
};

export type TaskDetailEnvironmentPresentation = {
  branch?: { detail?: string | null; label: string } | null;
  changes?: {
    added: number;
    detail?: string | null;
    files?: number;
    removed: number;
  } | null;
  reviewLabel?: string | null;
  status?: {
    label: string;
    tone?: "neutral" | "success" | "warning" | "danger";
  } | null;
  target?: string | null;
  workspace?: string | null;
};

export type TaskDetailAgentPresentation = {
  detail?: string | null;
  id: string;
  name: string;
  role?: string | null;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "interrupted"
    | "unknown";
};

export type TaskDetailProcessPresentation = {
  canTerminate?: boolean;
  command: string;
  detail?: string | null;
  processId: string;
  status: "running" | "stopping" | "completed" | "failed" | "unknown";
};

export type TaskDetailSourcePresentation = {
  detail?: string | null;
  id: string;
  kind: "file" | "image" | "link" | "knowledge" | "skill" | "mcp" | "other";
  label: string;
  thumbnailUrl?: string | null;
};

export type TaskDetailPresentation = {
  environment: TaskDetailLoadable<TaskDetailEnvironmentPresentation | null>;
  agents: TaskDetailLoadable<TaskDetailCollection<TaskDetailAgentPresentation>>;
  sources: TaskDetailLoadable<
    TaskDetailCollection<TaskDetailSourcePresentation>
  >;
  title?: string | null;
};

export type TaskDetailPopoverProps = {
  className?: string;
  escapeOwner?: "popover" | "route";
  id?: string;
  interactionInactive?: boolean;
  locale?: Locale;
  onClose: (options: { restoreFocus?: boolean }) => void;
  onOpenReview?: () => void;
  onOpenTerminal?: () => void;
  onStopTask?: () => void;
  onTerminateProcess?: (processId: string) => void;
  open: boolean;
  presentation: TaskDetailPresentation;
  processes: TaskDetailLoadable<
    TaskDetailCollection<TaskDetailProcessPresentation>
  >;
  stopTaskPending?: boolean;
  style?: CSSProperties;
};

const COPY = {
  zh: {
    title: "任务详细信息",
    close: "关闭任务详细信息",
    environment: "环境信息",
    changes: "变更",
    files: "个文件",
    workspace: "工作区",
    branch: "分支",
    status: "状态",
    review: "查看变更",
    agents: "子智能体",
    processes: "后台进程",
    sources: "来源",
    terminal: "打开终端",
    stopTask: "停止任务",
    stoppingTask: "正在停止任务",
    stop: "停止进程",
    confirm: "确认终止",
    loading: "正在读取",
    unavailable: "当前运行环境未提供",
    emptyEnvironment: "暂无环境信息",
    emptyAgents: "暂无子智能体",
    emptyProcesses: "暂无后台进程",
    emptySources: "暂无来源",
    agentStatus: {
      pending: "等待中",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      interrupted: "已中断",
      unknown: "未知",
    },
    processStatus: {
      running: "运行中",
      stopping: "停止中",
      completed: "已结束",
      failed: "异常",
      unknown: "未知",
    },
  },
  en: {
    title: "Task details",
    close: "Close task details",
    environment: "Environment",
    changes: "Changes",
    files: "files",
    workspace: "Workspace",
    branch: "Branch",
    status: "Status",
    review: "Review changes",
    agents: "Subagents",
    processes: "Background processes",
    sources: "Sources",
    terminal: "Open terminal",
    stopTask: "Stop task",
    stoppingTask: "Stopping task",
    stop: "Stop process",
    confirm: "Confirm stop",
    loading: "Loading",
    unavailable: "Unavailable in the current runtime",
    emptyEnvironment: "No environment information",
    emptyAgents: "No subagents",
    emptyProcesses: "No background processes",
    emptySources: "No sources",
    agentStatus: {
      pending: "Pending",
      running: "Running",
      completed: "Completed",
      failed: "Failed",
      interrupted: "Interrupted",
      unknown: "Unknown",
    },
    processStatus: {
      running: "Running",
      stopping: "Stopping",
      completed: "Finished",
      failed: "Failed",
      unknown: "Unknown",
    },
  },
} as const;

type Copy = (typeof COPY)[Locale];

export function handleTaskDetailPopoverEscape(
  event: Pick<KeyboardEvent, "defaultPrevented" | "key" | "preventDefault">,
  onClose: (options: { restoreFocus?: boolean }) => void,
): boolean {
  if (event.defaultPrevented || event.key !== "Escape") return false;
  event.preventDefault();
  onClose({ restoreFocus: true });
  return true;
}

export function advanceTaskDetailProcessTermination(
  currentProcessId: string | null,
  requestedProcessId: string,
  onTerminate: (processId: string) => void,
): string | null {
  if (currentProcessId !== requestedProcessId) return requestedProcessId;
  onTerminate(requestedProcessId);
  return null;
}

export function formatTaskDetailCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    maximumFractionDigits: 0,
  }).format(Math.max(0, Math.trunc(value)));
}

function count<T>(loadable: TaskDetailLoadable<TaskDetailCollection<T>>) {
  const data = loadable.data;
  return data ? (data.summary ?? data.total ?? data.items.length) : null;
}

function Tone({ label, tone = "neutral" }: { label: string; tone?: string }) {
  return (
    <span className="task-detail-tone" data-tone={tone}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

function Row({
  icon,
  label,
  detail,
  trailing,
  mono,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string | null;
  trailing?: ReactNode;
  mono?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span aria-hidden="true" className="task-detail-row__icon">
        {icon}
      </span>
      <span className="task-detail-row__copy">
        <strong className={mono ? "is-mono" : undefined} title={label}>
          {label}
        </strong>
        {detail ? <small title={detail}>{detail}</small> : null}
      </span>
      {trailing ? (
        <span className="task-detail-row__trailing">{trailing}</span>
      ) : null}
    </>
  );
  return onClick ? (
    <button
      className="task-detail-row is-interactive"
      type="button"
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <div className="task-detail-row">{body}</div>
  );
}

function Section({
  title,
  loadable,
  hasContent,
  empty,
  countLabel,
  action,
  children,
  copy,
}: {
  title: string;
  loadable: TaskDetailLoadable<unknown>;
  hasContent: boolean;
  empty: string;
  countLabel?: number | string | null;
  action?: ReactNode;
  children?: ReactNode;
  copy: Copy;
}) {
  return (
    <section className="task-detail-section" data-status={loadable.status}>
      <header>
        <h3>{title}</h3>
        <span className="task-detail-section__meta">
          {loadable.status === "loading" ? (
            <LoaderCircle
              aria-label={copy.loading}
              className="task-detail-spin"
            />
          ) : null}
          {loadable.status === "error" ? (
            <CircleAlert aria-label={loadable.error ?? "Error"} />
          ) : null}
          {countLabel !== null && countLabel !== undefined ? (
            <span>{countLabel}</span>
          ) : null}
          {action}
        </span>
      </header>
      {hasContent ? (
        <div className="task-detail-section__rows">{children}</div>
      ) : null}
      {loadable.status === "loading" && !hasContent ? (
        <div aria-hidden="true" className="task-detail-skeleton">
          <i />
          <i />
          <i />
        </div>
      ) : null}
      {loadable.status === "error" ? (
        <p className="task-detail-feedback is-error" role="status">
          <CircleAlert aria-hidden="true" />
          {loadable.error}
        </p>
      ) : null}
      {loadable.status === "unavailable" ? (
        <p className="task-detail-feedback">
          {loadable.unavailableReason ?? copy.unavailable}
        </p>
      ) : null}
      {loadable.status === "ready" && !hasContent ? (
        <p className="task-detail-feedback">{empty}</p>
      ) : null}
    </section>
  );
}

function sourceIcon(kind: TaskDetailSourcePresentation["kind"]) {
  if (kind === "image") return <FileImage />;
  if (kind === "link") return <Link2 />;
  if (kind === "knowledge") return <BookOpen />;
  if (kind === "skill") return <Wrench />;
  if (kind === "mcp") return <Package />;
  return <FileText />;
}

function environmentHasData(
  value: TaskDetailEnvironmentPresentation | null | undefined,
) {
  return Boolean(
    value &&
      (value.branch ||
        value.changes ||
        value.reviewLabel ||
        value.status ||
        value.target ||
        value.workspace),
  );
}

function processTone(status: TaskDetailProcessPresentation["status"]) {
  return status === "failed"
    ? "danger"
    : status === "completed"
      ? "success"
      : "neutral";
}

export function TaskDetailPopover({
  className,
  escapeOwner = "popover",
  id = DEFAULT_TASK_DETAIL_POPOVER_ID,
  interactionInactive = false,
  locale = "zh",
  onClose,
  onOpenReview,
  onOpenTerminal,
  onStopTask,
  onTerminateProcess,
  open,
  presentation,
  processes,
  stopTaskPending = false,
  style,
}: TaskDetailPopoverProps) {
  const [confirmProcessId, setConfirmProcessId] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const copy: Copy = COPY[locale];

  useEffect(() => {
    if (!open) {
      setConfirmProcessId(null);
      return;
    }
    if (interactionInactive) {
      return;
    }
    if (escapeOwner === "route") {
      closeButtonRef.current?.focus({ preventScroll: true });
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const target =
        event.target instanceof Element ? event.target : document.activeElement;
      const popover = document.getElementById(id);
      const ownsFocus =
        target instanceof Element &&
        (popover?.contains(target) === true ||
          target.getAttribute("aria-controls") === id);
      if (!ownsFocus) return;
      handleTaskDetailPopoverEscape(event, (options) => {
        setConfirmProcessId(null);
        onClose(options);
      });
    };
    document.addEventListener("keydown", onKeyDown);
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [escapeOwner, id, interactionInactive, onClose, open]);

  if (!open) return null;
  const close = () => {
    setConfirmProcessId(null);
    onClose({ restoreFocus: true });
  };
  const environment = presentation.environment.data;
  const agents = presentation.agents.data;
  const processData = processes.data;
  const sources = presentation.sources.data;
  const titleId = `${id}-title`;

  return (
    <aside
      aria-hidden={interactionInactive || undefined}
      aria-labelledby={titleId}
      aria-modal="false"
      className={["task-detail-popover", className].filter(Boolean).join(" ")}
      id={id}
      inert={interactionInactive || undefined}
      role="dialog"
      style={style}
      tabIndex={-1}
    >
      <header className="task-detail-popover__header">
        <h2 id={titleId}>{presentation.title ?? copy.title}</h2>
        <span className="task-detail-popover__actions">
          {onStopTask ? (
            <button
              aria-busy={stopTaskPending || undefined}
              aria-label={stopTaskPending ? copy.stoppingTask : copy.stopTask}
              className="task-detail-icon-button is-danger"
              data-pending={stopTaskPending || undefined}
              disabled={stopTaskPending}
              title={stopTaskPending ? copy.stoppingTask : copy.stopTask}
              type="button"
              onClick={onStopTask}
            >
              {stopTaskPending ? (
                <LoaderCircle aria-hidden="true" className="task-detail-spin" />
              ) : (
                <Square aria-hidden="true" />
              )}
            </button>
          ) : null}
          <button
            ref={closeButtonRef}
            aria-label={copy.close}
            className="task-detail-icon-button task-detail-popover__close"
            type="button"
            onClick={close}
          >
            <X aria-hidden="true" />
          </button>
        </span>
      </header>
      <div className="task-detail-popover__content">
        <Section
          copy={copy}
          title={copy.environment}
          loadable={presentation.environment}
          hasContent={environmentHasData(environment)}
          empty={copy.emptyEnvironment}
        >
          {environment?.changes ? (
            <Row
              icon={<GitCommitHorizontal />}
              label={copy.changes}
              detail={
                [
                  environment.changes.files === undefined
                    ? null
                    : `${formatTaskDetailCount(environment.changes.files, locale)} ${copy.files}`,
                  environment.changes.detail,
                ]
                  .filter(Boolean)
                  .join(" · ") || null
              }
              onClick={onOpenReview}
              trailing={
                <span className="task-detail-change">
                  <b>
                    +{formatTaskDetailCount(environment.changes.added, locale)}
                  </b>
                  <b>
                    -
                    {formatTaskDetailCount(environment.changes.removed, locale)}
                  </b>
                  {onOpenReview ? <ChevronRight /> : null}
                </span>
              }
            />
          ) : null}
          {environment?.target || environment?.workspace ? (
            <Row
              icon={<Laptop />}
              label={environment.target ?? copy.workspace}
              detail={environment.workspace}
            />
          ) : null}
          {environment?.branch ? (
            <Row
              icon={<GitBranch />}
              label={copy.branch}
              detail={environment.branch.detail}
              trailing={environment.branch.label}
            />
          ) : null}
          {environment?.status ? (
            <Row
              icon={<Package />}
              label={copy.status}
              trailing={
                <Tone
                  label={environment.status.label}
                  tone={environment.status.tone}
                />
              }
            />
          ) : null}
          {environment?.reviewLabel && !environment.changes ? (
            <Row
              icon={<GitCommitHorizontal />}
              label={environment.reviewLabel}
              onClick={onOpenReview}
              trailing={onOpenReview ? <ChevronRight /> : null}
            />
          ) : null}
        </Section>
        <Section
          copy={copy}
          title={copy.agents}
          loadable={presentation.agents}
          hasContent={Boolean(agents?.items.length)}
          empty={copy.emptyAgents}
          countLabel={count(presentation.agents)}
        >
          {agents?.items.map((agent) => (
            <Row
              key={agent.id}
              icon={<Bot />}
              label={agent.name}
              detail={
                [agent.role, agent.detail].filter(Boolean).join(" · ") || null
              }
              trailing={
                <Tone
                  label={copy.agentStatus[agent.status]}
                  tone={
                    agent.status === "completed"
                      ? "success"
                      : agent.status === "failed"
                        ? "danger"
                        : agent.status === "interrupted"
                          ? "warning"
                          : "neutral"
                  }
                />
              }
            />
          ))}
        </Section>
        <Section
          copy={copy}
          title={copy.processes}
          loadable={processes}
          hasContent={Boolean(processData?.items.length)}
          empty={copy.emptyProcesses}
          countLabel={count(processes)}
          action={
            onOpenTerminal ? (
              <button
                aria-label={copy.terminal}
                className="task-detail-icon-button"
                type="button"
                onClick={onOpenTerminal}
              >
                <Terminal aria-hidden="true" />
              </button>
            ) : null
          }
        >
          {processData?.items.map((process) => {
            const confirming = confirmProcessId === process.processId;
            const canTerminate =
              Boolean(onTerminateProcess) &&
              process.canTerminate !== false &&
              process.status === "running";
            return (
              <Row
                key={process.processId}
                icon={<Terminal />}
                label={process.command}
                detail={process.detail}
                mono
                trailing={
                  <span className="task-detail-process">
                    <Tone
                      label={copy.processStatus[process.status]}
                      tone={processTone(process.status)}
                    />
                    {canTerminate ? (
                      <button
                        aria-label={`${confirming ? copy.confirm : copy.stop}: ${process.command}`}
                        className="task-detail-stop"
                        data-confirming={confirming || undefined}
                        type="button"
                        onClick={() =>
                          setConfirmProcessId(
                            advanceTaskDetailProcessTermination(
                              confirmProcessId,
                              process.processId,
                              onTerminateProcess!,
                            ),
                          )
                        }
                      >
                        {confirming ? (
                          copy.confirm
                        ) : (
                          <Square aria-hidden="true" />
                        )}
                      </button>
                    ) : null}
                  </span>
                }
              />
            );
          })}
        </Section>
        <Section
          copy={copy}
          title={copy.sources}
          loadable={presentation.sources}
          hasContent={Boolean(sources?.items.length)}
          empty={copy.emptySources}
          countLabel={count(presentation.sources)}
        >
          {sources?.items.map((source) => (
            <Row
              key={source.id}
              icon={
                source.thumbnailUrl ? (
                  <img alt="" loading="lazy" src={source.thumbnailUrl} />
                ) : (
                  sourceIcon(source.kind)
                )
              }
              label={source.label}
              detail={source.detail}
            />
          ))}
        </Section>
      </div>
    </aside>
  );
}
