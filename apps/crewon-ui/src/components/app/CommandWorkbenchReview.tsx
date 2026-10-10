import type { RecordedTaskChanges } from "../../lib/task-detail/recordedTaskChanges";
import { FileDiff, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { CapabilityPanel } from "../../lib/capability/capabilityPanelTypes";
import type { Locale, ToolId } from "../../lib/i18n";

export type WorkbenchDiffFile = {
  body: string;
  path: string;
};

export function parseWorkbenchDiff(diff: string): WorkbenchDiffFile[] {
  const matches = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  return matches.map((match, index) => ({
    body: diff
      .slice(match.index, matches[index + 1]?.index ?? diff.length)
      .trimEnd(),
    path: match[2] ?? match[1] ?? "unknown",
  }));
}

function diffLineKind(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "added";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "removed";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) {
    return "meta";
  }
  return "context";
}

export function CommandWorkbenchReview({
  busyToolId,
  locale,
  panel,
  onRefresh,
  recordedChanges,
}: {
  busyToolId: ToolId | null;
  locale: Locale;
  panel: CapabilityPanel | null;
  onRefresh: () => void;
  recordedChanges?: RecordedTaskChanges;
}) {
  const files = useMemo(
    () =>
      recordedChanges
        ? recordedChanges.files.map((file) => ({
            path: file.path,
            body: file.diff ?? "",
          }))
        : parseWorkbenchDiff(panel?.body ?? ""),
    [panel?.body, recordedChanges],
  );
  const [activePath, setActivePath] = useState<string | null>(
    files[0]?.path ?? null,
  );

  useEffect(() => {
    if (!files.some((file) => file.path === activePath)) {
      setActivePath(files[0]?.path ?? null);
    }
  }, [activePath, files]);

  const activeFile =
    files.find((file) => file.path === activePath) ?? files[0] ?? null;
  const recordedFile = recordedChanges?.files.find(
    (file) => file.path === activeFile?.path,
  );
  const loading = !recordedChanges && busyToolId === "review";

  return (
    <div
      className="command-review-workbench"
      data-recorded={recordedChanges ? "true" : undefined}
    >
      <header className="command-review-header">
        <span>
          <FileDiff aria-hidden="true" />
          <strong>
            {recordedChanges
              ? locale === "zh"
                ? "任务改动"
                : "Task changes"
              : locale === "zh"
                ? "审查"
                : "Review"}
          </strong>
          <em>
            {recordedChanges
              ? locale === "zh"
                ? "此对话的变更记录"
                : "Recorded changes in this conversation"
              : (panel?.subtitle ??
                (locale === "zh" ? "当前改动" : "Current changes"))}
          </em>
        </span>
        {!recordedChanges ? (
          <button disabled={loading} type="button" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
            {locale === "zh" ? "刷新" : "Refresh"}
          </button>
        ) : null}
      </header>
      <div className="command-review-layout">
        <aside className="command-review-files">
          <strong>
            {locale === "zh"
              ? `更改 (${files.length})`
              : `Changes (${files.length})`}
          </strong>
          {files.map((file) => (
            <button
              aria-label={recordedChanges ? file.path : undefined}
              data-active={activeFile?.path === file.path ? "true" : undefined}
              key={file.path}
              title={file.path}
              type="button"
              onClick={() => setActivePath(file.path)}
            >
              <FileDiff aria-hidden="true" />
              <span>
                {recordedChanges ? file.path.split("/").at(-1) : file.path}
              </span>
            </button>
          ))}
        </aside>
        <main className="command-review-diff">
          {recordedFile ? (
            <div className="command-review-recorded-path">
              <span title={recordedFile.path}>
                {recordedFile.path.split("/").at(-1)}
              </span>
              {recordedFile.diff ? (
                <span>
                  <em className="composer-progress-additions">
                    +{recordedFile.additions}
                  </em>{" "}
                  <em className="composer-progress-deletions">
                    -{recordedFile.deletions}
                  </em>
                </span>
              ) : null}
            </div>
          ) : null}
          {recordedChanges && !recordedChanges.complete ? (
            <div className="command-review-recorded-note">
              {locale === "zh"
                ? "部分差异内容未载入；以下为已记录的片段。"
                : "Some diff content is missing; showing recorded fragments."}
            </div>
          ) : null}
          {panel?.error ? <p role="alert">{panel.error}</p> : null}
          {loading && !activeFile ? (
            <div className="command-review-empty">
              {locale === "zh"
                ? "正在读取当前改动…"
                : "Reading current changes…"}
            </div>
          ) : activeFile && !activeFile.body ? (
            <div className="command-review-empty">
              {locale === "zh"
                ? "当前记录只包含文件路径，未提供差异内容。"
                : "Only the file path is recorded; diff content is unavailable."}
            </div>
          ) : activeFile ? (
            <div
              className="command-review-code"
              aria-label={activeFile.path}
              role="region"
            >
              {activeFile.body.split("\n").map((line, index) => (
                <div data-kind={diffLineKind(line)} key={`${index}:${line}`}>
                  <span aria-hidden="true">{index + 1}</span>
                  <code>{line || " "}</code>
                </div>
              ))}
            </div>
          ) : (
            <div className="command-review-empty">
              <FileDiff aria-hidden="true" />
              <strong>
                {locale === "zh" ? "没有可审查的改动" : "No changes to review"}
              </strong>
              <span>{panel?.body}</span>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
