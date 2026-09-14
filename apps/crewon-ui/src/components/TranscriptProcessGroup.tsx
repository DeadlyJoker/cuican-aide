import { useEffect, useRef, useState } from "react";
import { ListTree, Terminal } from "lucide-react";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { Locale } from "../lib/i18n";
import {
  TranscriptMessage,
  type TranscriptItemLabels,
} from "./TranscriptMessage";
import { isActionProcessItem } from "./transcriptReasoning";

function processActionStatus(
  item: ThreadItem,
): "completed" | "failed" | "inProgress" {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
      return item.status === "inProgress"
        ? "inProgress"
        : item.status === "failed" || item.status === "declined"
          ? "failed"
          : "completed";
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
      return item.status;
    case "imageGeneration":
      return item.status === "completed" || item.status === "succeeded"
        ? "completed"
        : item.status === "failed" || item.status === "canceled"
          ? "failed"
          : "inProgress";
    default:
      return "completed";
  }
}

function isFileReadAction(item: ThreadItem): boolean {
  if (item.type !== "mcpToolCall") {
    return false;
  }

  const server = item.server.toLowerCase();
  const tool = item.tool.toLowerCase();
  return (
    (server.includes("file") || server.includes("filesystem")) &&
    tool.includes("read") &&
    (tool.includes("file") || tool === "read")
  );
}

