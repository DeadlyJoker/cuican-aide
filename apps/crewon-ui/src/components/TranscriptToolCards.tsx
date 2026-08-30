import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { JsonValue } from "@crewon/app-server-protocol/serde_json/JsonValue";
import { Copy } from "lucide-react";

import type { Locale } from "../lib/i18n";
import { renderMarkdown } from "./TranscriptMarkdown";
import {
  isLowSignalReasoningLine,
  reasoningDisplayLines,
  reasoningProcessLines,
} from "./transcriptReasoning";
import { dynamicToolKindLabel } from "./transcriptToolPresentation";

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

function toolDurationLabel(
  durationMs: number | null,
  locale: Locale,
): string | null {
  return commandDurationLabel(durationMs, locale);
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

function toolStatusLabel(
  status: "inProgress" | "completed" | "failed",
  locale: Locale,
  success?: boolean | null,
): string {
  switch (status) {
    case "inProgress":
      return locale === "zh" ? "调用中" : "Running";
    case "completed":
      if (success === false) {
        return locale === "zh" ? "已完成 · 失败结果" : "Completed · failed result";
      }
      return locale === "zh" ? "已完成" : "Completed";
    case "failed":
      return locale === "zh" ? "失败" : "Failed";
  }
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

function defaultOpenToolStatus(
  status: "inProgress" | "completed" | "failed" | "declined",
): boolean {
  return status === "inProgress" || status === "failed";
}

function openIfDefault(isOpen: boolean) {
  return isOpen ? { open: true } : {};
}

function jsonPreview(value: unknown, emptyLabel: string): string {
  if (value === null || value === undefined) {
    return emptyLabel;
  }

  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 2_400 ? `${text.slice(0, 2_397)}...` : text;
}

function toolSectionLabel(label: string, value: string) {
  return (
    <section className="tool-call-section">
      <span>{label}</span>
      <pre>{value}</pre>
    </section>
  );
}

function toolMarkdownSection(label: string, value: string) {
  return (
    <section className="tool-call-section tool-call-markdown-section">
      <span>{label}</span>
      {renderMarkdown(value)}
    </section>
  );
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpContentText(content: JsonValue): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!isJsonObject(content)) {
    return null;
  }

  const text = content.text;
  if (typeof text === "string") {
    return text;
  }

  return null;
}

function mcpTextContents(
  item: Extract<ThreadItem, { type: "mcpToolCall" }>,
): string[] {
  return item.result?.content
    .map(mcpContentText)
    .filter((text): text is string => Boolean(text?.trim())) ?? [];
}

function mcpNonTextContents(
  item: Extract<ThreadItem, { type: "mcpToolCall" }>,
): JsonValue[] {
  return item.result?.content.filter((content) => !mcpContentText(content)) ?? [];
}

function mcpStructuredContent(
  item: Extract<ThreadItem, { type: "mcpToolCall" }>,
): JsonValue | null {
  return item.result?.structuredContent ?? null;
}

function jsonStringField(
  value: JsonValue,
  fieldNames: string[],
): string | null {
  if (!isJsonObject(value)) {
    return null;
  }

  for (const fieldName of fieldNames) {
    const field = value[fieldName];
    if (typeof field === "string" && field.trim().length > 0) {
      return field;
    }
  }

  return null;
}

function jsonStringArrayField(
  value: JsonValue,
  fieldNames: string[],
): string[] {
  if (!isJsonObject(value)) {
    return [];
  }

  for (const fieldName of fieldNames) {
    const field = value[fieldName];
    if (Array.isArray(field)) {
      return field.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      );
    }
  }

  return [];
}

function isFileReadMcpTool(
  item: Extract<ThreadItem, { type: "mcpToolCall" }>,
): boolean {
  const server = item.server.toLowerCase();
  const tool = item.tool.toLowerCase();
  return (
    (server.includes("file") || server.includes("filesystem")) &&
    (tool === "read" ||
      tool === "read_file" ||
      tool === "readfile" ||
      (tool.includes("read") && tool.includes("file")))
  );
}

function mcpFileReadPaths(
  item: Extract<ThreadItem, { type: "mcpToolCall" }>,
): string[] {
  const paths = jsonStringArrayField(item.arguments, [
    "paths",
    "filePaths",
    "file_paths",
  ]);
  const singlePath = jsonStringField(item.arguments, [
    "path",
    "filePath",
    "file_path",
    "uri",
  ]);
  return paths.length > 0 ? paths : singlePath ? [singlePath] : [];
}

