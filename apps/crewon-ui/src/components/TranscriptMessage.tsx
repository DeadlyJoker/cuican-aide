import { AlertTriangle, Bot, Code2, FilePenLine, Terminal } from "lucide-react";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";

import type { Locale } from "../lib/i18n";
import { itemPreview, userInputToText } from "../lib/shared/text";
import { renderMarkdown } from "./TranscriptMarkdown";
import {
  TranscriptCommandCard,
  TranscriptFileChangeCard,
  TranscriptReasoningCard,
} from "./TranscriptToolCards";

export type TranscriptItemLabels = {
  commandLabel: string;
  crewonLabel: string;
  filesLabel: string;
  planLabel: string;
  reasoningLabel: string;
  youLabel: string;
};

function itemIcon(item: ThreadItem) {
  switch (item.type) {
    case "userMessage":
    case "agentMessage":
    case "reasoning":
    case "plan":
      return null;
    case "commandExecution":
      return <Terminal size={16} />;
    case "fileChange":
      return <FilePenLine size={16} />;
    case "mcpToolCall":
    case "dynamicToolCall":
      return <Code2 size={16} />;
    default:
      return <Bot size={16} />;
  }
}

function itemRole(item: ThreadItem, labels: TranscriptItemLabels): string {
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

function renderMessageContent(item: ThreadItem, locale: Locale) {
  switch (item.type) {
    case "commandExecution":
      return <TranscriptCommandCard item={item} locale={locale} />;
    case "fileChange":
      return <TranscriptFileChangeCard item={item} locale={locale} />;
    case "reasoning":
      return <TranscriptReasoningCard item={item} locale={locale} />;
    default:
      return renderMarkdown(renderItemText(item, locale));
  }
}

function itemStatus(item: ThreadItem): string | undefined {
  if (item.type === "commandExecution" || item.type === "fileChange") {
    return item.status;
  }

  return undefined;
}

export function TranscriptMessage({
  item,
  itemLabels,
  locale,
}: {
  item: ThreadItem;
  itemLabels: TranscriptItemLabels;
  locale: Locale;
}) {
  const role = itemRole(item, itemLabels);
  const icon = itemIcon(item);
  const status = itemStatus(item);

  return (
    <article
      className="message"
      data-kind={item.type}
      data-has-icon={icon ? "true" : "false"}
      data-status={status}
      aria-label={role}
    >
      {icon ? <div className="message-icon">{icon}</div> : null}
      <div className="message-body">
        <div className="message-header">
          <span className="message-role">{role}</span>
          <span className="message-type">{itemTypeLabel(item, locale)}</span>
        </div>
        {renderMessageContent(item, locale)}
      </div>
    </article>
  );
}

export function TranscriptStreamingMessage({
  crewonLabel,
  locale,
  streamingText,
}: {
  crewonLabel: string;
  locale: Locale;
  streamingText: string;
}) {
  return (
    <article
      className="message"
      data-kind="agentMessage"
      data-has-icon="false"
      aria-atomic="false"
      aria-label={crewonLabel}
    >
      <div className="message-body">
        <div className="message-header">
          <span className="message-role">{crewonLabel}</span>
          <span className="message-type">
            {locale === "zh" ? "流式" : "Streaming"}
          </span>
        </div>
        {renderMarkdown(streamingText)}
      </div>
    </article>
  );
}

export function TranscriptThinkingMessage({
  crewonLabel,
  locale,
  stopLabel,
  onStop,
}: {
  crewonLabel: string;
  locale: Locale;
  stopLabel: string;
  onStop: () => void;
}) {
  return (
    <article
      className="message"
      data-kind="agentMessage"
      data-has-icon="false"
      aria-label={crewonLabel}
    >
      <div className="message-body">
        <div className="process-card reasoning-card thinking-card" data-status="inProgress" role="status">
          <div className="thinking-card-main">
            <span className="process-card-status">
              <span className="status-dot" aria-hidden="true" />
              {locale === "zh" ? "正在思考" : "Thinking"}
              <span className="thinking-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </span>
            <em>{locale === "zh" ? "等待模型响应" : "Waiting for model response"}</em>
          </div>
          <button type="button" className="turn-stop-button" onClick={onStop}>
            {stopLabel}
          </button>
        </div>
      </div>
    </article>
  );
}

export function TranscriptFailureMessage({
  crewonLabel,
  error,
  locale,
}: {
  crewonLabel: string;
  error: Turn["error"];
  locale: Locale;
}) {
  const message =
    error?.message ||
    (locale === "zh"
      ? "模型连接失败，当前任务没有完成。"
      : "Model connection failed, so this turn did not complete.");
  const details = error?.additionalDetails ?? null;

  return (
    <article
      className="message"
      data-kind="agentMessage"
      data-has-icon="false"
      data-status="failed"
      aria-label={crewonLabel}
    >
      <div className="message-body">
        <div className="process-card failure-card" data-status="failed" role="status">
          <span className="process-card-status">
            <AlertTriangle size={14} aria-hidden="true" />
            {locale === "zh" ? "模型连接失败" : "Model connection failed"}
          </span>
          <p>{message}</p>
          {details ? <code>{details}</code> : null}
        </div>
      </div>
    </article>
  );
}
