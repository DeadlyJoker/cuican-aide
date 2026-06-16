import {
  Bot,
  Code2,
  FilePenLine,
  Sparkles,
  Terminal,
  User,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { Locale } from "../lib/i18n";
import { formatRelativeTime, itemPreview, userInputToText } from "../lib/text";

export type WorkMode = "code" | "office";

type TranscriptProps = {
  commandLabel: string;
  crewonLabel: string;
  emptyDescription: string;
  emptyThreadDescription: string;
  emptyThreadTitle: string;
  emptyTitle: string;
  filesLabel: string;
  locale: Locale;
  modeCodeLabel: string;
  modeCodeDescription: string;
  modeOfficeLabel: string;
  modeOfficeDescription: string;
  modeTitleLabel: string;
  mode: WorkMode;
  onModeChange: (mode: WorkMode) => void;
  planLabel: string;
  reasoningLabel: string;
  thread: Thread | null;
  streamingText: string;
  youLabel: string;
};

function itemIcon(item: ThreadItem) {
  switch (item.type) {
    case "userMessage":
      return <User size={16} />;
    case "commandExecution":
      return <Terminal size={16} />;
    case "fileChange":
      return <FilePenLine size={16} />;
    case "reasoning":
    case "plan":
      return <Sparkles size={16} />;
    case "mcpToolCall":
    case "dynamicToolCall":
      return <Code2 size={16} />;
    default:
      return <Bot size={16} />;
  }
}

function itemRole(
  item: ThreadItem,
  labels: Pick<
    TranscriptProps,
    "commandLabel" | "crewonLabel" | "filesLabel" | "planLabel" | "reasoningLabel" | "youLabel"
  >,
): string {
  switch (item.type) {
    case "userMessage":
      return labels.youLabel;
    case "agentMessage":
      return labels.crewonLabel;
    case "commandExecution":
      return labels.commandLabel;
    case "fileChange":
      return labels.filesLabel;
    case "reasoning":
      return labels.reasoningLabel;
    case "plan":
      return labels.planLabel;
    default:
      return item.type;
  }
}

function itemTypeLabel(item: ThreadItem, locale: Locale): string {
  switch (item.type) {
    case "userMessage":
      return locale === "zh" ? "输入" : "Input";
    case "agentMessage":
      return locale === "zh" ? "回复" : "Reply";
    case "commandExecution":
      return locale === "zh" ? "命令" : "Command";
    case "fileChange":
      return locale === "zh" ? "变更" : "Change";
    case "reasoning":
      return locale === "zh" ? "推理" : "Reasoning";
    case "plan":
      return locale === "zh" ? "计划" : "Plan";
    case "mcpToolCall":
    case "dynamicToolCall":
      return locale === "zh" ? "工具" : "Tool";
    case "webSearch":
      return locale === "zh" ? "搜索" : "Search";
    case "imageView":
      return locale === "zh" ? "图片" : "Image";
    case "imageGeneration":
      return locale === "zh" ? "生成" : "Generate";
    case "hookPrompt":
      return "Hook";
    case "collabAgentToolCall":
      return locale === "zh" ? "协作" : "Collab";
    case "subAgentActivity":
      return locale === "zh" ? "子代理" : "Subagent";
    case "enteredReviewMode":
    case "exitedReviewMode":
      return locale === "zh" ? "审查" : "Review";
    case "contextCompaction":
      return locale === "zh" ? "压缩" : "Compact";
  }
}

function renderItemText(item: ThreadItem, locale: Locale): string {
  if (item.type === "userMessage") {
    return userInputToText(item.content, locale);
  }

  return itemPreview(item, locale);
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function flushParagraph(blocks: ReactNode[], lines: string[], key: string) {
  if (lines.length === 0) {
    return;
  }

  blocks.push(<p key={key}>{renderInlineMarkdown(lines.join(" "))}</p>);
  lines.length = 0;
}

function renderMarkdown(text: string) {
  const blocks: ReactNode[] = [];
  const paragraphLines: string[] = [];
  const listItems: string[] = [];
  const orderedItems: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let codeLines: string[] | undefined;

  function flushLists(index: number) {
    if (listItems.length > 0) {
      blocks.push(
        <ul key={`ul-${index}`}>
          {listItems.splice(0).map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
    }

    if (orderedItems.length > 0) {
      blocks.push(
        <ol key={`ol-${index}`}>
          {orderedItems.splice(0).map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
    }
  }

  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      if (codeLines !== undefined) {
        blocks.push(<pre key={`code-${index}`}>{codeLines.join("\n")}</pre>);
        codeLines = undefined;
        return;
      }

      flushParagraph(blocks, paragraphLines, `p-${index}`);
      flushLists(index);
      codeLines = [];
      return;
    }

    if (codeLines !== undefined) {
      codeLines.push(line);
      return;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph(blocks, paragraphLines, `p-${index}`);
      flushLists(index);
      return;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph(blocks, paragraphLines, `p-${index}`);
      flushLists(index);
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2]);
      blocks.push(level === 1 ? <h3 key={`h-${index}`}>{content}</h3> : <h4 key={`h-${index}`}>{content}</h4>);
      return;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unordered) {
      flushParagraph(blocks, paragraphLines, `p-${index}`);
      if (orderedItems.length > 0) {
        flushLists(index);
      }
      listItems.push(unordered[1]);
      return;
    }

    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (ordered) {
      flushParagraph(blocks, paragraphLines, `p-${index}`);
      if (listItems.length > 0) {
        flushLists(index);
      }
      orderedItems.push(ordered[1]);
      return;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph(blocks, paragraphLines, `p-${index}`);
      flushLists(index);
      blocks.push(<blockquote key={`quote-${index}`}>{renderInlineMarkdown(trimmed.replace(/^>\s?/, ""))}</blockquote>);
      return;
    }

    paragraphLines.push(trimmed);
  });

  if (codeLines !== undefined) {
    blocks.push(<pre key="code-final">{codeLines.join("\n")}</pre>);
  }
  flushParagraph(blocks, paragraphLines, "p-final");
  flushLists(lines.length);

  return <div className="markdown-content">{blocks}</div>;
}

function commandDurationLabel(durationMs: number | null, locale: Locale): string | null {
  if (!durationMs) {
    return null;
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return locale === "zh" ? `${seconds} 秒` : `${seconds}s`;
}

function commandExitLabel(exitCode: number | null | undefined, locale: Locale): string | null {
  if (exitCode === null || exitCode === undefined) {
    return null;
  }

  return locale === "zh" ? `退出码 ${exitCode}` : `exit ${exitCode}`;
}

function fileChangeStatusLabel(status: Extract<ThreadItem, { type: "fileChange" }>["status"], locale: Locale): string {
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

function fileChangeKindLabel(change: Extract<ThreadItem, { type: "fileChange" }>["changes"][number], locale: Locale): string {
  switch (change.kind.type) {
    case "add":
      return locale === "zh" ? "新增" : "add";
    case "delete":
      return locale === "zh" ? "删除" : "delete";
    case "update":
      return change.kind.move_path ? (locale === "zh" ? "移动" : "move") : locale === "zh" ? "修改" : "edit";
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

function turnLabel(locale: Locale): string {
  return locale === "zh" ? "已处理" : "Processed";
}

function turnTimeLabel(turn: Turn, locale: Locale): string {
  if (turn.completedAt) {
    return formatRelativeTime(turn.completedAt, locale);
  }

  if (turn.startedAt) {
    return formatRelativeTime(turn.startedAt, locale);
  }

  return locale === "zh" ? "未开始" : "Not started";
}

function turnDurationLabel(durationMs: number | null, locale: Locale): string | null {
  if (!durationMs) {
    return null;
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));

  if (totalSeconds < 60) {
    return locale === "zh" ? `${totalSeconds} 秒` : `${totalSeconds}s`;
  }

  const totalMinutes = Math.round(totalSeconds / 60);

  if (totalMinutes < 60) {
    return locale === "zh" ? `${totalMinutes} 分钟` : `${totalMinutes}m`;
  }

  const totalHours = Math.round(totalMinutes / 60);

  return locale === "zh" ? `${totalHours} 小时` : `${totalHours}h`;
}

export function Transcript({
  commandLabel,
  crewonLabel,
  emptyDescription,
  emptyThreadDescription,
  emptyThreadTitle,
  emptyTitle,
  filesLabel,
  locale,
  modeCodeLabel,
  modeCodeDescription,
  modeOfficeLabel,
  modeOfficeDescription,
  modeTitleLabel,
  mode,
  onModeChange,
  planLabel,
  reasoningLabel,
  thread,
  streamingText,
  youLabel,
}: TranscriptProps) {
  const items = thread?.turns.flatMap((turn) => turn.items) ?? [];
  const turnCount = thread?.turns.length ?? 0;
  const itemLabels = { commandLabel, crewonLabel, filesLabel, planLabel, reasoningLabel, youLabel };

  function renderMessageContent(item: ThreadItem) {
    switch (item.type) {
      case "commandExecution": {
        const output = item.aggregatedOutput?.trim();
        const durationLabel = commandDurationLabel(item.durationMs, locale);
        const exitLabel = commandExitLabel(item.exitCode, locale);

        return (
          <div className="tool-card command-card">
            <div className="tool-card-header command-card-header">
              <code>$ {item.command}</code>
              <span>
                {[durationLabel, exitLabel].filter(Boolean).join(" · ") || (locale === "zh" ? "运行中" : "running")}
              </span>
            </div>
            {output ? <pre>{output}</pre> : null}
          </div>
        );
      }
      case "fileChange": {
        const total = item.changes.reduce(
          (stats, change) => {
            const next = diffStats(change.diff);
            return { added: stats.added + next.added, removed: stats.removed + next.removed };
          },
          { added: 0, removed: 0 },
        );

        return (
          <div className="tool-card file-change-card">
            <div className="tool-card-header file-change-header">
              <span>{fileChangeStatusLabel(item.status, locale)}</span>
              <strong>
                {item.changes.length} {locale === "zh" ? "个文件" : item.changes.length === 1 ? "file" : "files"}
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
                  <div className="file-change-row" key={`${change.path}-${change.kind.type}`}>
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
      default:
        return renderMarkdown(renderItemText(item, locale));
    }
  }

  if (!thread) {
    return (
      <main className="empty-state">
        <div className="empty-hero">
          <h1>{emptyTitle}</h1>
          <p>{emptyDescription}</p>
          <div className="mode-switch" aria-label={modeTitleLabel}>
            <button type="button" aria-pressed={mode === "code"} data-active={mode === "code"} onClick={() => onModeChange("code")}>
              <Code2 size={15} />
              {modeCodeLabel}
            </button>
            <button
              type="button"
              aria-pressed={mode === "office"}
              data-active={mode === "office"}
              onClick={() => onModeChange("office")}
            >
              <Sparkles size={15} />
              {modeOfficeLabel}
            </button>
          </div>
          <div className="mode-description">{mode === "code" ? modeCodeDescription : modeOfficeDescription}</div>
        </div>
      </main>
    );
  }

  return (
    <main className="transcript">
      <div className="message-list" role="log" aria-busy={Boolean(streamingText)} aria-live="polite" aria-relevant="additions text">
        {items.length === 0 && !streamingText ? (
          <div className="message-empty-state" aria-label={`${emptyThreadTitle}. ${emptyThreadDescription}`} role="status">
            <span className="message-empty-icon" aria-hidden="true">
              <Sparkles size={18} />
            </span>
            <strong>{emptyThreadTitle}</strong>
            <p>{emptyThreadDescription}</p>
          </div>
        ) : null}
        {thread.turns.map((turn, turnIndex) => {
          const durationLabel = turnDurationLabel(turn.durationMs, locale);
          const dividerDetailLabel = durationLabel ?? turnTimeLabel(turn, locale);

          return (
            <section className="turn-group" aria-label={`${turnLabel(locale)} ${turnIndex + 1}`} key={turn.id}>
              <div className="turn-divider">
                <span>{turnLabel(locale)}</span>
                <em>{dividerDetailLabel}</em>
              </div>
              {turn.items.map((item) => {
                const role = itemRole(item, itemLabels);

                return (
                  <article className="message" data-kind={item.type} aria-label={role} key={item.id}>
                    <div className="message-icon">{itemIcon(item)}</div>
                    <div className="message-body">
                      <div className="message-header">
                        <span className="message-role">{role}</span>
                        <span className="message-type">{itemTypeLabel(item, locale)}</span>
                      </div>
                      {renderMessageContent(item)}
                    </div>
                  </article>
                );
              })}
            </section>
          );
        })}
        {streamingText ? (
          <article className="message" data-kind="agentMessage" aria-atomic="false" aria-label={crewonLabel}>
            <div className="message-icon">
              <Bot size={16} />
            </div>
            <div className="message-body">
              <div className="message-header">
                <span className="message-role">{crewonLabel}</span>
                <span className="message-type">{locale === "zh" ? "流式" : "Streaming"}</span>
              </div>
              {renderMarkdown(streamingText)}
            </div>
          </article>
        ) : null}
      </div>
    </main>
  );
}
