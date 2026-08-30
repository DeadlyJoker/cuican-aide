import { MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";

import { latestOfficeTaskRun } from "../../lib/office/latestOfficeTaskRun";
import {
  isControlOfficeDefinitionRecord,
  officeMemberDisplayName,
  officeRecordKey,
  type OfficeConfigRecordReference,
} from "../../lib/office/officePanelFromRecord";
import { officeManagerPresentation } from "../../lib/office/officeManagerPresentation";
import { CommandTeamEmptyState } from "./CommandTeamEmptyState";
import { classNames } from "./commandWorkspaceUtils";

type OfficeCatalogStatus = "loading" | "ready" | "unavailable";

export type CommandOfficeRoomProps = {
  definitionOnly?: boolean;
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
    const leaderName =
      (record.definition.members[0]
        ? officeMemberDisplayName(record.definition.members[0].displayName, 0)
        : null) ?? "待配置组长";
    return {
      current: "可开始群聊",
      status: officeStatus(record),
      subtitle: `组长 · ${leaderName} · ${record.definition.members.length} 名成员`,
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

function officeCardMembers(record: OfficeConfigRecordReference) {
  const members = isControlOfficeDefinitionRecord(record)
    ? record.definition.members.map((member, index) =>
        officeMemberDisplayName(member.displayName, index),
      )
    : record.config.workspace.members.map((member) => member.name);
  return {
    count: members.length,
    names: members,
  };
}

function officeCatalogPresentation(
  status: OfficeCatalogStatus,
  definitionOnly: boolean,
) {
  if (definitionOnly) {
    switch (status) {
      case "loading":
        return {
          description: "正在加载办公室和成员信息。",
          stateLabel: "正在加载",
          title: "正在打开办公室",
        };
      case "unavailable":
        return {
          description: "暂时无法读取办公室信息，稍后会自动重试。",
          stateLabel: "等待自动重试",
          title: "暂时无法打开办公室",
        };
      case "ready":
        return {
          description: "创建办公室并选择成员，就可以开始群聊和协作。",
          stateLabel: "还没有办公室",
          title: "创建第一个办公室",
        };
    }
  }
  switch (status) {
    case "loading":
      return {
        description: "正在加载办公室和成员信息。",
        stateLabel: "正在加载",
        title: "正在打开办公室",
      };
    case "unavailable":
      return {
        description: "暂时无法读取办公室信息，稍后会自动重试。",
        stateLabel: "等待自动重试",
        title: "暂时无法打开办公室",
      };
    case "ready":
      return {
        description: "创建办公室并选择成员，就可以开始群聊和协作。",
        stateLabel: "当前工作空间还没有办公室",
        title: "创建你的第一个办公室",
      };
  }
}

function OfficeCatalogLanding({
  definitionOnly,
  status,
  onCreate,
  onRetry,
}: {
  definitionOnly: boolean;
  status: OfficeCatalogStatus;
  onCreate?: () => void;
  onRetry?: () => void;
}) {
  const presentation = officeCatalogPresentation(status, definitionOnly);
  const action =
    status === "ready" && onCreate
      ? { label: "创建办公室", onClick: onCreate, primary: true }
      : status === "unavailable" && onRetry
        ? { label: "立即重试", onClick: onRetry, primary: false }
        : null;

  return (
    <div data-office-empty-state={status}>
      <CommandTeamEmptyState
        action={action}
        description={presentation.description}
        eyebrow="办公室"
        icon={MessagesSquare}
        state={status === "ready" ? "empty" : status}
        statusLabel={presentation.stateLabel}
        title={presentation.title}
      />
    </div>
  );
}

export function CommandOfficeRoom({
  definitionOnly = false,
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
            const members = officeCardMembers(record);
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
                <span
                  className="office-card-members"
                  aria-label={`${members.count} 名成员`}
                >
                  <span
                    className="office-card-member-avatars"
                    aria-hidden="true"
                  >
                    {members.names.slice(0, 4).map((name, index) => (
                      <i key={`${name}-${index}`}>
                        {Array.from(name.trim())[0] || "员"}
                      </i>
                    ))}
                  </span>
                  <span>
                    {members.names.length > 0
                      ? members.names.slice(0, 3).join("、")
                      : "等待添加成员"}
                  </span>
                  <em>{members.count} 人</em>
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
            definitionOnly={definitionOnly}
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
            正在连接办公室群聊…
          </div>
        )}
      </section>
    </>
  );
}
