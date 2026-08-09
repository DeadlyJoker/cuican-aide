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
}: {
  busyToolId: ToolId | null;
  locale: Locale;
  panel: CapabilityPanel | null;
  onRefresh: () => void;
}) {
  const files = useMemo(
    () => parseWorkbenchDiff(panel?.body ?? ""),
    [panel?.body],
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
  const loading = busyToolId === "review";

  return (
    <div className="command-review-workbench">
      <header className="command-review-header">
        <span>
          <FileDiff aria-hidden="true" />
          <strong>{locale === "zh" ? "审查" : "Review"}</strong>
          <em>
            {panel?.subtitle ??
              (locale === "zh" ? "当前改动" : "Current changes")}
          </em>
        </span>
        <button disabled={loading} type="button" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
          {locale === "zh" ? "刷新" : "Refresh"}
        </button>
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
              data-active={activeFile?.path === file.path ? "true" : undefined}
              key={file.path}
              title={file.path}
              type="button"
              onClick={() => setActivePath(file.path)}
            >
              <FileDiff aria-hidden="true" />
              <span>{file.path}</span>
            </button>
          ))}
        </aside>
        <main className="command-review-diff">
          {panel?.error ? <p role="alert">{panel.error}</p> : null}
          {loading && !activeFile ? (
            <div className="command-review-empty">
              {locale === "zh"
                ? "正在读取当前改动…"
                : "Reading current changes…"}
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
