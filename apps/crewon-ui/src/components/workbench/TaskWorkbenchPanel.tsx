import { useContext, useState } from "react";
import { FileText, Globe2 } from "lucide-react";
import { DeliveryClientContext } from "./DeliveryClientContext";
import { DeliveryPanel } from "./DeliveryPanel";
import { renderMarkdown } from "../TranscriptMarkdown";
import type { Locale } from "../../lib/i18n";
import type {
  TaskWorkbenchSnapshot,
  WorkbenchDocument,
} from "../../lib/workbench/taskWorkbenchProjection";
import {
  TaskWorkbenchActionsContext,
  WorkbenchPreviewSource,
} from "./TaskWorkbenchContext";
import "./TaskWorkbenchPanel.css";

export function documentKindLabel(
  kind: WorkbenchDocument["kind"],
  locale: Locale,
) {
  const labels =
    locale === "zh"
      ? {
          response: "会话输出",
          draft: "阶段产物 · 待核对",
          plan: "计划",
          partial: "未完成内容",
          verdict: "核验结论 · 非成稿",
        }
      : {
          response: "Response",
          draft: "Stage draft · needs review",
          plan: "Plan",
          partial: "Incomplete",
          verdict: "Verdict · not a deliverable",
        };
  return labels[kind];
}