function fileReadStatusLabel(
  status: Extract<ThreadItem, { type: "mcpToolCall" }>["status"],
  count: number,
  locale: Locale,
): string {
  const countLabel = fileChangeCountLabel(Math.max(1, count), locale);
  switch (status) {
    case "inProgress":
      return locale === "zh" ? `正在读取 ${countLabel}` : `Reading ${countLabel}`;
    case "completed":
      return locale === "zh" ? `已读取 ${countLabel}` : `Read ${countLabel}`;
    case "failed":
      return locale === "zh" ? `读取失败 ${countLabel}` : `Failed to read ${countLabel}`;
  }
}

function dynamicToolTextOutput(
  item: Extract<ThreadItem, { type: "dynamicToolCall" }>,
): string {
  return (
    item.contentItems
      ?.filter((content) => content.type === "inputText")
      .map((content) => content.text)
      .filter((text) => text.trim().length > 0)
      .join("\n\n") ?? ""
  );
}

function dynamicToolEmptyOutputLabel(
  item: Extract<ThreadItem, { type: "dynamicToolCall" }>,
  locale: Locale,
): string {
  if (!item.contentItems || item.contentItems.length === 0) {
    if (item.status === "inProgress") {
      return locale === "zh" ? "等待工具输出" : "Waiting for tool output";
    }
    if (item.success === false) {
      return locale === "zh" ? "工具返回失败状态" : "Tool returned failure";
    }
    return locale === "zh" ? "无输出" : "No output";
  }

  return locale === "zh" ? "无文本输出" : "No text output";
}

function dynamicToolImageItems(
  item: Extract<ThreadItem, { type: "dynamicToolCall" }>,
) {
  return item.contentItems?.filter((content) => content.type === "inputImage") ?? [];
}

