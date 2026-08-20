import { GitBranch, ShieldCheck, Users } from "lucide-react";
import { useId, type ReactNode } from "react";

import { latestOfficeTaskRun } from "../../lib/office/latestOfficeTaskRun";
import {
  isControlOfficeDefinitionRecord,
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
  if (isControlOfficeDefinitionRecord(record)) {
    return { label: "已发布", tone: undefined };
  }
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
  if (isControlOfficeDefinitionRecord(record)) {
    return {
      current: "通过 Workflow 显式委派",
      status: officeStatus(record),
      subtitle: `Control 定义 · ${record.definition.members.length} 名成员`,
    };
  }
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
        description: "正在从 Control 读取已发布的 Office 定义与成员边界。",
        stateLabel: "正在同步 Office 定义",
        title: "正在载入 Office 定义",
      };
    case "unavailable":
      return {
        description:
          "Control Office 定义暂时无法读取，系统会自动重试；不会使用演示数据替代。",
        stateLabel: "等待自动重试",
        title: "Office 定义暂不可用",
      };
    case "ready":
      return {
        description:
          "发布成员与 AgentVersion 的固定边界，再通过显式 Workflow 委派启动 canonical Run。",
        stateLabel: "当前空间还没有 Office 定义",
        title: "创建第一个 Office 定义",
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
        ? { label: "立即重试", onClick: onRetry, primary: false }
        : null;

  return (
    <section
      aria-labelledby={titleId}
      className="team-office-empty"
      data-office-empty-state={status}
    >
      <header className="team-office-empty-head">
        <span className="team-office-empty-kicker">CONTROL OFFICE</span>
        <h3 id={titleId}>{presentation.title}</h3>
        <p>{presentation.description}</p>
      </header>

      {status === "ready" ? (
        <div
          aria-label="Office 定义边界"
          className="team-office-capability-grid"
        >
          <article className="team-office-capability">
            <span aria-hidden="true">
              <Users />
            </span>
            <div>
              <strong>成员边界</strong>
              <p>固定成员身份与显示名称，不推断在线或运行状态。</p>
            </div>
          </article>
          <article className="team-office-capability">
            <span aria-hidden="true">
              <ShieldCheck />
            </span>
            <div>
              <strong>AgentVersion 绑定</strong>
              <p>成员绑定已发布 AgentVersion，Control 保留版本与权限边界。</p>
            </div>
          </article>
          <article className="team-office-capability">
            <span aria-hidden="true">
              <GitBranch />
            </span>
            <div>
              <strong>Workflow 委派</strong>
              <p>查看定义后显式选择 WorkflowVersion，启动 canonical Run。</p>
            </div>
          </article>
        </div>
      ) : null}

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
      ...(isControlOfficeDefinitionRecord(record)
        ? record.definition.members.flatMap((member) => [
            member.displayName,
            member.agentVersionId,
          ])
        : [
            record.config.workspace.goal,
            ...record.config.workspace.members.flatMap((member) => [
              member.name,
              member.role,
            ]),
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
                  <span className="office-card-glyph" aria-hidden="true">
                    {record.config.title.trim().charAt(0) || "办"}
                  </span>
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
                  <em>
                    {isControlOfficeDefinitionRecord(record)
                      ? "查看与委派"
                      : "进入群聊"}
                  </em>
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
            正在读取 Office 定义…
          </div>
        )}
      </section>
    </>
  );
}
