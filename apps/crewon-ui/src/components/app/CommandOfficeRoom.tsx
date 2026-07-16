import { BrainCircuit, ListChecks, MessageSquareText } from "lucide-react";
import { useId, type ReactNode } from "react";

import { latestOfficeTaskRun } from "../../lib/office/latestOfficeTaskRun";
import {
  officeRecordKey,
  type OfficeConfigRecordReference,
} from "../../lib/office/officePanelFromRecord";
import { officeManagerPresentation } from "../../lib/office/officeManagerPresentation";
import { classNames } from "./commandWorkspaceUtils";

type OfficeCatalogStatus = "loading" | "ready" | "unavailable";

export type CommandOfficeRoomProps = {
  isOpen: boolean;
  records: OfficeConfigRecordReference[];
  room: ReactNode;
  query?: string;
  selectedRecordKey: string | null;
  status: OfficeCatalogStatus;
  workspaceCwd?: string;
  onCreate?: () => void;
  onOpen: (record: OfficeConfigRecordReference) => void;
  onRetry?: () => void;
};

function officeStatus(record: OfficeConfigRecordReference) {
  const run = latestOfficeTaskRun(record.config.workspace.activity?.runs);
  if (run) {
    switch (run.status) {
      case "queued":
        return { label: "排队中", tone: "warn" as const };
      case "running":
        return { label: "运行中", tone: "success" as const };
      case "canceling":
        return { label: "停止中", tone: "warn" as const };
      case "completed":
        return { label: "已完成", tone: "success" as const };
      case "failed":
        return { label: "失败", tone: "warn" as const };
      case "interrupted":
        return { label: "已中断", tone: "warn" as const };
    }
  }
  switch (record.config.workspace.backendStatus) {
    case "connected":
      return { label: "待命", tone: "success" as const };
    case "binding":
      return { label: "连接中", tone: "warn" as const };
    case "error":
      return { label: "连接异常", tone: "warn" as const };
    case "local":
    case undefined:
      return { label: "草稿", tone: undefined };
  }
}

export function commandOfficeCardPresentation(
  record: OfficeConfigRecordReference,
) {
  const { workspace } = record.config;
  const run = latestOfficeTaskRun(workspace.activity?.runs);
  const manager = officeManagerPresentation(workspace, "zh");
  return {
    current: run?.title
      ? `当前：${run.title}`
      : workspace.goal
        ? `目标：${workspace.goal}`
        : "等待目标",
    status: officeStatus(record),
    subtitle: `组长 · ${manager.name} · ${workspace.members.length} 员工`,
  };
}

function officeCatalogPresentation(status: OfficeCatalogStatus) {
  switch (status) {
    case "loading":
      return {
        description: "正在从当前工作空间读取真实办公室、成员和运行状态。",
        stateLabel: "正在同步真实办公室",
        title: "正在载入办公室",
      };
    case "unavailable":
      return {
        description:
          "连接 App Server 后，这里会展示当前工作空间的真实办公室；不会使用演示数据替代。",
        stateLabel: "App Server 未连接",
        title: "办公室运行态暂未连接",
      };
    case "ready":
      return {
        description:
          "把组长、员工、任务执行和长期上下文放进同一个可持续协作空间。",
        stateLabel: "当前工作空间还没有办公室",
        title: "创建你的第一个办公室",
      };
  }
}

