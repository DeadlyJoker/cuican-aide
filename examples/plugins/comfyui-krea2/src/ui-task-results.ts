import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import { jsonRecord } from "./ui-task-projection.js";

const statuses: Readonly<Record<string, string>> = Object.freeze({
  submitting: "正在提交",
  submitted: "已提交",
  running: "正在执行",
  succeeded: "已完成",
  failed: "失败",
  unknownOutcome: "结果尚未确认",
  queued: "等待执行",
  completed: "已完成",
  cancelled: "已取消",
});

function status(value: PluginJsonValue | undefined): string {
  if (typeof value !== "string" || value.length > 64) return "等待状态更新";
  return Object.hasOwn(statuses, value) ? statuses[value]! : value;
}

function imageUrl(value: PluginJsonValue | undefined): string | null {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > 2048
  )
    return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Renders bounded host-read task data. Results never choose a query source or dispatch provider requests. */
export function renderResults(root: HTMLElement, input: PluginJsonValue): void {
  root.replaceChildren();
  const data = jsonRecord(input);
  const entries = [
    data?.task ?? null,
    ...(Array.isArray(data?.tasks) ? data.tasks.slice(0, 8) : []),
  ];
  const seen = new Set<string>();
  const doc = root.ownerDocument;
  for (const entry of entries) {
    const task = jsonRecord(entry);
    if (
      !task ||
      typeof task.runId !== "string" ||
      task.runId.length > 128 ||
      seen.has(task.runId) ||
      seen.size >= 8 ||
      !Array.isArray(task.operations)
    )
      continue;
    seen.add(task.runId);
    const article = doc.createElement("article");
    article.dataset.runId = task.runId;
    const title = doc.createElement("p");
    title.textContent = "任务 " + task.runId + "：" + status(task.runStatus);
    article.append(title);
    if (task.operations.length === 0) {
      const waiting = doc.createElement("p");
      waiting.textContent = "等待原生成任务的处理记录。";
      article.append(waiting);
    }
    for (const item of task.operations.slice(0, 16)) {
      const operation = jsonRecord(item);
      if (
        !operation ||
        typeof operation.operationId !== "string" ||
        operation.operationId.length > 128
      )
        continue;
      const line = doc.createElement("p");
      line.textContent =
        "生成记录 " + operation.operationId + "：" + status(operation.status);
      article.append(line);
      if (!Array.isArray(operation.images)) continue;
      for (const image of operation.images.slice(0, 16)) {
        const metadata = jsonRecord(image);
        const href = imageUrl(metadata?.url);
        if (!href) continue;
        const link = doc.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent =
          typeof metadata?.filename === "string"
            ? metadata.filename.slice(0, 255)
            : "查看生成图片";
        article.append(link);
      }
    }
    if (task.truncated === true) {
      const hint = doc.createElement("p");
      hint.textContent = "仅显示本次返回的部分生成记录。";
      article.append(hint);
    }
    root.append(article);
  }
}
