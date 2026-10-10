import { useEffect, useId, useState, type ReactNode } from "react";
import type { RunPlanStatus } from "@crewon/contracts";
import {
  Ban,
  CheckCircle2,
  ChevronUp,
  Circle,
  CircleDot,
  LoaderCircle,
  OctagonAlert,
} from "lucide-react";

import type { Locale } from "../../lib/i18n";
import type { ThreadProgressSummary } from "../../lib/thread/threadProgressSummary";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";

import type { RecordedTaskChanges } from "../../lib/task-detail/recordedTaskChanges";
import { ComposerTaskChanges } from "./ComposerTaskChanges";

function progressLabels(
  locale: Locale,
  summary: ThreadProgressSummary,
  taskChanges: ComposerTaskChangeSummary | null,
): Readonly<{
  additions: string | null;
  deletions: string | null;
  file: string | null;
  step: string | null;
}> {
  const number = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US");
  const step = summary.plan
    ? locale === "zh"
      ? `第 ${summary.plan.current} / ${summary.plan.total} 步`
      : `Step ${summary.plan.current} of ${summary.plan.total}`
    : summary.hasProposedPlan
      ? locale === "zh"
        ? "计划已生成"
        : "Plan proposed"
      : null;
  const file = taskChanges
    ? locale === "zh"
      ? `${number.format(taskChanges.files)} 个文件已更改`
      : `${number.format(taskChanges.files)} ${taskChanges.files === 1 ? "file" : "files"} changed`
    : null;
  return {
    additions: taskChanges ? `+${number.format(taskChanges.additions)}` : null,
    deletions: taskChanges ? `-${number.format(taskChanges.deletions)}` : null,
    file,
    step,
  };
}

export type ComposerTaskChangeSummary = Readonly<{
  additions: number;
  deletions: number;
  files: number;
}>;

function ProgressPillContents({
  additionsLabel,
  deletionsLabel,
  fileLabel,
  running,
  stepLabel,
}: {
  additionsLabel: string | null;
  deletionsLabel: string | null;
  fileLabel: string | null;
  running: boolean;
  stepLabel: string | null;
}) {
  return (
    <>
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
      {additionsLabel ? (
        <span className="composer-progress-additions">{additionsLabel}</span>
      ) : null}
      {deletionsLabel ? (
        <span className="composer-progress-deletions">{deletionsLabel}</span>
      ) : null}
    </>
  );
}

function statusPresentation(
  status: RunPlanStatus,
  locale: Locale,
): Readonly<{ icon: ReactNode; label: string }> {
  switch (status) {
    case "completed":
      return {
        icon: <CheckCircle2 aria-hidden="true" />,
        label: locale === "zh" ? "已完成" : "Completed",
      };
    case "inProgress":
      return {
        icon: <CircleDot aria-hidden="true" />,
        label: locale === "zh" ? "进行中" : "In progress",
      };
    case "blocked":
      return {
        icon: <OctagonAlert aria-hidden="true" />,
        label: locale === "zh" ? "受阻" : "Blocked",
      };
    case "canceled":
      return {
        icon: <Ban aria-hidden="true" />,
        label: locale === "zh" ? "已取消" : "Canceled",
      };
    case "pending":
      return {
        icon: <Circle aria-hidden="true" />,
        label: locale === "zh" ? "待处理" : "Pending",
      };
  }
}

