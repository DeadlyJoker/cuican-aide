import { CheckCircle2, CircleAlert } from "lucide-react";

import type { Locale } from "../../lib/i18n";
import type {
  OfficeMemoryRefActivity,
  OfficeRunActivity,
  OfficeRunDelegationActivity,
  OfficeRunVerificationCheckActivity,
} from "../../lib/domain/crewonDomain";
import {
  officeRunRetryActionLabel,
  officeRunRetryLimitReached,
  officeRunRetryPendingActionLabel,
} from "../../lib/office/officeRunPanel";

function runStatusLabel(status: OfficeRunActivity["status"], locale: Locale) {
  return locale === "zh"
    ? {
        queued: "排队中",
        running: "运行中",
        canceling: "取消中",
        completed: "已完成",
        failed: "失败",
        interrupted: "已中断",
      }[status]
    : {
        queued: "Queued",
        running: "Running",
        canceling: "Canceling",
        completed: "Completed",
        failed: "Failed",
        interrupted: "Interrupted",
      }[status];
}

function officeRunNotificationReasonLabel(
  reason: string | undefined,
  locale: Locale,
) {
  if (!reason || !officeRunNotificationReasonShouldSurface(reason)) {
    return null;
  }
  if (locale === "zh") {
    return reason === "autoDispatchStarted"
      ? "自动分派已启动"
      : reason === "autoVerificationStarted"
        ? "自动验证已启动"
        : reason === "autoReplanStarted"
          ? "自动重规划已启动"
          : reason === "autoDispatchCompletion"
            ? "自动任务已完成同步"
            : reason === "historyRecovery"
              ? "历史记录恢复"
              : reason === "runtimeRepair"
                ? "运行时路由已修复"
                : humanizeOfficeRunNotificationReason(reason);
  }
  return reason === "autoDispatchStarted"
    ? "Auto dispatch started"
    : reason === "autoVerificationStarted"
      ? "Auto verification started"
      : reason === "autoReplanStarted"
        ? "Auto replan started"
        : reason === "autoDispatchCompletion"
          ? "Auto task completion synced"
          : reason === "historyRecovery"
            ? "History recovered"
            : reason === "runtimeRepair"
              ? "Runtime repaired"
              : humanizeOfficeRunNotificationReason(reason);
}

function officeRunNotificationReasonShouldSurface(reason: string) {
  const normalized = reason.toLowerCase();
  return (
    normalized.startsWith("auto") ||
    normalized.includes("recovery") ||
    normalized.includes("repair")
  );
}

function officeRunNotificationKind(reason: string | undefined) {
  const normalized = reason?.toLowerCase() ?? "";
  if (normalized.startsWith("auto")) {
    return "auto";
  }
  if (normalized.includes("recovery") || normalized.includes("repair")) {
    return "recovery";
  }
  return "update";
}

function officeRunNotificationKindLabel(
  reason: string | undefined,
  locale: Locale,
) {
  const kind = officeRunNotificationKind(reason);
  if (locale === "zh") {
    return kind === "auto" ? "自动循环" : kind === "recovery" ? "恢复" : "更新";
  }
  return kind === "auto"
    ? "Auto loop"
    : kind === "recovery"
      ? "Recovery"
      : "Update";
}