function OfficeCatalogLanding({
  status,
  onCreate,
  onRetry,
}: {
  status: OfficeCatalogStatus;
  onCreate?: () => void;
  onRetry?: () => void;
}) {
  const titleId = useId();
  const presentation = officeCatalogPresentation(status);
  const action =
    status === "ready" && onCreate
      ? { label: "创建办公室", onClick: onCreate, primary: true }
      : status === "unavailable" && onRetry
        ? { label: "重新连接", onClick: onRetry, primary: false }
        : null;

  return (
    <section
      aria-labelledby={titleId}
      className="team-office-empty"
      data-office-empty-state={status}
    >
      <header className="team-office-empty-head">
        <span className="team-office-empty-kicker">OFFICE RUNTIME</span>
        <h3 id={titleId}>{presentation.title}</h3>
        <p>{presentation.description}</p>
      </header>

      <div aria-label="办公室能力" className="team-office-capability-grid">
        <article className="team-office-capability">
          <span aria-hidden="true">
            <MessageSquareText />
          </span>
          <div>
            <strong>群聊</strong>
            <p>向组长或指定员工发送消息，持续保留同一条协作主线。</p>
          </div>
        </article>
        <article className="team-office-capability">
          <span aria-hidden="true">
            <ListChecks />
          </span>
          <div>
            <strong>执行台</strong>
            <p>查看排队、执行、确认与完成状态，保持任务进度可追踪。</p>
          </div>
        </article>
        <article className="team-office-capability">
          <span aria-hidden="true">
            <BrainCircuit />
          </span>
          <div>
            <strong>记忆与上下文</strong>
            <p>沉淀办公室范围内的事实、偏好和决策，并控制可见边界。</p>
          </div>
        </article>
      </div>

      <footer className="team-office-empty-footer">
        <span
          className="team-office-connection-state"
          data-state={status}
          role="status"
        >
          {presentation.stateLabel}
        </span>
        {action ? (
          <button
            className={classNames("button", action.primary && "primary")}
            type="button"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ) : null}
      </footer>
    </section>
  );
}

export function CommandOfficeRoom({
  isOpen,
  records,
  room,
  query = "",
  selectedRecordKey,
  status,
  workspaceCwd,
  onCreate,
  onOpen,
  onRetry,
}: CommandOfficeRoomProps) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const validRecords = records.flatMap((record) => {
    const key = officeRecordKey(record);
    if (!key) {
      return [];
    }
    const searchableText = [
      record.config.title,
      record.config.subtitle,
      record.config.workspace.goal,
      ...record.config.workspace.members.flatMap((member) => [
        member.name,
        member.role,
      ]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return !normalizedQuery || searchableText.includes(normalizedQuery)
      ? [{ key, record }]
      : [];
  });
  const hasSearchMiss =
    normalizedQuery && records.length > 0 && !validRecords.length;
  return (
    <>
      <div
        className="office-card-grid"
        data-office-list=""
        aria-label="办公室卡片"
        hidden={isOpen}
      >
        {validRecords.length > 0 ? (
          validRecords.map(({ key, record }) => {
            const presentation = commandOfficeCardPresentation(record);
            return (
              <button
                className={classNames(
                  "office-card office-card-button",
                  selectedRecordKey === key && "is-active",
                )}
                data-office-open=""
                data-office-record-key={key}
                data-office-selected={
                  selectedRecordKey === key ? "true" : undefined
                }
                key={key}
                type="button"
                onClick={() => onOpen(record)}
              >
                <span className="office-card-head">
                  <strong>{record.config.title}</strong>
                  <em
                    className={classNames("status", presentation.status.tone)}
                  >
                    {presentation.status.label}
                  </em>
                </span>
                <span className="office-card-copy">
                  {presentation.subtitle}
                </span>
                <span className="office-card-foot">
                  <span title={presentation.current}>
                    {presentation.current}
                  </span>
                  <em>进入群聊</em>
                </span>
              </button>
            );
          })
        ) : hasSearchMiss ? (
          <div className="filter-empty-state" role="status">
            没有匹配“{query.trim()}”的真实办公室。
          </div>
        ) : (
          <OfficeCatalogLanding
            status={status}
            onCreate={onCreate}
            onRetry={onRetry}
          />
        )}
      </div>
      <section
        className="office-room-inline team-office-runtime-room"
        data-office-room=""
        data-workspace-cwd={workspaceCwd || undefined}
        hidden={!isOpen}
        tabIndex={-1}
      >
        {room ?? (
          <div className="team-office-room-loading" role="status">
            正在连接办公室运行态…
          </div>
        )}
      </section>
    </>
  );
}