export function TaskWorkbenchPanel({
  snapshot,
  locale,
}: {
  snapshot: TaskWorkbenchSnapshot | null;
  locale: Locale;
}) {
  const actions = useContext(TaskWorkbenchActionsContext);
  const deliveryClient = useContext(DeliveryClientContext);
  const threadId = snapshot?.scopeId.startsWith("thread:")
    ? snapshot.scopeId.slice("thread:".length)
    : null;
  const zh = locale === "zh";
  const [section, setSection] = useState<"documents" | "browser" | "delivery">(
    "documents",
  );
  const activeSection =
    section === "delivery" && !threadId ? "documents" : section;
  return (
    <section
      className="task-workbench"
      aria-label={zh ? "当前任务工作台" : "Current task workbench"}
    >
      <header>
        <small>{zh ? "当前任务" : "Current task"}</small>
        <h2 title={snapshot?.title}>
          {snapshot?.title || (zh ? "选择一个任务" : "Select a task")}
        </h2>
        <p>
          {zh
            ? "产出与浏览记录随当前会话更新，不代表已发布或发送。"
            : "Outputs and browsing records follow this task. They are not published or sent."}
        </p>
      </header>
      <div
        className="task-workbench-sections"
        role="tablist"
        aria-label={zh ? "任务内容" : "Task content"}
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === "documents"}
          onClick={() => setSection("documents")}
        >
          <FileText size={15} />
          {zh ? "产出" : "Outputs"}{" "}
          <span>{snapshot?.documents.length ?? 0}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === "browser"}
          onClick={() => setSection("browser")}
        >
          <Globe2 size={15} />
          {zh ? "浏览活动" : "Browsing"}{" "}
          <span>{snapshot?.browser.length ?? 0}</span>
        </button>
        {threadId && (
          <button
            type="button"
            role="tab"
            aria-selected={activeSection === "delivery"}
            onClick={() => setSection("delivery")}
          >
            <FileText size={15} />
            {zh ? "文件交付" : "File delivery"}
          </button>
        )}
      </div>
      {activeSection === "documents" ? (
        <div className="task-workbench-list">
          {snapshot?.documents.length ? (
            [...snapshot.documents].reverse().map((document) => (
              <button
                type="button"
                key={document.id}
                onClick={() => actions?.reveal(snapshot, document)}
              >
                <small>{documentKindLabel(document.kind, locale)}</small>
                <strong>{document.title}</strong>
                <span>{document.text.replace(/[#*`]/g, "").slice(0, 120)}</span>
                <em>{zh ? "查看原文 →" : "Read output →"}</em>
              </button>
            ))
          ) : (
            <p className="task-workbench-empty">
              {zh
                ? "暂时没有独立产物。计划和协作流阶段产出会显示在这里，普通回答保留在会话中。"
                : "No standalone outputs yet. Plans and workflow drafts appear here; ordinary replies stay in the conversation."}
            </p>
          )}
        </div>
      ) : activeSection === "browser" ? (
        <div className="task-workbench-list">
          <p className="task-workbench-note">
            {zh
              ? "这里只展示运行记录。打开网址是独立预览，不重放点击或输入，也不共享 Agent 的浏览会话。"
              : "These are run records. URL previews do not replay actions or share the Agent's browser session."}
          </p>
          {snapshot?.browser.length ? (
            [...snapshot.browser].reverse().map((activity) => (
              <article key={activity.id}>
                <small>
                  {
                    {
                      recorded: zh ? "已记录" : "Recorded",
                      inProgress: zh ? "执行中" : "Running",
                      completed: zh ? "已完成" : "Completed",
                      failed: zh ? "失败" : "Failed",
                    }[activity.status]
                  }
                </small>
                <strong>{activity.title}</strong>
                {activity.urls.map((url) => (
                  <button
                    className="task-workbench-url"
                    type="button"
                    key={url}
                    onClick={() =>
                      actions?.browse(snapshot, url, activity.title)
                    }
                  >
                    {url}
                  </button>
                ))}
                {!activity.urls.length && (
                  <span>
                    {zh ? "该操作未提供可预览网址" : "No preview URL recorded"}
                  </span>
                )}
              </article>
            ))
          ) : (
            <p className="task-workbench-empty">
              {zh
                ? "当前没有浏览器操作记录。正文中的网页链接也可点击，在右侧预览。"
                : "No browser actions recorded. Web links in the conversation can also open here."}
            </p>
          )}
        </div>
      ) : null}
      {threadId && (
        <div hidden={activeSection !== "delivery"}>
          <DeliveryPanel
            client={deliveryClient}
            threadId={threadId}
            locale={locale}
          />
        </div>
      )}
    </section>
  );
}

export function WorkbenchDocumentPreview({
  document,
  snapshot,
  locale,
}: {
  document: WorkbenchDocument;
  snapshot: TaskWorkbenchSnapshot;
  locale: Locale;
}) {
  const zh = locale === "zh";
  const [feedback, setFeedback] = useState<{
    version: string;
    text: string;
  } | null>(null);
  const copyStatus = feedback?.version === document.text ? feedback.text : "";
  const setCopyStatus = (text: string) =>
    setFeedback({ version: document.text, text });
  return (
    <WorkbenchPreviewSource snapshot={snapshot}>
      <section
        className="task-document-preview"
        aria-label={zh ? "产物预览" : "Output preview"}
      >
        <header>
          <small>{documentKindLabel(document.kind, locale)}</small>
          <h2>{document.title}</h2>
          <p>{document.source}</p>
          <div className="task-document-actions">
            <button
              type="button"
              onClick={() => {
                const target = [
                  ...window.document.querySelectorAll<HTMLElement>(
                    "[data-workbench-origin]",
                  ),
                ].find(
                  (element) =>
                    element.dataset.workbenchOrigin === document.originId,
                );
                if (target) {
                  target.closest("details")?.setAttribute("open", "");
                  target.scrollIntoView({
                    block: "center",
                    behavior: "instant",
                  });
                  target.focus({ preventScroll: true });
                } else
                  setCopyStatus(
                    zh
                      ? "原消息不在当前可见页面"
                      : "Source is not on this page",
                  );
              }}
            >
              {zh ? "定位原消息" : "Show source"}
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(document.text);
                  setCopyStatus(zh ? "已复制" : "Copied");
                } catch {
                  setCopyStatus(
                    zh
                      ? "复制失败，可直接选中文本"
                      : "Copy failed; select the text",
                  );
                }
              }}
            >
              {zh ? "复制正文" : "Copy text"}
            </button>
          </div>
          <span role="status">{copyStatus}</span>
        </header>
        <p className="task-workbench-note">
          {document.truncated
            ? zh
              ? "预览仅保留前40,000字符，请返回原消息核对全文。"
              : "Preview limited to 40,000 characters. Read the source for the full output."
            : zh
              ? "这是实际输出的只读预览；不是已保存文件，也不代表审批通过或已对外发送。"
              : "Read-only output, not a saved file or proof of approval/publication."}
        </p>
        <div className="task-document-body">
          {renderMarkdown(document.text)}
        </div>
      </section>
    </WorkbenchPreviewSource>
  );
}
