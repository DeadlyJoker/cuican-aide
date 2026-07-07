import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";

import type { Locale } from "../lib/i18n";
import { renderMarkdown } from "./TranscriptMarkdown";

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

function commandStatusLabel(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
  locale: Locale,
): string {
  switch (item.status) {
    case "inProgress":
      return locale === "zh" ? "运行中" : "Running";
    case "completed": {
      const durationLabel = commandDurationLabel(item.durationMs, locale);
      const exitLabel = commandExitLabel(item.exitCode, locale);
      return (
        [durationLabel, exitLabel].filter(Boolean).join(" · ") ||
        (locale === "zh" ? "已完成" : "Completed")
      );
    }
    case "failed": {
      const exitLabel = commandExitLabel(item.exitCode, locale);
      return [locale === "zh" ? "失败" : "Failed", exitLabel]
        .filter(Boolean)
        .join(" · ");
    }
    case "declined":
      return locale === "zh" ? "已拒绝" : "Declined";
  }
}

function disclosureLabel(locale: Locale): string {
  return locale === "zh" ? "明细" : "Details";
}

function lineCountLabel(count: number, locale: Locale): string {
  if (locale === "zh") {
    return `${count} 行`;
  }

  return `${count} line${count === 1 ? "" : "s"}`;
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

function fileChangeCountLabel(count: number, locale: Locale): string {
  if (locale === "zh") {
    return `${count} 个文件`;
  }

  return `${count} ${count === 1 ? "file" : "files"}`;
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

export function TranscriptReasoningCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "reasoning" }>;
  locale: Locale;
}) {
  const lines = [...item.summary, ...item.content].filter(
    (line) => line.trim().length > 0,
  );

  if (lines.length === 0) {
    return (
      <div
        className="process-card reasoning-card"
        data-status="inProgress"
        role="status"
      >
        <span className="process-card-status">
          <span className="status-dot" aria-hidden="true" />
          {locale === "zh" ? "正在思考" : "Thinking"}
        </span>
        <span className="thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
    );
  }

  return (
    <details className="process-card reasoning-card">
      <summary>
        <span>{locale === "zh" ? "推理过程" : "Reasoning"}</span>
        <em>{lineCountLabel(lines.length, locale)}</em>
        <strong>{disclosureLabel(locale)}</strong>
      </summary>
      <div className="process-card-body">
        {renderMarkdown(lines.join("\n\n"))}
      </div>
    </details>
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
  const outputLineCount = output ? output.split("\n").length : 0;

  return (
    <details
      className="tool-card command-card compact-tool-card"
      data-status={item.status}
      open={item.status === "failed" || item.status === "inProgress"}
    >
      <summary className="tool-card-header command-card-header">
        <code>$ {item.command}</code>
        <span className="tool-card-status">
          <span className="status-dot" aria-hidden="true" />
          {commandStatusLabel(item, locale)}
        </span>
        <em>
          {output
            ? lineCountLabel(outputLineCount, locale)
            : locale === "zh"
              ? "无输出"
              : "No output"}
        </em>
      </summary>
      {output ? <pre>{output}</pre> : null}
    </details>
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
    <details
      className="tool-card file-change-card compact-tool-card"
      data-status={item.status}
      open={item.status === "failed" || item.status === "declined"}
    >
      <summary className="tool-card-header file-change-header">
        <span className="tool-card-status">
          <span className="status-dot" aria-hidden="true" />
          {fileChangeStatusLabel(item.status, locale)}
        </span>
        <strong>{fileChangeCountLabel(item.changes.length, locale)}</strong>
        <em className="file-change-stat">
          <span data-tone="added">+{total.added}</span>{" "}
          <span data-tone="removed">-{total.removed}</span>
        </em>
        <small>{disclosureLabel(locale)}</small>
      </summary>
      <div className="file-change-list">
        {item.changes.slice(0, 8).map((change) => {
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
        {item.changes.length > 8 ? (
          <div className="file-change-row file-change-overflow">
            <span>...</span>
            <code>
              {locale === "zh"
                ? `还有 ${item.changes.length - 8} 个文件`
                : `${item.changes.length - 8} more files`}
            </code>
            <strong />
          </div>
        ) : null}
      </div>
    </details>
  );
}
