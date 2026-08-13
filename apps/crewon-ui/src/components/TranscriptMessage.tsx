import {
  AlertTriangle,
  BookOpen,
  Bot,
  Code2,
  Eye,
  FilePenLine,
  Search,
  Sparkles,
  Terminal,
} from "lucide-react";
import type { Turn } from "@crewon-ui-model/v2/Turn";
import type { ThreadItem } from "@crewon-ui-model/v2/ThreadItem";

import type { Locale } from "../lib/i18n";
import { itemPreview, userInputToText } from "../lib/shared/text";
import { renderMarkdown } from "./TranscriptMarkdown";
import {
  ComposerResourceTags,
  type ComposerResourceTag,
} from "./composer/ComposerResourceTags";
import { transcriptToolRoleLabel } from "./transcriptToolPresentation";
import {
  TranscriptImageGenerationCard,
  TranscriptImageViewCard,
  TranscriptWebSearchCard,
} from "./TranscriptActionCards";
import {
  TranscriptCollabAgentToolCard,
  TranscriptCommandCard,
  TranscriptDynamicToolCard,
  TranscriptFileChangeCard,
  TranscriptMcpToolCard,
  TranscriptReasoningCard,
  TranscriptSubAgentActivityCard,
} from "./TranscriptToolCards";

export type TranscriptItemLabels = {
  commandLabel: string;
  crewonLabel: string;
  filesLabel: string;
  planLabel: string;
  reasoningLabel: string;
  youLabel: string;
};

type TranscriptMessageVariant = "message" | "process";

type AgentMessageItem = Extract<ThreadItem, { type: "agentMessage" }>;

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
    case "mcpToolCall": {
      const server = item.server.toLowerCase();
      const tool = item.tool.toLowerCase();
      if (
        (server.includes("file") || server.includes("filesystem")) &&
        tool.includes("read")
      ) {
        return <BookOpen size={16} />;
      }
      return <Code2 size={16} />;
    }
    case "dynamicToolCall":
      return <Code2 size={16} />;
    case "webSearch":
      return <Search size={16} />;
    case "imageView":
      return <Eye size={16} />;
    case "imageGeneration":
      return <Sparkles size={16} />;
    default:
      return <Bot size={16} />;
  }
}

function itemRole(
  item: ThreadItem,
  labels: TranscriptItemLabels,
  locale: Locale,
  variant: TranscriptMessageVariant,
): string {
  switch (item.type) {
    case "userMessage":
      return labels.youLabel;
    case "agentMessage":
      if (variant === "process") {
        return locale === "zh" ? "进展说明" : "Progress note";
      }
      return labels.crewonLabel;
    case "commandExecution":
      return labels.commandLabel;
    case "fileChange":
      return labels.filesLabel;
    case "reasoning":
      return labels.reasoningLabel;
    case "plan":
      return labels.planLabel;
    case "webSearch":
      return locale === "zh" ? "搜索" : "Search";
    case "imageView":
      return locale === "zh" ? "图片" : "Image";
    case "imageGeneration":
      return locale === "zh" ? "生成" : "Generate";
    default:
      return transcriptToolRoleLabel(item, locale) ?? item.type;
  }
}