function humanizeOfficeRunNotificationReason(reason: string) {
  const label = reason.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function officeRunNotificationSourceDetails(
  run: OfficeRunActivity,
  locale: Locale,
) {
  return [
    run.lastNotificationSourceThreadId
      ? `${locale === "zh" ? "线程" : "thread"} ${
          run.lastNotificationSourceThreadId
        }`
      : null,
    run.lastNotificationSourceTurnId
      ? `${locale === "zh" ? "回合" : "turn"} ${
          run.lastNotificationSourceTurnId
        }`
      : null,
  ].filter((detail): detail is string => Boolean(detail));
}

function planStatusLabel(status: string | undefined, locale: Locale) {
  return locale === "zh"
    ? status === "completed"
      ? "完成"
      : status === "inProgress"
        ? "进行中"
        : "待办"
    : status === "completed"
      ? "Done"
      : status === "inProgress"
        ? "Running"
        : "Pending";
}

function loopReviewStatusLabel(status: string | undefined, locale: Locale) {
  if (locale === "zh") {
    return status === "passed"
      ? "通过"
      : status === "blocked"
        ? "阻塞"
        : status === "needsReview"
          ? "需复核"
          : "未完整";
  }
  return status === "passed"
    ? "Passed"
    : status === "blocked"
      ? "Blocked"
      : status === "needsReview"
        ? "Needs review"
        : "Incomplete";
}

function loopReviewNextActionLabel(action: string | undefined, locale: Locale) {
  if (locale === "zh") {
    return action === "readyToSummarize"
      ? "可总结"
      : action === "repairFailedCriteria"
        ? "修复失败验收"
        : action === "collectVerificationEvidence"
          ? "补充验证证据"
          : action === "runVerificationChecks"
            ? "运行验证检查"
            : action === "mitigateHighRisks"
              ? "缓解高风险"
              : action === "frameAcceptanceCriteria"
                ? "补充验收标准"
                : action;
  }
  return action === "readyToSummarize"
    ? "Ready to summarize"
    : action === "repairFailedCriteria"
      ? "Repair failed criteria"
      : action === "collectVerificationEvidence"
        ? "Collect verification evidence"
        : action === "runVerificationChecks"
          ? "Run verification checks"
          : action === "mitigateHighRisks"
            ? "Mitigate high risks"
            : action === "frameAcceptanceCriteria"
              ? "Frame acceptance criteria"
              : action;
}

function loopPhaseLabel(phase: string | undefined, locale: Locale) {
  if (locale === "zh") {
    return phase === "frame"
      ? "定义"
      : phase === "plan"
        ? "计划"
        : phase === "delegate"
          ? "分派"
          : phase === "act"
            ? "执行"
            : phase === "observe"
              ? "观测"
              : phase === "verify"
                ? "验证"
                : phase === "correct"
                  ? "修正"
                  : phase === "summarize"
                    ? "总结"
                    : phase;
  }
  return phase === "frame"
    ? "Frame"
    : phase === "plan"
      ? "Plan"
      : phase === "delegate"
        ? "Delegate"
        : phase === "act"
          ? "Act"
          : phase === "observe"
            ? "Observe"
            : phase === "verify"
              ? "Verify"
              : phase === "correct"
                ? "Correct"
                : phase === "summarize"
                  ? "Summarize"
                  : phase;
}

function loopStopConditionLabel(
  condition: string | undefined,
  locale: Locale,
) {
  if (!condition) {
    return locale === "zh" ? "未知门槛" : "Unknown gate";
  }
  if (locale === "zh") {
    return condition === "acceptanceCriteriaDefined"
      ? "验收已定义"
      : condition === "allAcceptanceCriteriaPassed"
        ? "验收通过"
        : condition === "verificationComplete"
          ? "验证完成"
          : condition === "evidenceCollected"
            ? "证据已收集"
            : condition === "noBlockedEvidence"
              ? "无阻塞证据"
              : condition === "noOpenHighRisk"
                ? "无开放高风险"
                : condition === "withinIterationLimit"
                  ? "轮次未超限"
                  : condition === "hasRetryBudget"
                    ? "仍有重试预算"
                    : condition;
  }
  return condition === "acceptanceCriteriaDefined"
    ? "Criteria framed"
    : condition === "allAcceptanceCriteriaPassed"
      ? "Criteria passed"
      : condition === "verificationComplete"
        ? "Verification complete"
        : condition === "evidenceCollected"
          ? "Evidence collected"
          : condition === "noBlockedEvidence"
            ? "No blocked evidence"
            : condition === "noOpenHighRisk"
              ? "No open high risk"
              : condition === "withinIterationLimit"
                ? "Within iteration limit"
                : condition === "hasRetryBudget"
                  ? "Retry budget available"
                  : condition;
}

function loopStopConditionStatusLabel(met: boolean | undefined, locale: Locale) {
  return met
    ? locale === "zh"
      ? "满足"
      : "Met"
    : locale === "zh"
      ? "待满足"
      : "Needed";
}

type OfficeRunEvidenceItem = NonNullable<OfficeRunActivity["evidence"]>[number];

function evidenceKindLabel(kind: string | undefined, locale: Locale) {
  if (!kind) {
    return null;
  }
  if (locale === "zh") {
    return kind === "commandExecution"
      ? "命令"
      : kind === "fileChange"
        ? "文件变更"
        : kind;
  }
  return kind === "commandExecution"
    ? "Command"
    : kind === "fileChange"
      ? "File change"
      : kind;
}

function evidencePathSummary(item: OfficeRunEvidenceItem) {
  if (!item.paths?.length) {
    return null;
  }
  const visiblePaths = item.paths.slice(0, 2).join(", ");
  const remaining = item.paths.length - 2;
  return remaining > 0 ? `${visiblePaths}, +${remaining}` : visiblePaths;
}

function evidenceFileCountLabel(count: number, locale: Locale) {
  if (locale === "zh") {
    return `${count} 个文件`;
  }
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function shortEvidenceHash(hash: string) {
  return hash.length > 12 ? hash.slice(0, 12) : hash;
}

function officeRunEvidenceDetails(item: OfficeRunEvidenceItem, locale: Locale) {
  const details: string[] = [];
  if (item.status) {
    details.push(item.status);
  }
  details.push(item.summary);
  const kind = evidenceKindLabel(item.evidenceKind, locale);
  if (kind) {
    details.push(kind);
  } else if (item.source) {
    details.push(item.source);
  }
  if (item.command) {
    details.push(item.command);
  }
  const paths = evidencePathSummary(item);
  if (paths) {
    details.push(paths);
  }
  if (typeof item.changeCount === "number") {
    details.push(evidenceFileCountLabel(item.changeCount, locale));
  }
  if (typeof item.exitCode === "number") {
    details.push(`exit ${item.exitCode}`);
  }
  if (typeof item.durationMs === "number") {
    details.push(`${item.durationMs}ms`);
  }
  if (item.outputPreview) {
    details.push(item.outputPreview);
  }
  if (item.outputSha256) {
    details.push(`out ${shortEvidenceHash(item.outputSha256)}`);
  }
  if (item.changesSha256) {
    details.push(`diff ${shortEvidenceHash(item.changesSha256)}`);
  }
  if (item.member) {
    details.push(item.agentId ? `${item.member}/${item.agentId}` : item.member);
  }
  if (item.delegationId) {
    details.push(item.delegationId);
  }
  if (item.sourceTurnId && item.sourceTurnId !== item.source) {
    details.push(
      locale === "zh"
        ? `回合 ${item.sourceTurnId}`
        : `turn ${item.sourceTurnId}`,
    );
  }
  return details;
}

function officeRunVerificationDetails(item: OfficeRunVerificationCheckActivity) {
  return [
    item.status,
    item.check,
    item.criterion,
    item.criterionId,
    item.acceptanceId,
    item.command,
    item.automationId,
    item.dispatchStatus,
    item.automationStatus,
    item.automationRunId,
    item.automationTurnId,
    item.retryOfAutomationTurnId
      ? `retry turn ${item.retryOfAutomationTurnId}`
      : null,
    item.artifact,
    item.evidence,
    typeof item.exitCode === "number" ? `exit ${item.exitCode}` : null,
    typeof item.durationMs === "number" ? `${item.durationMs}ms` : null,
    item.outputPreview,
    item.outputSha256 ? `out ${shortEvidenceHash(item.outputSha256)}` : null,
    item.source,
    item.itemId,
    item.member && item.agentId
      ? `${item.member}/${item.agentId}`
      : item.member,
    item.delegationId,
  ].filter(Boolean);
}

function officeRunMemoryRefDetails(memory: OfficeMemoryRefActivity) {
  const evidenceRef = memory.evidenceRefs?.[0];
  return [
    memory.scope,
    memory.kind,
    memory.status,
    memory.confidence,
    memory.importance ? `importance ${memory.importance}` : null,
    memory.member && memory.agentId
      ? `${memory.member}/${memory.agentId}`
      : memory.member,
    !memory.member && memory.agentId ? memory.agentId : null,
    evidenceRef?.turnId
      ? `turn ${evidenceRef.turnId}`
      : evidenceRef?.threadId
        ? `thread ${evidenceRef.threadId}`
        : evidenceRef?.runId
          ? `run ${evidenceRef.runId}`
          : null,
    memory.evidenceRefs && memory.evidenceRefs.length > 1
      ? `refs ${memory.evidenceRefs.length}`
      : null,
    memory.content,
  ].filter(Boolean);
}

type ActivityOfficeRunsProps = {
  locale: Locale;
  runs: OfficeRunActivity[];
  onDelegationDispatch?: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void;
  onDelegationCancel?: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void;
  onDelegationDispatchNext?: (run: OfficeRunActivity) => void;
  onDelegationRetry?: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => void;
  onVerificationCancel?: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => void;
  onVerificationRetry?: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => void;
  onRunCancel?: (run: OfficeRunActivity) => void;
  onRunRetry?: (run: OfficeRunActivity) => void;
  pendingDelegationId?: string | null;
  pendingVerificationCheckId?: string | null;
  pendingRunAction?: "cancel" | "retry" | null;
  pendingRunId?: string | null;
};

const runStatusPriority: Record<OfficeRunActivity["status"], number> = {
  running: 0,
  canceling: 1,
  failed: 2,
  interrupted: 3,
  queued: 4,
  completed: 5,
};

function runSortTimestamp(run: OfficeRunActivity) {
  return run.updatedAt ?? run.completedAt ?? run.createdAt ?? "";
}

function delegationActionKey(
  run: OfficeRunActivity,
  delegation: OfficeRunDelegationActivity,
  idx = 0,
) {
  return (
    delegation.id ??
    `${run.id}:${delegation.agentId ?? delegation.member ?? "agent"}:${delegation.task ?? idx}`
  );
}

function canDispatchDelegation(delegation: OfficeRunDelegationActivity) {
  if (!delegation.task || (!delegation.member && !delegation.agentId)) {
    return false;
  }
  if (delegation.turnId) {
    return false;
  }
  if (
    delegation.id &&
    ["failed", "interrupted"].includes(delegation.status ?? "")
  ) {
    return false;
  }
  return ![
    "blocked",
    "canceling",
    "completed",
    "done",
    "running",
    "skipped",
  ].includes(delegation.status ?? "");
}

function canRetryDelegation(delegation: OfficeRunDelegationActivity) {
  return Boolean(
    delegation.id &&
      delegation.task?.trim() &&
      (delegation.member || delegation.agentId) &&
      ["failed", "interrupted"].includes(delegation.status ?? ""),
  );
}

function canCancelDelegation(delegation: OfficeRunDelegationActivity) {
  const status = delegation.status ?? "";
  return Boolean(
    delegation.id &&
      delegation.threadId &&
      delegation.turnId &&
      ["queued", "running"].includes(status),
  );
}

function verificationCheckActionKey(
  run: OfficeRunActivity,
  check: OfficeRunVerificationCheckActivity,
  idx = 0,
) {
  return (
    check.itemId ??
    check.automationRunId ??
    check.automationId ??
    `${run.id}:verification:${check.check ?? idx}`
  );
}

function canCancelVerificationCheck(check: OfficeRunVerificationCheckActivity) {
  const runStatus = check.status ?? "pending";
  const dispatchStatus = check.dispatchStatus ?? check.automationStatus ?? "";
  return Boolean(
    !["passed", "failed", "completed", "interrupted", "skipped"].includes(
      runStatus,
    ) &&
      ["queued", "running"].includes(dispatchStatus) &&
      (check.itemId ?? check.automationId ?? check.check)?.trim() &&
      check.automationThreadId &&
      check.automationTurnId,
  );
}

function canRetryVerificationCheck(check: OfficeRunVerificationCheckActivity) {
  const status = check.status ?? "";
  const dispatchStatus = check.dispatchStatus ?? "";
  const automationStatus = check.automationStatus ?? "";
  return Boolean(
    (check.itemId ?? check.automationId ?? check.check)?.trim() &&
      check.automationId?.trim() &&
      !["queued", "running", "canceling"].includes(dispatchStatus) &&
      (["failed", "interrupted"].includes(status) ||
        ["failed", "interrupted"].includes(dispatchStatus) ||
        ["failed", "interrupted"].includes(automationStatus)),
  );
}

export function ActivityOfficeRuns({
  locale,
  runs,
  onDelegationDispatch,
  onDelegationCancel,
  onDelegationDispatchNext,
  onDelegationRetry,
  onVerificationCancel,
  onVerificationRetry,
  onRunCancel,
  onRunRetry,
  pendingDelegationId = null,
  pendingVerificationCheckId = null,
  pendingRunAction = null,
  pendingRunId = null,
}: ActivityOfficeRunsProps) {
  if (runs.length === 0) {
    return null;
  }

  const isZh = locale === "zh";
  const sortedRuns = [...runs].sort((left, right) => {
    const priorityDelta =
      runStatusPriority[left.status] - runStatusPriority[right.status];
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return runSortTimestamp(right).localeCompare(runSortTimestamp(left));
  });
  const activeCount = runs.filter((run) =>
    ["queued", "running", "canceling"].includes(run.status),
  ).length;
  const issueCount = runs.filter((run) =>
    ["failed", "interrupted"].includes(run.status),
  ).length;
  const summary = isZh
    ? [
        activeCount > 0 ? `${activeCount} 个活跃` : null,
        issueCount > 0 ? `${issueCount} 个需处理` : null,
      ]
        .filter(Boolean)
        .join(" · ") || `${runs.length} 条`
    : [
        activeCount > 0 ? `${activeCount} active` : null,
        issueCount > 0 ? `${issueCount} need attention` : null,
      ]
        .filter(Boolean)
        .join(" · ") || `${runs.length} total`;

  return (
    <section className="activity-card activity-runs">
      <div className="activity-card-head">
        <h2>{isZh ? "团队执行" : "Team runs"}</h2>
        <span>{summary}</span>
      </div>
      <div className="office-run-list">
        {sortedRuns.slice(0, 5).map((run) => {
          const detail = run.error ?? run.resultPreview ?? run.promptPreview;
          const isPendingRun = pendingRunId === run.id;
          const hasPendingAction = Boolean(
            pendingRunId || pendingDelegationId || pendingVerificationCheckId,
          );
          const canCancel =
            run.status === "running" &&
            Boolean(run.turnId && onRunCancel) &&
            !hasPendingAction;
          const retryLimitReached =
            ["completed", "failed", "interrupted"].includes(run.status) &&
            Boolean(onRunRetry) &&
            officeRunRetryLimitReached(run);
          const canRetry =
            ["completed", "failed", "interrupted"].includes(run.status) &&
            Boolean(onRunRetry) &&
            !retryLimitReached &&
            !hasPendingAction;
          const hasDispatchableDelegation = Boolean(
            onDelegationDispatchNext &&
              run.delegations?.some(canDispatchDelegation) &&
              !hasPendingAction,
          );
          const meta = [
            run.turnId ? `turn ${run.turnId}` : null,
            run.retryOf ? `${isZh ? "重试" : "retry"} ${run.retryOf}` : null,
            run.updatedAt ?? run.completedAt ?? run.createdAt ?? null,
          ]
            .filter(Boolean)
            .join(" · ");
          const updateReasonLabel = officeRunNotificationReasonLabel(
            run.lastNotificationReason,
            locale,
          );
          const updateSourceDetails = officeRunNotificationSourceDetails(
            run,
            locale,
          );

          return (
            <article
              className="office-run-row"
              data-status={run.status}
              key={run.id}
            >
              <div className="office-run-top">
                <strong>{run.title}</strong>
                <span className="office-run-status" data-status={run.status}>
                  {runStatusLabel(run.status, locale)}
                </span>
              </div>
              {meta ? <p className="office-run-meta">{meta}</p> : null}
              {updateReasonLabel ? (
                <div
                  className="office-run-update"
                  data-kind={officeRunNotificationKind(
                    run.lastNotificationReason,
                  )}
                >
                  <strong>
                    {officeRunNotificationKindLabel(
                      run.lastNotificationReason,
                      locale,
                    )}
                  </strong>
                  <span>{updateReasonLabel}</span>
                  {updateSourceDetails.map((detail) => (
                    <span key={detail}>{detail}</span>
                  ))}
                </div>
              ) : null}
              {run.goal ? (
                <p className="office-run-goal">
                  <span>{isZh ? "目标" : "Goal"}</span>
                  {run.goal}
                </p>
              ) : null}
              {detail ? <p className="office-run-detail">{detail}</p> : null}
              {run.plan?.length ? (
                <ol className="office-run-plan">
                  {run.plan.slice(0, 4).map((item, idx) => (
                    <li
                      data-status={item.status ?? "pending"}
                      key={`${item.step}:${idx}`}
                    >
                      <span>{planStatusLabel(item.status, locale)}</span>
                      <strong>{item.step}</strong>
                    </li>
                  ))}
                </ol>
              ) : null}
              {run.loop?.review ? (
                <div
                  className="office-run-loop-review"
                  data-status={run.loop.review.status ?? "incomplete"}
                >
                  <strong>{isZh ? "Loop 审查" : "Loop review"}</strong>
                  <span>
                    {loopReviewStatusLabel(run.loop.review.status, locale)}
                  </span>
                  {run.loop.iteration ? (
                    <span>
                      {isZh ? "轮次" : "Iteration"} {run.loop.iteration}
                      {run.loop.maxIterations ? `/${run.loop.maxIterations}` : ""}
                    </span>
                  ) : null}
                  {run.loop.phase ? (
                    <span>
                      {isZh ? "阶段" : "Phase"}{" "}
                      {loopPhaseLabel(run.loop.phase, locale)}
                    </span>
                  ) : null}
                  {typeof run.loop.metrics?.retryBudgetRemaining ===
                  "number" ? (
                    <span>
                      {isZh ? "重试预算" : "Retry budget"}{" "}
                      {run.loop.metrics.retryBudgetRemaining}
                    </span>
                  ) : null}
                  <span>
                    {isZh ? "验收" : "Criteria"}{" "}
                    {run.loop.review.acceptance?.passed ?? 0}/
                    {run.loop.review.acceptance?.total ?? 0}
                  </span>
                  <span>
                    {isZh ? "证据" : "Evidence"}{" "}
                    {run.loop.review.evidence?.verified ?? 0}/
                    {run.loop.review.evidence?.total ?? 0}
                  </span>
                  {run.loop.review.verification?.total ? (
                    <span>
                      {isZh ? "检查" : "Checks"}{" "}
                      {run.loop.review.verification.passed ?? 0}/
                      {run.loop.review.verification.total ?? 0}
                    </span>
                  ) : null}
                  {run.loop.review.verification?.runnablePending ? (
                    <span>
                      {isZh ? "可运行" : "Runnable"}{" "}
                      {run.loop.review.verification.runnablePending}
                    </span>
                  ) : null}
                  {run.loop.review.verification?.missingRunnablePending ? (
                    <span>
                      {isZh ? "缺少执行引用" : "Needs runnable ref"}{" "}
                      {run.loop.review.verification.missingRunnablePending}
                    </span>
                  ) : null}
                  {run.loop.review.risks?.openHigh ? (
                    <span>
                      {isZh ? "高风险" : "High risk"}{" "}
                      {run.loop.review.risks.openHigh}
                    </span>
                  ) : null}
                  {run.loop.review.nextAction ? (
                    <span>
                      {loopReviewNextActionLabel(
                        run.loop.review.nextAction,
                        locale,
                      )}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {run.loop?.stopConditions?.length ? (
                <div
                  className="office-run-stop-conditions"
                  aria-label={isZh ? "完成门槛" : "Completion gate"}
                >
                  <strong>{isZh ? "完成门槛" : "Completion gate"}</strong>
                  {run.loop.stopConditions.slice(0, 8).map((condition, idx) => {
                    const met = condition.met === true;
                    return (
                      <span
                        data-met={met ? "true" : "false"}
                        key={`${condition.condition ?? "condition"}:${idx}`}
                      >
                        {met ? (
                          <CheckCircle2 size={13} aria-hidden="true" />
                        ) : (
                          <CircleAlert size={13} aria-hidden="true" />
                        )}
                        <b>
                          {loopStopConditionLabel(
                            condition.condition,
                            locale,
                          )}
                        </b>
                        <em>
                          {loopStopConditionStatusLabel(
                            condition.met,
                            locale,
                          )}
                        </em>
                      </span>
                    );
                  })}
                </div>
              ) : null}
              {run.acceptanceCriteria?.length ||
              run.verificationChecks?.length ||
              run.evidence?.length ||
              run.risks?.length ? (
                <div className="office-run-signals">
                  {run.acceptanceCriteria?.slice(0, 3).map((item, idx) => (
                    <span key={`criteria:${item.criterion}:${idx}`}>
                      <strong>{isZh ? "验收" : "Criteria"}</strong>
                      {item.status ? ` · ${item.status}` : ""}
                      {` · ${item.criterion}`}
                      {item.criterionId ? ` · ${item.criterionId}` : ""}
                      {item.evidence ? ` · ${item.evidence}` : ""}
                      {item.verifiedByCheck
                        ? ` · ${isZh ? "检查" : "check"} ${item.verifiedByCheck}`
                        : ""}
                    </span>
                  ))}
                  {run.verificationChecks?.slice(0, 3).map((item, idx) => {
                    const checkKey = verificationCheckActionKey(
                      run,
                      item,
                      idx,
                    );
                    const isPendingVerification =
                      pendingVerificationCheckId === checkKey;
                    const canCancelVerification =
                      Boolean(onVerificationCancel) &&
                      canCancelVerificationCheck(item) &&
                      (!hasPendingAction || isPendingVerification);
                    const canRetryVerification =
                      Boolean(onVerificationRetry) &&
                      canRetryVerificationCheck(item) &&
                      (!hasPendingAction || isPendingVerification);
                    const content = (
                      <>
                        <strong>{isZh ? "检查" : "Check"}</strong>
                        {` · ${officeRunVerificationDetails(item).join(" · ")}`}
                      </>
                    );
                    if (
                      !canCancelVerification &&
                      !canRetryVerification &&
                      !isPendingVerification
                    ) {
                      return (
                        <span key={`verification:${item.check}:${idx}`}>
                          {content}
                        </span>
                      );
                    }
                    return (
                      <span
                        className="office-run-signal-row"
                        key={`verification:${item.check}:${idx}`}
                      >
                        <span className="office-run-signal-text">
                          {content}
                        </span>
                        {canRetryVerification ||
                        (isPendingVerification &&
                          canRetryVerificationCheck(item)) ? (
                          <button
                            type="button"
                            disabled={hasPendingAction}
                            onClick={() => onVerificationRetry?.(run, item)}
                          >
                            {isPendingVerification
                              ? isZh
                                ? "重试中"
                                : "Retrying"
                              : isZh
                                ? "重试"
                                : "Retry"}
                          </button>
                        ) : null}
                        {canCancelVerification ||
                        (isPendingVerification &&
                          canCancelVerificationCheck(item)) ? (
                          <button
                            type="button"
                            disabled={hasPendingAction}
                            onClick={() => onVerificationCancel?.(run, item)}
                          >
                            {isPendingVerification
                              ? isZh
                                ? "取消中"
                                : "Canceling"
                              : isZh
                                ? "取消"
                                : "Cancel"}
                          </button>
                        ) : null}
                      </span>
                    );
                  })}
                  {run.evidence?.slice(0, 3).map((item, idx) => (
                    <span key={`evidence:${item.summary}:${idx}`}>
                      <strong>{isZh ? "证据" : "Evidence"}</strong>
                      {` · ${officeRunEvidenceDetails(item, locale).join(" · ")}`}
                    </span>
                  ))}
                  {run.risks?.slice(0, 3).map((item, idx) => (
                    <span key={`risk:${item.summary}:${idx}`}>
                      <strong>{isZh ? "风险" : "Risk"}</strong>
                      {item.severity ? ` · ${item.severity}` : ""}
                      {` · ${item.summary}`}
                      {item.mitigation ? ` · ${item.mitigation}` : ""}
                    </span>
                  ))}
                </div>
              ) : null}
              {run.delegations?.length ? (
                <div className="office-run-delegations">
                  {run.delegations.slice(0, 4).map((delegation, idx) => {
                    const delegationKey = delegationActionKey(
                      run,
                      delegation,
                      idx,
                    );
                    const isPendingDelegation =
                      pendingDelegationId === delegationKey;
                    const canDispatch =
                      Boolean(onDelegationDispatch) &&
                      canDispatchDelegation(delegation) &&
                      (!hasPendingAction || isPendingDelegation);
                    const canCancelDelegationAction =
                      Boolean(onDelegationCancel) &&
                      canCancelDelegation(delegation) &&
                      (!hasPendingAction || isPendingDelegation);
                    const canRetryDelegationAction =
                      Boolean(onDelegationRetry) &&
                      canRetryDelegation(delegation) &&
                      (!hasPendingAction || isPendingDelegation);
                    return (
                      <span
                        className="office-run-delegation-row"
                        key={`${delegation.member ?? "agent"}:${idx}`}
                      >
                        <span className="office-run-delegation-text">
                          <strong>{delegation.member ?? "Agent"}</strong>
                          {delegation.agentId ? ` · ${delegation.agentId}` : ""}
                          {delegation.task ? ` · ${delegation.task}` : ""}
                          {delegation.status ? ` · ${delegation.status}` : ""}
                          {delegation.target || delegation.threadId
                            ? ` · ${delegation.tool ?? "target"}:${delegation.target ?? delegation.threadId}`
                            : ""}
                          {delegation.error
                            ? ` · ${delegation.error}`
                            : delegation.resultPreview
                              ? ` · ${delegation.resultPreview}`
                              : ""}
                          {delegation.memoryRefs?.length
                            ? ` · ${isZh ? "记忆" : "Memory"} ${delegation.memoryRefs
                                .slice(0, 2)
                                .map(officeRunMemoryRefDetails)
                                .map((details) => details.join(" · "))
                                .join(" | ")}`
                            : ""}
                        </span>
                        {canDispatch ? (
                          <button
                            type="button"
                            disabled={hasPendingAction}
                            onClick={() =>
                              onDelegationDispatch?.(run, delegation)
                            }
                          >
                            {isPendingDelegation
                              ? isZh
                                ? "派发中"
                                : "Dispatching"
                              : isZh
                                ? "派发"
                                : "Dispatch"}
                          </button>
                        ) : null}
                        {canRetryDelegationAction ||
                        (isPendingDelegation &&
                          canRetryDelegation(delegation)) ? (
                          <button
                            type="button"
                            disabled={hasPendingAction}
                            onClick={() => onDelegationRetry?.(run, delegation)}
                          >
                            {isPendingDelegation
                              ? isZh
                                ? "重试中"
                                : "Retrying"
                              : isZh
                                ? "重试"
                                : "Retry"}
                          </button>
                        ) : null}
                        {canCancelDelegationAction ||
                        (isPendingDelegation &&
                          canCancelDelegation(delegation)) ? (
                          <button
                            type="button"
                            disabled={hasPendingAction}
                            onClick={() => onDelegationCancel?.(run, delegation)}
                          >
                            {isPendingDelegation
                              ? isZh
                                ? "取消中"
                                : "Canceling"
                              : isZh
                                ? "取消"
                                : "Cancel"}
                          </button>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              ) : null}
              {run.memoryRefs?.length ? (
                <div className="office-run-memory-refs">
                  {run.memoryRefs.slice(0, 3).map((memory) => (
                    <span key={memory.id}>
                      <strong>{isZh ? "记忆" : "Memory"}</strong>
                      {officeRunMemoryRefDetails(memory).length
                        ? ` · ${officeRunMemoryRefDetails(memory).join(" · ")}`
                        : ""}
                    </span>
                  ))}
                </div>
              ) : null}
              {canCancel ||
              canRetry ||
              retryLimitReached ||
              hasDispatchableDelegation ||
              run.status === "canceling" ||
              isPendingRun ? (
                <div className="office-run-actions">
                  {run.status === "canceling" ||
                  (isPendingRun && pendingRunAction === "cancel") ? (
                    <button type="button" disabled>
                      {isZh ? "取消中" : "Canceling"}
                    </button>
                  ) : null}
                  {isPendingRun && pendingRunAction === "retry" ? (
                    <button type="button" disabled>
                      {officeRunRetryPendingActionLabel(run, locale)}
                    </button>
                  ) : null}
                  {canCancel ? (
                    <button
                      type="button"
                      disabled={hasPendingAction}
                      onClick={() => onRunCancel?.(run)}
                    >
                      {isZh ? "取消" : "Cancel"}
                    </button>
                  ) : null}
                  {canRetry ? (
                    <button
                      type="button"
                      disabled={hasPendingAction}
                      onClick={() => onRunRetry?.(run)}
                    >
                      {officeRunRetryActionLabel(run, locale)}
                    </button>
                  ) : null}
                  {retryLimitReached ? (
                    <button type="button" disabled>
                      {officeRunRetryActionLabel(run, locale)}
                    </button>
                  ) : null}
                  {hasDispatchableDelegation ? (
                    <button
                      type="button"
                      disabled={hasPendingAction}
                      onClick={() => onDelegationDispatchNext?.(run)}
                    >
                      {isZh ? "派发下一个" : "Dispatch next"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
