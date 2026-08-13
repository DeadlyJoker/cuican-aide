import type { ThreadItem } from "@crewon-ui-model/v2/ThreadItem";

import type { Locale } from "../lib/i18n";

function actionVerb(label: string) {
  return <span className="tool-action-verb">{label}</span>;
}

export function TranscriptWebSearchCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "webSearch" }>;
  locale: Locale;
}) {
  const detail =
    item.action?.type === "openPage"
      ? item.action.url
      : item.action?.type === "findInPage"
        ? [item.action.pattern, item.action.url].filter(Boolean).join(" · ")
        : null;

  return (
    <div className="tool-card compact-tool-card action-card" data-status="completed">
      <div className="tool-card-header action-card-header">
        {actionVerb(locale === "zh" ? "搜索" : "Search")}
        <code>{item.query}</code>
        {detail ? <em>{detail}</em> : null}
      </div>
    </div>
  );
}

export function TranscriptImageViewCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "imageView" }>;
  locale: Locale;
}) {
  return (
    <div className="tool-card compact-tool-card action-card" data-status="completed">
      <div className="tool-card-header action-card-header">
        {actionVerb(locale === "zh" ? "查看" : "View")}
        <code>{item.path}</code>
      </div>
    </div>
  );
}

export function TranscriptImageGenerationCard({
  item,
  locale,
}: {
  item: Extract<ThreadItem, { type: "imageGeneration" }>;
  locale: Locale;
}) {
  const label =
    item.status === "completed" || item.status === "succeeded"
      ? locale === "zh"
        ? "已生成"
        : "Generated"
      : locale === "zh"
        ? "生成中"
        : "Generating";

  return (
    <div
      className="tool-card compact-tool-card action-card"
      data-status={
        item.status === "completed" || item.status === "succeeded"
          ? "completed"
          : "inProgress"
      }
    >
      <div className="tool-card-header action-card-header">
        {actionVerb(label)}
        <code>{item.savedPath ?? item.revisedPrompt ?? item.result}</code>
      </div>
    </div>
  );
}