function itemTypeLabel(
  item: ThreadItem,
  locale: Locale,
  variant: TranscriptMessageVariant,
): string {
  switch (item.type) {
    case "userMessage":
      return locale === "zh" ? "输入" : "Input";
    case "agentMessage":
      if (variant === "process") {
        return locale === "zh" ? "进展" : "Progress";
      }
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
      return locale === "zh" ? "调用" : "Call";
    case "dynamicToolCall":
      return locale === "zh" ? "执行" : "Run";
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
      return locale === "zh" ? "活动" : "Activity";
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
    case "userMessage": {
      const text = item.content
        .filter((input) => input.type === "text")
        .map((input) => input.text)
        .join("\n\n");
      const resources = item.content.flatMap<ComposerResourceTag>((input) => {
        if (input.type === "skill") {
          return [
            {
              id: `skill-${input.path}`,
              kind: "skill",
              label: "Skill",
              name: input.name,
            },
          ];
        }
        if (
          input.type === "mention" &&
          (input.path.startsWith("mcp://") ||
            input.path.startsWith("agent-platform://mcp_servers/"))
        ) {
          return [
            {
              id: `mcp-${input.path}`,
              kind: "mcp",
              label: "MCP",
              name: input.name,
            },
          ];
        }
        if (
          input.type === "mention" &&
          input.path.startsWith("agent-platform://knowledge_bases/")
        ) {
          return [
            {
              id: `knowledge-${input.path}`,
              kind: "knowledge",
              label: "知识库",
              name: input.name,
            },
          ];
        }
        return [];
      });
      return (
        <>
          {text.trim() ? renderMarkdown(text) : null}
          <ComposerResourceTags resources={resources} />
        </>
      );
    }
    case "commandExecution":
      return <TranscriptCommandCard item={item} locale={locale} />;
    case "fileChange":
      return <TranscriptFileChangeCard item={item} locale={locale} />;
    case "reasoning":
      return <TranscriptReasoningCard item={item} locale={locale} />;
    case "mcpToolCall":
      return <TranscriptMcpToolCard item={item} locale={locale} />;
    case "dynamicToolCall":
      return <TranscriptDynamicToolCard item={item} locale={locale} />;
    case "collabAgentToolCall":
      return <TranscriptCollabAgentToolCard item={item} locale={locale} />;
    case "subAgentActivity":
      return <TranscriptSubAgentActivityCard item={item} locale={locale} />;
    case "webSearch":
      return <TranscriptWebSearchCard item={item} locale={locale} />;
    case "imageView":
      return <TranscriptImageViewCard item={item} locale={locale} />;
    case "imageGeneration":
      return <TranscriptImageGenerationCard item={item} locale={locale} />;
    default:
      return renderMarkdown(renderItemText(item, locale));
  }
}

function itemStatus(item: ThreadItem): string | undefined {
  if (item.type === "commandExecution" || item.type === "fileChange") {
    return item.status;
  }

  if (
    item.type === "mcpToolCall" ||
    item.type === "dynamicToolCall" ||
    item.type === "collabAgentToolCall"
  ) {
    return item.status;
  }

  return undefined;
}

export function TranscriptMessage({
  item,
  itemLabels,
  locale,
  variant = "message",
}: {
  item: ThreadItem;
  itemLabels: TranscriptItemLabels;
  locale: Locale;
  variant?: TranscriptMessageVariant;
}) {
  const role = itemRole(item, itemLabels, locale, variant);
  const icon = itemIcon(item);
  const status = itemStatus(item);
  const isProcessAgentNote =
    variant === "process" && item.type === "agentMessage";

  return (
    <article
      className="message"
      data-kind={item.type}
      data-has-icon={icon ? "true" : "false"}
      data-process-note={isProcessAgentNote ? "true" : undefined}
      data-status={status}
      data-transcript-variant={variant}
      aria-label={role}
    >
      {icon ? <div className="message-icon">{icon}</div> : null}
      <div className="message-body">
        <div className="message-header">
          <span className="message-role">{role}</span>
          <span className="message-type">
            {itemTypeLabel(item, locale, variant)}
          </span>
        </div>
        {renderMessageContent(item, locale)}
      </div>
    </article>
  );
}

export function combineAgentMessages({
  id,
  messages,
  phase,
}: {
  id: string;
  messages: AgentMessageItem[];
  phase: AgentMessageItem["phase"];
}): AgentMessageItem {
  if (messages.length === 1) {
    return messages[0];
  }

  const lastMessage = messages[messages.length - 1];
  return {
    ...lastMessage,
    id,
    memoryCitation: lastMessage.memoryCitation,
    phase,
    text: messages
      .map((message) => message.text.trim())
      .filter(Boolean)
      .join("\n\n"),
  };
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
}: {
  crewonLabel: string;
  locale: Locale;
}) {
  return (
    <article
      className="message"
      data-kind="agentMessage"
      data-has-icon="false"
      aria-label={crewonLabel}
    >
      <div className="message-body">
        <div
          className="process-card reasoning-card thinking-card"
          data-status="inProgress"
          role="status"
        >
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
            <em>
              {locale === "zh" ? "等待模型响应" : "Waiting for model response"}
            </em>
          </div>
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
        <div
          className="process-card failure-card"
          data-status="failed"
          role="status"
        >
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
