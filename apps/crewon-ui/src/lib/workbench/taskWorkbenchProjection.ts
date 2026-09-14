import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { CrewonWorkflowExecution } from "../workflow/crewonWorkflow";

export type WorkbenchDocument = Readonly<{
  id: string;
  originId: string;
  title: string;
  source: string;
  kind: "response" | "draft" | "plan" | "partial" | "verdict";
  text: string;
  truncated: boolean;
}>;
export type WorkbenchBrowserActivity = Readonly<{
  id: string;
  title: string;
  status: "recorded" | "inProgress" | "completed" | "failed";
  urls: readonly string[];
}>;
export type TaskWorkbenchSnapshot = Readonly<{
  scopeId: string;
  title: string;
  documents: readonly WorkbenchDocument[];
  browser: readonly WorkbenchBrowserActivity[];
}>;
const MAX_DOCUMENTS = 24;
const MAX_DOCUMENT_CHARS = 40_000;

/** Only explicit web URLs, never implicit search, credentials, scripts or file access. */
export function workbenchWebUrl(value: string): string | null {
  if (value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function workbenchDocument(
  input: Omit<WorkbenchDocument, "truncated">,
): WorkbenchDocument {
  return {
    ...input,
    title: input.title.slice(0, 120),
    text: input.text.slice(0, MAX_DOCUMENT_CHARS),
    truncated: input.text.length > MAX_DOCUMENT_CHARS,
  };
}

function textTitle(text: string, fallback: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.replace(/^\s*#+\s*/, "")
      .replaceAll("**", "")
      .slice(0, 60) || fallback
  );
}

/** Bounded, known URL fields only. Do not expose typed values, cookies or arbitrary arguments. */
function structuredUrls(input: unknown): string[] {
  const urls = new Set<string>();
  let visited = 0;
  function walk(value: unknown, depth: number) {
    if (++visited > 80 || depth > 4 || !value || typeof value !== "object")
      return;
    for (const [key, child] of Object.entries(value).slice(0, 32)) {
      if (
        ["url", "href", "targetUrl", "pageUrl"].includes(key) &&
        typeof child === "string"
      ) {
        const url = workbenchWebUrl(child);
        if (url) urls.add(url);
      } else if (typeof child === "object") walk(child, depth + 1);
      if (urls.size >= 8) return;
    }
  }
  walk(input, 0);
  return [...urls].slice(0, 8);
}

function browserActivity(
  item: ThreadItem,
  turnId: string,
): WorkbenchBrowserActivity | null {
  if (item.type === "webSearch") {
    return {
      id: `${turnId}:${item.id}`,
      title: item.query || item.action?.type || "Web",
      status: "recorded",
      urls: structuredUrls(item.action),
    };
  }
  if (item.type !== "mcpToolCall" && item.type !== "dynamicToolCall")
    return null;
  const name = `${item.type === "mcpToolCall" ? item.server : (item.namespace ?? "")}/${item.tool}`;
  if (
    !/(?:browser|playwright|puppeteer|web[_./-]+(?:search|open|fetch|run)|^web\/)/i.test(
      name,
    )
  )
    return null;
  const urls = new Set(structuredUrls(item.arguments));
  if (
    item.type === "dynamicToolCall" &&
    item.status === "completed" &&
    item.success !== false
  ) {
    for (const content of (item.contentItems ?? []).slice(0, 8)) {
      if (content.type !== "inputText" || content.text.length > 16_000)
        continue;
      try {
        for (const url of structuredUrls(JSON.parse(content.text)))
          urls.add(url);
      } catch {
        /* Plain tool prose is not a navigation contract. */
      }
    }
  }
  return {
    id: `${turnId}:${item.id}`,
    title: name.slice(0, 160),
    status:
      item.type === "dynamicToolCall" && item.success === false
        ? "failed"
        : item.status,
    urls: [...urls].slice(0, 8),
  };
}

export function projectThreadWorkbench(
  thread: Thread,
  title: string,
): TaskWorkbenchSnapshot {
  const documents: WorkbenchDocument[] = [];
  const browser: WorkbenchBrowserActivity[] = [];
  for (const turn of thread.turns.slice(-50)) {
    for (const item of turn.items.slice(-256)) {
      // Ordinary replies and progress notes stay in the conversation. A workbench
      // document needs an explicit artifact boundary, not a prose-length heuristic.
      if (item.type === "plan" && item.text.trim()) {
        documents.push(
          workbenchDocument({
            id: `${turn.id}:${item.id}`,
            originId: turn.id,
            title: textTitle(item.text, item.type),
            source: `Run ${turn.id} · ${item.id}`,
            kind: "plan",
            text: item.text,
          }),
        );
      }
      const activity = browserActivity(item, turn.id);
      if (activity) browser.push(activity);
    }
  }
  return {
    scopeId: `thread:${thread.id}`,
    title,
    documents: documents.slice(-MAX_DOCUMENTS),
    browser: browser.slice(-64),
  };
}

export function projectWorkflowWorkbench(
  execution: CrewonWorkflowExecution,
  title: string,
): TaskWorkbenchSnapshot {
  return {
    scopeId: `workflow:${execution.workflowId}:${execution.executionId}`,
    title,
    documents: execution.executedNodes
      .filter(
        (node) =>
          (node.nodeType === "agent" || node.nodeType === "verification") &&
          node.output.trim(),
      )
      .slice(-MAX_DOCUMENTS)
      .map((node) =>
        workbenchDocument({
          id: node.nodeId,
          originId: `workflow-node:${execution.executionId}:${node.nodeId}`,
          title: node.title,
          source: `执行 ${execution.executionId} · 节点 ${node.nodeId}`,
          kind:
            node.status !== "completed"
              ? "partial"
              : /^VERDICT: (PASS|FAIL)$/.test(node.output.trim())
                ? "verdict"
                : "draft",
          text: node.output,
        }),
      ),
    browser: [],
  };
}