export function ComposerProgressChecklist({
  descriptionId,
  locale,
  summary,
  titleId,
}: {
  descriptionId: string;
  locale: Locale;
  summary: ThreadProgressSummary;
  titleId: string;
}) {
  const { plan: progress, runPlan } = summary;
  if (!runPlan || !progress) return null;
  const currentItem =
    runPlan.items.find((item) => item.status === "inProgress") ??
    runPlan.items.find(
      (item) => item.status !== "completed" && item.status !== "canceled",
    ) ??
    null;
  const completionLabel =
    locale === "zh"
      ? `已完成 ${progress.completed} / ${progress.total} 项`
      : `${progress.completed} of ${progress.total} completed`;

  return (
    <>
      <PopoverHeader className="composer-progress-popover-header">
        <PopoverTitle id={titleId}>
          {locale === "zh" ? "执行计划" : "Execution plan"}
        </PopoverTitle>
        {runPlan.explanation ? (
          <PopoverDescription id={descriptionId}>
            {runPlan.explanation}
          </PopoverDescription>
        ) : (
          <span className="visually-hidden" id={descriptionId}>
            {completionLabel}
          </span>
        )}
        <div
          aria-label={completionLabel}
          aria-valuemax={progress.total}
          aria-valuemin={0}
          aria-valuenow={progress.completed}
          aria-valuetext={completionLabel}
          className="composer-progress-meter"
          role="progressbar"
        >
          {completionLabel}
        </div>
      </PopoverHeader>
      <ol className="composer-progress-checklist">
        {runPlan.items.map((item) => {
          const status = statusPresentation(item.status, locale);
          return (
            <li
              aria-current={
                currentItem?.itemId === item.itemId ? "step" : undefined
              }
              data-status={item.status}
              key={item.itemId}
            >
              <span className="composer-progress-item-icon">{status.icon}</span>
              <span className="composer-progress-item-title">{item.title}</span>
              <span className="composer-progress-item-status">
                {status.label}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

export function ComposerProgressPill({
  locale,
  running,
  summary,
  taskChanges = null,
  changeDetails = null,
  onOpenChanges,
}: {
  locale: Locale;
  running: boolean;
  summary: ThreadProgressSummary;
  taskChanges?: ComposerTaskChangeSummary | null;
  changeDetails?: RecordedTaskChanges | null;
  onOpenChanges?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const interactiveChanges = changeDetails && taskChanges && onOpenChanges;
  const labels = progressLabels(
    locale,
    summary,
    interactiveChanges ? null : taskChanges,
  );
  const wrapChanges = (progress: ReactNode) =>
    changeDetails && taskChanges && onOpenChanges ? (
      <div className="composer-progress-summary">
        {labels.step || running ? progress : null}
        {labels.step ? (
          <span aria-hidden="true" className="composer-progress-separator">
            ·
          </span>
        ) : null}
        <ComposerTaskChanges
          details={changeDetails}
          locale={locale}
          summary={taskChanges}
          onOpen={onOpenChanges}
        />
      </div>
    ) : (
      progress
    );
  const identity = `${summary.runId ?? "none"}:${summary.runPlan?.planId ?? "none"}`;

  useEffect(() => setOpen(false), [identity]);

  if (!summary.runPlan || !summary.plan) {
    return wrapChanges(
      <div
        className="composer-progress-pill"
        data-od-id="composer-progress-pill"
        role="status"
      >
        <ProgressPillContents
          additionsLabel={labels.additions}
          deletionsLabel={labels.deletions}
          fileLabel={labels.file}
          running={running}
          stepLabel={labels.step}
        />
      </div>,
    );
  }

  const liveLabel = [
    labels.step,
    [labels.file, labels.additions, labels.deletions].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(" · ");
  return wrapChanges(
    <Popover modal={false} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          aria-controls={contentId}
          aria-label={
            locale === "zh"
              ? `${liveLabel}，查看执行计划`
              : `${liveLabel}, view execution plan`
          }
          className="composer-progress-pill composer-progress-trigger"
          data-od-id="composer-progress-pill"
          type="button"
        >
          <ProgressPillContents
            additionsLabel={labels.additions}
            deletionsLabel={labels.deletions}
            fileLabel={labels.file}
            running={running}
            stepLabel={labels.step}
          />
          <ChevronUp
            aria-hidden="true"
            className="composer-progress-disclosure"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        className="composer-progress-popover"
        collisionPadding={12}
        id={contentId}
        side="top"
        sideOffset={8}
      >
        <ComposerProgressChecklist
          descriptionId={descriptionId}
          locale={locale}
          summary={summary}
          titleId={titleId}
        />
      </PopoverContent>
      <span aria-live="polite" className="visually-hidden" role="status">
        {liveLabel}
      </span>
    </Popover>,
  );
}