function imageOutputLabel(imageUrl: string, index: number, locale: Locale): string {
  const path = imageUrl.split(/[?#]/)[0] ?? imageUrl;
  const name = path.split("/").filter(Boolean).pop();
  if (name) {
    return name;
  }

  return locale === "zh" ? `图片 ${index + 1}` : `Image ${index + 1}`;
}

function collabToolStatusLabel(
  status: Extract<ThreadItem, { type: "collabAgentToolCall" }>["status"],
  locale: Locale,
): string {
  switch (status) {
    case "inProgress":
      return locale === "zh" ? "协作中" : "Running";
    case "completed":
      return locale === "zh" ? "已完成" : "Completed";
    case "failed":
      return locale === "zh" ? "失败" : "Failed";
  }
}

function collabAgentStatePreview(
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }>,
  locale: Locale,
): string {
  const states = Object.entries(item.agentsStates);
  if (states.length === 0) {
    return locale === "zh" ? "暂无 Agent 状态" : "No agent state yet";
  }

  return states
    .map(([threadId, state]) =>
      [threadId, state?.status, state?.message].filter(Boolean).join(" · "),
    )
    .join("\n");
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

type FileDiffRow = {
  key: string;
  kind: "added" | "context" | "hunk" | "removed";
  lineNumber: string;
  text: string;
};

function diffPreviewRows(diff: string, maxRows = 90): FileDiffRow[] {
  const rows: FileDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  diff.split("\n").forEach((line, index) => {
    if (rows.length >= maxRows) {
      return;
    }

    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("+++ ") ||
      line.startsWith("--- ")
    ) {
      return;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      rows.push({
        key: `${index}:hunk`,
        kind: "hunk",
        lineNumber: "",
        text: line,
      });
      return;
    }

    if (line.startsWith("+")) {
      rows.push({
        key: `${index}:added`,
        kind: "added",
        lineNumber: String(newLine || ""),
        text: line.slice(1) || " ",
      });
      newLine += 1;
      return;
    }

    if (line.startsWith("-")) {
      rows.push({
        key: `${index}:removed`,
        kind: "removed",
        lineNumber: String(oldLine || ""),
        text: line.slice(1) || " ",
      });
      oldLine += 1;
      return;
    }

    rows.push({
      key: `${index}:context`,
      kind: "context",
      lineNumber: String(newLine || oldLine || ""),
      text: line.startsWith(" ") ? line.slice(1) || " " : line || " ",
    });
    oldLine += oldLine > 0 ? 1 : 0;
    newLine += newLine > 0 ? 1 : 0;
  });

  return rows;
}

function editedFilesLabel(locale: Locale): string {
  return locale === "zh" ? "已编辑的文件" : "Edited files";
}

function renderFileDiffPreview({
  change,
  locale,
}: {
  change: Extract<ThreadItem, { type: "fileChange" }>["changes"][number];
  locale: Locale;
}) {
  const stats = diffStats(change.diff);
  const rows = diffPreviewRows(change.diff);

  return (
    <section className="file-diff-card" key={`${change.path}-${change.kind.type}`}>
      <header className="file-diff-card-header">
        <span className="file-diff-path">{change.path}</span>
        <strong className="file-change-stat">
          <span data-tone="added">+{stats.added}</span>{" "}
          <span data-tone="removed">-{stats.removed}</span>
        </strong>
        <span
          aria-label={locale === "zh" ? "复制文件路径" : "Copy file path"}
          className="file-diff-copy"
          role="img"
        >
          <Copy size={13} strokeWidth={1.8} />
        </span>
      </header>
      <div className="file-diff-code" role="list">
        {rows.map((row) => (
          <span className="file-diff-line" data-kind={row.kind} key={row.key}>
            <span className="file-diff-line-number">{row.lineNumber}</span>
            <code>{row.text}</code>
          </span>
        ))}
      </div>
    </section>
  );
}

export function TranscriptReasoningCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "reasoning" }>;
  locale: Locale;
}) {
  const processLines = reasoningProcessLines(item);
  const highSignalLines = reasoningDisplayLines(item);

  if (processLines.length === 0) {
    return (
      <div
        className="process-card reasoning-card reasoning-card-static"
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

  const breadcrumbOnly =
    highSignalLines.length === 0 ||
    processLines.every((line) => isLowSignalReasoningLine(line));

  const thoughtVerb = locale === "zh" ? "思考" : "Thought";
  const stepCountLabel =
    locale === "zh"
      ? `${processLines.length} 步`
      : `${processLines.length} step${processLines.length === 1 ? "" : "s"}`;

  // Cursor/Codex: every reasoning row is labeled "Thought", never a bare grey line.
  if (breadcrumbOnly) {
    return (
      <details className="process-card reasoning-card">
        <summary title={`${thoughtVerb} · ${stepCountLabel}`}>
          <span className="tool-action-verb">{thoughtVerb}</span>
          <span className="reasoning-card-headline">{stepCountLabel}</span>
        </summary>
        <div className="process-card-body">
          <ol className="reasoning-step-list">
            {processLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
      </details>
    );
  }

  const headline = highSignalLines[0] ?? processLines[0];
  const detailText = highSignalLines
    .slice(1)
    .filter((line) => line.trim() !== headline.trim())
    .join("\n\n")
    .trim();

  if (!detailText) {
    return (
      <div
        className="process-card reasoning-card reasoning-card-static"
        role="status"
        title={headline}
      >
        <span className="tool-action-verb">{thoughtVerb}</span>
        <span className="reasoning-card-headline">{headline}</span>
      </div>
    );
  }

  return (
    <details className="process-card reasoning-card">
      <summary title={headline}>
        <span className="tool-action-verb">{thoughtVerb}</span>
        <span className="reasoning-card-headline">{headline}</span>
        <em>{lineCountLabel(highSignalLines.length, locale)}</em>
      </summary>
      <div className="process-card-body">{renderMarkdown(detailText)}</div>
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

  return (
    <details
      className="tool-card command-card compact-tool-card"
      data-status={item.status}
      {...openIfDefault(defaultOpenToolStatus(item.status))}
    >
      <summary className="tool-card-header command-card-header">
        <span className="tool-action-verb">
          {item.status === "inProgress"
            ? locale === "zh"
              ? "运行中"
              : "Running"
            : locale === "zh"
              ? "已运行"
              : "Ran"}
        </span>
        <code>{item.command}</code>
        <span className="tool-card-status">
          <span className="status-dot" aria-hidden="true" />
          {commandStatusLabel(item, locale)}
        </span>
      </summary>
      {output ? <pre className="tool-call-output">{output}</pre> : null}
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
      className="tool-card file-event-card file-change-card compact-tool-card"
      data-status={item.status}
      {...openIfDefault(item.status !== "declined")}
    >
      <summary className="tool-card-header file-event-header file-change-header">
        <span className="tool-action-verb">
          {fileChangeStatusLabel(item.status, locale)}
        </span>
        <code>{fileChangeCountLabel(item.changes.length, locale)}</code>
        <em className="file-change-stat">
          <span data-tone="added">+{total.added}</span>{" "}
          <span data-tone="removed">-{total.removed}</span>
        </em>
      </summary>
      <div className="file-event-body">
        <span className="file-event-section-title">{editedFilesLabel(locale)}</span>
        <div className="file-diff-stack">
          {item.changes
            .slice(0, 4)
            .map((change) => renderFileDiffPreview({ change, locale }))}
        </div>
        {item.changes.length > 4 ? (
          <div className="file-change-row file-change-overflow">
            <span>...</span>
            <code>
              {locale === "zh"
                ? `还有 ${item.changes.length - 4} 个文件`
                : `${item.changes.length - 4} more files`}
            </code>
            <strong />
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function TranscriptMcpToolCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "mcpToolCall" }>;
  locale: Locale;
}) {
  if (isFileReadMcpTool(item)) {
    return <TranscriptFileReadCard item={item} locale={locale} />;
  }

  const duration = toolDurationLabel(item.durationMs, locale);
  const textContents = mcpTextContents(item);
  const nonTextContents = mcpNonTextContents(item);
  const structuredContent = mcpStructuredContent(item);
  const resultLabel = item.error
    ? locale === "zh"
      ? "错误"
      : "Error"
    : locale === "zh"
      ? "结果"
      : "Result";

  return (
    <details
      className="tool-card tool-call-card mcp-tool-card compact-tool-card"
      data-status={item.status}
      {...openIfDefault(defaultOpenToolStatus(item.status))}
    >
      <summary className="tool-card-header tool-call-header">
        <span className="tool-action-verb">MCP</span>
        <code>
          {item.server}.{item.tool}
        </code>
        <span className="tool-card-status">
          <span className="status-dot" aria-hidden="true" />
          {toolStatusLabel(item.status, locale)}
        </span>
        {duration ? <em>{duration}</em> : null}
      </summary>
      <div className="tool-call-body">
        {toolSectionLabel(
          locale === "zh" ? "参数" : "Arguments",
          jsonPreview(item.arguments, "{}"),
        )}
        {item.error ? toolSectionLabel(resultLabel, item.error.message) : null}
        {!item.error && !item.result
          ? toolSectionLabel(
              resultLabel,
              locale === "zh" ? "等待 MCP 返回结果" : "Waiting for MCP result",
            )
          : null}
        {!item.error && textContents.length > 0
          ? toolMarkdownSection(resultLabel, textContents.join("\n\n"))
          : null}
        {!item.error && structuredContent !== null
          ? toolSectionLabel(
              locale === "zh" ? "结构化结果" : "Structured result",
              jsonPreview(
                structuredContent,
                locale === "zh" ? "空结构化结果" : "Empty structured result",
              ),
            )
          : null}
        {!item.error &&
        item.result &&
        textContents.length === 0 &&
        structuredContent === null
          ? toolSectionLabel(
              resultLabel,
              jsonPreview(
                nonTextContents.length > 0 ? nonTextContents : item.result.content,
                locale === "zh" ? "空结果" : "Empty result",
              ),
            )
          : null}
      </div>
    </details>
  );
}

function TranscriptFileReadCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "mcpToolCall" }>;
  locale: Locale;
}) {
  const paths = mcpFileReadPaths(item);
  const firstPath = paths[0] ?? `${item.server}.${item.tool}`;
  const duration = toolDurationLabel(item.durationMs, locale);
  const resultLabel = item.error
    ? locale === "zh"
      ? "错误"
      : "Error"
    : locale === "zh"
      ? "结果"
      : "Result";

  return (
    <details
      className="tool-card file-event-card file-read-card compact-tool-card"
      data-status={item.status}
      {...openIfDefault(defaultOpenToolStatus(item.status))}
    >
      <summary className="tool-card-header file-event-header file-read-header">
        <span className="tool-action-verb">
          {item.status === "inProgress"
            ? locale === "zh"
              ? "读取中"
              : "Reading"
            : locale === "zh"
              ? "已读取"
              : "Read"}
        </span>
        <code>{firstPath}</code>
        <span className="visually-hidden">
          {fileReadStatusLabel(item.status, paths.length || 1, locale)}{" "}
          {item.server}.{item.tool}
        </span>
        {duration ? <em>{duration}</em> : null}
      </summary>
      <div className="file-event-body file-read-body">
        {paths.length > 1
          ? paths.map((path) => (
              <span className="file-read-line" key={path}>
                <strong>Read</strong>
                <code>{path}</code>
              </span>
            ))
          : null}
        {item.error ? toolSectionLabel(resultLabel, item.error.message) : null}
        {!item.error && !item.result
          ? toolSectionLabel(
              resultLabel,
              locale === "zh" ? "等待文件读取结果" : "Waiting for file read result",
            )
          : null}
      </div>
    </details>
  );
}

export function TranscriptDynamicToolCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "dynamicToolCall" }>;
  locale: Locale;
}) {
  const duration = toolDurationLabel(item.durationMs, locale);
  const toolName = item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
  const textOutput = dynamicToolTextOutput(item);
  const imageItems = dynamicToolImageItems(item);

  return (
    <details
      className="tool-card tool-call-card dynamic-tool-card compact-tool-card"
      data-status={item.status}
      {...openIfDefault(defaultOpenToolStatus(item.status))}
    >
      <summary className="tool-card-header tool-call-header">
        <span className="tool-action-verb">
          {dynamicToolKindLabel(item, locale)}
        </span>
        <code>{toolName}</code>
        <span className="tool-card-status">
          <span className="status-dot" aria-hidden="true" />
          {toolStatusLabel(item.status, locale, item.success)}
        </span>
        {duration ? <em>{duration}</em> : null}
      </summary>
      <div className="tool-call-body">
        {toolSectionLabel(
          locale === "zh" ? "参数" : "Arguments",
          jsonPreview(item.arguments, "{}"),
        )}
        {textOutput
          ? toolMarkdownSection(locale === "zh" ? "输出" : "Output", textOutput)
          : toolSectionLabel(
              locale === "zh" ? "输出" : "Output",
              dynamicToolEmptyOutputLabel(item, locale),
            )}
        {imageItems.length > 0 ? (
          <section className="tool-call-section tool-call-image-section">
            <span>{locale === "zh" ? "图片" : "Images"}</span>
            <div className="tool-call-image-list">
              {imageItems.map((content, index) => (
                <a
                  className="tool-call-image-preview"
                  href={content.imageUrl}
                  key={`${content.imageUrl}-${index}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  <img
                    alt={imageOutputLabel(content.imageUrl, index, locale)}
                    loading="lazy"
                    src={content.imageUrl}
                  />
                  <small>{imageOutputLabel(content.imageUrl, index, locale)}</small>
                </a>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </details>
  );
}

export function TranscriptCollabAgentToolCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "collabAgentToolCall" }>;
  locale: Locale;
}) {
  return (
    <details
      className="tool-card tool-call-card collab-agent-card compact-tool-card"
      data-status={item.status}
      {...openIfDefault(defaultOpenToolStatus(item.status))}
    >
      <summary className="tool-card-header tool-call-header">
        <span className="tool-call-kind">Agent</span>
        <code>{item.tool}</code>
        <span className="tool-card-status">
          <span className="status-dot" aria-hidden="true" />
          {collabToolStatusLabel(item.status, locale)}
        </span>
        {item.receiverThreadIds.length > 0 ? (
          <em>{item.receiverThreadIds.length} agent</em>
        ) : null}
      </summary>
      <div className="tool-call-body">
        {item.prompt
          ? toolSectionLabel(locale === "zh" ? "任务" : "Prompt", item.prompt)
          : null}
        {toolSectionLabel(
          locale === "zh" ? "Agent 状态" : "Agent state",
          collabAgentStatePreview(item, locale),
        )}
      </div>
    </details>
  );
}

export function TranscriptSubAgentActivityCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "subAgentActivity" }>;
  locale: Locale;
}) {
  const kindLabel =
    item.kind === "started"
      ? locale === "zh"
        ? "已启动"
        : "Started"
      : item.kind === "interacted"
        ? locale === "zh"
          ? "已交互"
          : "Interacted"
        : locale === "zh"
          ? "已中断"
          : "Interrupted";

  return (
    <div className="tool-card sub-agent-activity-card compact-tool-card">
      <div className="tool-card-header tool-call-header">
        <span className="tool-call-kind">Agent</span>
        <code>{item.agentPath}</code>
        <span className="tool-card-status">{kindLabel}</span>
        <em>{item.agentThreadId}</em>
      </div>
    </div>
  );
}
