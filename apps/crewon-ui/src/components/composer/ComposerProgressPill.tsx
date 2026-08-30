import { LoaderCircle } from "lucide-react";

import type { Locale } from "../../lib/i18n";
import type { ThreadProgressSummary } from "../../lib/thread/threadProgressSummary";

export function ComposerProgressPill({
  locale,
  running,
  summary,
}: {
  locale: Locale;
  running: boolean;
  summary: ThreadProgressSummary;
}) {
  const { fileChanges, hasProposedPlan, plan } = summary;
  const stepLabel = plan
    ? locale === "zh"
      ? `第 ${plan.current} / ${plan.total} 步`
      : `Step ${plan.current} of ${plan.total}`
    : hasProposedPlan
      ? locale === "zh"
        ? "计划已生成"
        : "Plan proposed"
      : null;
  const fileLabel = fileChanges
    ? locale === "zh"
      ? `${fileChanges.files} 个文件已更改`
      : `${fileChanges.files} ${fileChanges.files === 1 ? "file" : "files"} changed`
    : null;

  return (
    <div
      className="composer-progress-pill"
      data-od-id="composer-progress-pill"
      role="status"
    >
      {running ? (
        <LoaderCircle
          aria-hidden="true"
          className="spin composer-progress-spinner"
        />
      ) : null}
      {stepLabel ? (
        <span className="composer-progress-step">{stepLabel}</span>
      ) : null}
      {stepLabel && fileLabel ? (
        <span aria-hidden="true" className="composer-progress-separator">
          ·
        </span>
      ) : null}
      {fileLabel ? (
        <span className="composer-progress-files">{fileLabel}</span>
      ) : null}
    </div>
  );
}
