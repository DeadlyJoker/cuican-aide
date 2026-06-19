import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";

import type { Locale } from "../lib/i18n";

function commandDurationLabel(
  durationMs: number | null,
  locale: Locale,
): string | null {
  if (!durationMs) {
    return null;
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return locale === "zh" ? `${seconds} 秒` : `${seconds}s`;
}

function commandExitLabel(
  exitCode: number | null | undefined,
  locale: Locale,
): string | null {
  if (exitCode === null || exitCode === undefined) {
    return null;
  }

  return locale === "zh" ? `退出码 ${exitCode}` : `exit ${exitCode}`;
}

function fileChangeStatusLabel(
  status: Extract<ThreadItem, { type: "fileChange" }>["status"],
  locale: Locale,
): string {
  switch (status) {
    case "inProgress":
      return locale === "zh" ? "编辑中" : "Editing";
    case "completed":
      return locale === "zh" ? "已编辑" : "Edited";
    case "failed":
      return locale === "zh" ? "失败" : "Failed";
    case "declined":
      return locale === "zh" ? "已拒绝" : "Declined";
  }
}

function fileChangeKindLabel(
  change: Extract<ThreadItem, { type: "fileChange" }>["changes"][number],
  locale: Locale,
): string {
  switch (change.kind.type) {
    case "add":
      return locale === "zh" ? "新增" : "add";
    case "delete":
      return locale === "zh" ? "删除" : "delete";
    case "update":
      return change.kind.move_path
        ? locale === "zh"
          ? "移动"
          : "move"
        : locale === "zh"
          ? "修改"
          : "edit";
  }
}

function diffStats(diff: string): { added: number; removed: number } {
  return diff.split("\n").reduce(
    (stats, line) => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return stats;
      }

      if (line.startsWith("+")) {
        return { ...stats, added: stats.added + 1 };
      }

      if (line.startsWith("-")) {
        return { ...stats, removed: stats.removed + 1 };
      }

      return stats;
    },
    { added: 0, removed: 0 },
  );
}

export function TranscriptCommandCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "commandExecution" }>;
  locale: Locale;
}) {
  const output = item.aggregatedOutput?.trim();
  const durationLabel = commandDurationLabel(item.durationMs, locale);
  const exitLabel = commandExitLabel(item.exitCode, locale);
  const statusLabel =
    [durationLabel, exitLabel].filter(Boolean).join(" · ") ||
    (locale === "zh" ? "运行中" : "running");

  return (
    <div className="tool-card command-card">
      <div className="tool-card-header command-card-header">
        <code>$ {item.command}</code>
        <span>{statusLabel}</span>
      </div>
      {output ? <pre>{output}</pre> : null}
    </div>
  );
}

export function TranscriptFileChangeCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "fileChange" }>;
  locale: Locale;
}) {
  const total = item.changes.reduce(
    (stats, change) => {
      const next = diffStats(change.diff);
      return {
        added: stats.added + next.added,
        removed: stats.removed + next.removed,
      };
    },
    { added: 0, removed: 0 },
  );

  return (
    <div className="tool-card file-change-card">
      <div className="tool-card-header file-change-header">
        <span>{fileChangeStatusLabel(item.status, locale)}</span>
        <strong>
          {item.changes.length}{" "}
          {locale === "zh"
            ? "个文件"
            : item.changes.length === 1
              ? "file"
              : "files"}
        </strong>
        <em className="file-change-stat">
          <span data-tone="added">+{total.added}</span>{" "}
          <span data-tone="removed">-{total.removed}</span>
        </em>
      </div>
      <div className="file-change-list">
        {item.changes.slice(0, 4).map((change) => {
          const stats = diffStats(change.diff);

          return (
            <div
              className="file-change-row"
              key={`${change.path}-${change.kind.type}`}
            >
              <span>{fileChangeKindLabel(change, locale)}</span>
              <code>{change.path}</code>
              <strong className="file-change-stat">
                <span data-tone="added">+{stats.added}</span>{" "}
                <span data-tone="removed">-{stats.removed}</span>
              </strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}