function processActionGroupLabel(items: ThreadItem[], locale: Locale): string {
  const counts = items.reduce(
    (current, item) => ({
      commands: current.commands + (item.type === "commandExecution" ? 1 : 0),
      fileChanges: current.fileChanges + (item.type === "fileChange" ? 1 : 0),
      fileReads: current.fileReads + (isFileReadAction(item) ? 1 : 0),
      searches: current.searches + (item.type === "webSearch" ? 1 : 0),
      other:
        current.other +
        (item.type !== "commandExecution" &&
        item.type !== "fileChange" &&
        item.type !== "webSearch" &&
        !isFileReadAction(item)
          ? 1
          : 0),
    }),
    { commands: 0, fileChanges: 0, fileReads: 0, other: 0, searches: 0 },
  );

  if (locale === "zh") {
    return [
      counts.fileReads > 0
        ? counts.fileReads === 1
          ? "读取了文件"
          : `读取了 ${counts.fileReads} 个文件`
        : null,
      counts.commands > 0
        ? counts.commands === 1
          ? "运行了命令"
          : "运行了多个命令"
        : null,
      counts.searches > 0
        ? counts.searches === 1
          ? "完成了搜索"
          : `完成了 ${counts.searches} 次搜索`
        : null,
      counts.fileChanges > 0
        ? counts.fileChanges === 1
          ? "编辑了文件"
          : `编辑了 ${counts.fileChanges} 批文件`
        : null,
      counts.other > 0
        ? counts.other === 1
          ? "调用了工具"
          : `调用了 ${counts.other} 个工具`
        : null,
    ]
      .filter(Boolean)
      .join("、");
  }

  return [
    counts.fileReads > 0
      ? counts.fileReads === 1
        ? "Read a file"
        : `Read ${counts.fileReads} files`
      : null,
    counts.commands > 0
      ? counts.commands === 1
        ? "Ran a command"
        : "Ran multiple commands"
      : null,
    counts.searches > 0
      ? counts.searches === 1
        ? "Searched the web"
        : `Ran ${counts.searches} searches`
      : null,
    counts.fileChanges > 0
      ? counts.fileChanges === 1
        ? "Edited files"
        : `Edited ${counts.fileChanges} file batches`
      : null,
    counts.other > 0
      ? counts.other === 1
        ? "Called a tool"
        : `Called ${counts.other} tools`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

type ProcessTimelineEntry =
  | { item: ThreadItem; type: "item" }
  | { id: string; items: ThreadItem[]; type: "actionGroup" };

function processTimelineEntries(items: ThreadItem[]): ProcessTimelineEntry[] {
  const entries: ProcessTimelineEntry[] = [];
  let actionItems: ThreadItem[] = [];

  const flushActions = () => {
    if (actionItems.length === 0) {
      return;
    }

    if (actionItems.length === 1) {
      entries.push({ item: actionItems[0], type: "item" });
    } else {
      entries.push({
        id: `${actionItems[0].id}-action-group`,
        items: actionItems,
        type: "actionGroup",
      });
    }
    actionItems = [];
  };

  for (const item of items) {
    if (isActionProcessItem(item)) {
      actionItems.push(item);
      continue;
    }

    flushActions();
    entries.push({ item, type: "item" });
  }

  flushActions();
  return entries;
}

function TranscriptProcessActionGroup({
  itemLabels,
  items,
  locale,
}: {
  itemLabels: TranscriptItemLabels;
  items: ThreadItem[];
  locale: Locale;
}) {
  const status = items.reduce<"completed" | "failed" | "inProgress">(
    (current, item) => {
      const itemStatus = processActionStatus(item);
      if (current === "inProgress" || itemStatus === "inProgress") {
        return "inProgress";
      }
      if (current === "failed" || itemStatus === "failed") {
        return "failed";
      }
      return "completed";
    },
    "completed",
  );
  const [expanded, setExpanded] = useState(status === "inProgress");
  useEffect(() => {
    setExpanded(status === "inProgress");
  }, [status]);
  const commandOnly = items.every((item) => item.type === "commandExecution");

  return (
    <details
      className="process-action-group"
      data-status={status}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="process-action-group-icon" aria-hidden="true">
          {commandOnly ? <Terminal size={16} /> : <ListTree size={16} />}
        </span>
        <span>{processActionGroupLabel(items, locale)}</span>
      </summary>
      {expanded ? (
        <div className="process-action-group-items">
          {items.map((item) => (
            <TranscriptMessage
              item={item}
              itemLabels={itemLabels}
              key={item.id}
              locale={locale}
              variant="process"
            />
          ))}
        </div>
      ) : null}
    </details>
  );
}

type TurnProcessPanelState = "collapsed" | "collapsing" | "expanded";

const TURN_PROCESS_COLLAPSE_MS = 260;

export function TranscriptProcessGroup({
  detailLabel,
  itemLabels,
  items,
  label,
  locale,
  status,
  turnId,
}: {
  detailLabel: string | null;
  itemLabels: TranscriptItemLabels;
  items: ThreadItem[];
  label: string;
  locale: Locale;
  status: Turn["status"];
  turnId: string;
}) {
  const [panelState, setPanelState] = useState<TurnProcessPanelState>(() =>
    status === "inProgress" ? "expanded" : "collapsed",
  );
  const collapseTimerRef = useRef<number | null>(null);
  const processId = `turn-process-${turnId}`;
  const isExpanded = panelState === "expanded";
  const isRendered = panelState !== "collapsed";
  const timelineEntries = isRendered ? processTimelineEntries(items) : [];

  const clearCollapseTimer = () => {
    if (collapseTimerRef.current === null) {
      return;
    }

    window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  };

  const collapseWithAnimation = () => {
    clearCollapseTimer();
    setPanelState((current) =>
      current === "collapsed" ? "collapsed" : "collapsing",
    );
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      setPanelState("collapsed");
    }, TURN_PROCESS_COLLAPSE_MS);
  };

  useEffect(
    () => () => {
      clearCollapseTimer();
    },
    [],
  );

  const handleToggle = () => {
    if (isExpanded) {
      collapseWithAnimation();
      return;
    }

    clearCollapseTimer();
    setPanelState("expanded");
  };

  return (
    <section
      className="turn-process-details"
      data-state={panelState}
      data-status={status}
    >
      <button
        type="button"
        className="turn-process-summary"
        aria-controls={processId}
        aria-expanded={isExpanded}
        onClick={handleToggle}
      >
        <span className="turn-process-summary-main">
          <span className="turn-process-title">{label}</span>
          {detailLabel ? <em>{detailLabel}</em> : null}
        </span>
      </button>
      <div
        className="turn-process-items-shell"
        hidden={!isRendered}
        id={processId}
      >
        <div className="turn-process-items">
          {timelineEntries.map((entry) =>
            entry.type === "actionGroup" ? (
              <TranscriptProcessActionGroup
                itemLabels={itemLabels}
                items={entry.items}
                key={entry.id}
                locale={locale}
              />
            ) : (
              <TranscriptMessage
                item={entry.item}
                itemLabels={itemLabels}
                key={entry.item.id}
                locale={locale}
                variant="process"
              />
            ),
          )}
        </div>
      </div>
    </section>
  );
}
