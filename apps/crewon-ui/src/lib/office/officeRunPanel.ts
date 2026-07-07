import type { OfficeRunResponse } from "../app-server/appServer";
import type { NoticeState } from "../shared/noticeState";
import type {
  LibraryPanel,
  OfficeConfig,
  OfficeRunActivity,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { officeWorkspaceConnectedPatch } from "./officeDetailPanel";

type OfficeRunStatus = OfficeRunActivity["status"];

export type OfficeRunTurnRecord = {
  cwd: string;
  runId: string;
  threadId: string;
  turnThreadId?: string;
  config: OfficeConfig;
};

export function officeRunRetryText(
  run: OfficeRunActivity,
  locale: Locale = "en",
): string {
  const baseText = (run.requestText ?? run.promptPreview ?? run.title).trim();
  if (!baseText || !officeRunNeedsLoopContinuation(run)) {
    return baseText;
  }
  const isZh = locale === "zh";
  const review = run.loop?.review;
  const runVerificationChecks = review?.nextAction === "runVerificationChecks";
  const introLine = runVerificationChecks
    ? isZh
      ? "继续上一轮 Office Loop，优先运行待验证检查。"
      : "Continue the previous Office Loop by running the pending verification checks."
    : isZh
      ? "继续上一轮 Office Loop，按 review 结果修复或补验证。"
      : "Continue the previous Office Loop using the review result.";
  const instructionLine = runVerificationChecks
    ? isZh
      ? "要求：优先执行 verificationChecks 中列出的安全命令或自动化引用；需要审批时走正常审批路径；没有真实工具证据时不要把检查标为 passed。执行后 observe/verify，并在最终回复追加新的 officeUpdate.verificationChecks 和 evidence。"
      : "Instructions: prioritize executing the safe commands or automation references listed in verificationChecks; use the normal approval path when approval is required; do not mark checks passed without real tool evidence. After execution, observe/verify and append fresh officeUpdate.verificationChecks and evidence in the final response."
    : isZh
      ? "要求：不要重复已通过工作；重新 frame 验收差距，plan 修复路径，必要时 delegate，执行后 observe/verify，并在最终回复追加新的 officeUpdate。"
      : "Instructions: do not repeat already-passed work; re-frame the acceptance gaps, plan the repair path, delegate when useful, act, observe/verify, and append a fresh officeUpdate in the final response.";
  const lines = [
    introLine,
    isZh ? `原始请求：${baseText}` : `Original request: ${baseText}`,
    isZh
      ? `Review 状态：${review?.status ?? "incomplete"}`
      : `Review status: ${review?.status ?? "incomplete"}`,
    review?.nextAction
      ? isZh
        ? `下一步：${review.nextAction}`
        : `Next action: ${review.nextAction}`
      : null,
    retrySection(
      isZh ? "未通过或待复核的验收" : "Failed or pending acceptance",
      run.acceptanceCriteria
        ?.filter((item) => item.status !== "passed")
        .slice(0, 5)
        .map((item) =>
          retryLine(item.criterion, [item.status, item.evidence, item.source]),
        ) ?? [],
    ),
    retrySection(
      isZh ? "阻塞或待验证的证据" : "Blocked or unverified evidence",
      run.evidence
        ?.filter((item) => item.status !== "verified")
        .slice(0, 5)
        .map((item) => retryLine(item.summary, [item.status, item.source])) ??
        [],
    ),
    retrySection(
      isZh ? "失败或待运行的验证检查" : "Failed or pending verification checks",
      run.verificationChecks
        ?.filter((item) => item.status !== "passed")
        .slice(0, 5)
        .map((item) =>
          retryLine(item.check, [
            item.status,
            item.command,
            item.automationId,
            item.evidence,
            item.source,
          ]),
        ) ?? [],
    ),
    retrySection(
      isZh ? "开放高风险" : "Open high risks",
      run.risks
        ?.filter((item) => item.severity === "high" && !item.mitigation?.trim())
        .slice(0, 5)
        .map((item) =>
          retryLine(item.summary, [item.mitigation, item.owner]),
        ) ?? [],
    ),
    instructionLine,
  ].filter(Boolean);
  return lines.join("\n").trim();
}

export function officeRunRetryActionLabel(
  run: OfficeRunActivity,
  locale: Locale,
): string {
  if (officeRunRetryLimitReached(run)) {
    return locale === "zh" ? "达到上限" : "Limit reached";
  }
  if (!officeRunNeedsLoopContinuation(run)) {
    return locale === "zh" ? "重试" : "Retry";
  }
  if (run.loop?.review?.nextAction === "runVerificationChecks") {
    return locale === "zh" ? "运行检查" : "Run checks";
  }
  return run.loop?.review?.status === "blocked"
    ? locale === "zh"
      ? "修复"
      : "Repair"
    : locale === "zh"
      ? "继续循环"
      : "Continue loop";
}

export function officeRunRetryPendingActionLabel(
  run: OfficeRunActivity,
  locale: Locale,
): string {
  if (run.loop?.review?.nextAction === "runVerificationChecks") {
    return locale === "zh" ? "运行检查中" : "Running checks";
  }
  const actionLabel = officeRunRetryActionLabel(run, locale);
  if (actionLabel === (locale === "zh" ? "修复" : "Repair")) {
    return locale === "zh" ? "修复中" : "Repairing";
  }
  if (actionLabel === (locale === "zh" ? "继续循环" : "Continue loop")) {
    return locale === "zh" ? "继续循环中" : "Continuing loop";
  }
  return locale === "zh" ? "重试中" : "Retrying";
}

export function officeRunRetryLimitReached(run: OfficeRunActivity): boolean {
  if (run.loop?.status === "iterationLimit") {
    return true;
  }
  const iteration = run.loop?.iteration ?? run.loop?.metrics?.iteration;
  const maxIterations =
    run.loop?.maxIterations ?? run.loop?.metrics?.maxIterations;
  return Boolean(
    officeRunNeedsLoopContinuation(run) &&
      typeof iteration === "number" &&
      typeof maxIterations === "number" &&
      iteration >= maxIterations,
  );
}

export function officeRunRetryLimitNotice(locale: Locale): NoticeState {
  return {
    text:
      locale === "zh"
        ? "已达到 Office Loop 迭代上限，请调整目标或创建新的团队执行"
        : "Office Loop iteration limit reached. Adjust the goal or start a new team run.",
    tone: "warning",
  };
}

function officeRunNeedsLoopContinuation(run: OfficeRunActivity): boolean {
  const status = run.loop?.review?.status;
  return Boolean(status && status !== "passed");
}

function retrySection(heading: string, lines: string[]): string | null {
  if (lines.length === 0) {
    return null;
  }
  return `${heading}:\n${lines.join("\n")}`;
}

function retryLine(
  summary: string,
  details: Array<string | undefined>,
): string {
  const compactDetails = details.filter((detail) => detail?.trim()).join("; ");
  return compactDetails ? `- ${summary} (${compactDetails})` : `- ${summary}`;
}

export function officeRunCancelUnavailableNotice(locale: Locale): string {
  return locale === "zh"
    ? "只能取消正在运行的后端办公室任务"
    : "Only active backend office runs can be canceled";
}

export function officeRunCancelUnavailableNoticeState(
  locale: Locale,
): NoticeState {
  return {
    text: officeRunCancelUnavailableNotice(locale),
    tone: "warning",
  };
}

export function officeRunCancelUnsupportedNotice(locale: Locale): string {
  return locale === "zh"
    ? "当前后端不支持 office/run/cancel"
    : "The backend does not support office/run/cancel";
}

export function officeRunCancelUnsupportedNoticeState(
  locale: Locale,
): NoticeState {
  return {
    text: officeRunCancelUnsupportedNotice(locale),
    tone: "warning",
  };
}

export function officeRunCancelFallbackError(locale: Locale): string {
  return locale === "zh" ? "取消办公室任务失败" : "Unable to cancel office run";
}

export function officeRunCancelFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error
        ? error.message
        : officeRunCancelFallbackError(locale),
    tone: "warning",
  };
}

export function officeChildCancelUnavailableNotice(locale: Locale): string {
  return locale === "zh"
    ? "只能取消正在运行的成员任务或验证任务"
    : "Only active member or verification tasks can be canceled";
}

export function officeChildCancelUnavailableNoticeState(
  locale: Locale,
): NoticeState {
  return {
    text: officeChildCancelUnavailableNotice(locale),
    tone: "warning",
  };
}

export function officeChildCancelFallbackError(locale: Locale): string {
  return locale === "zh"
    ? "取消子任务失败"
    : "Unable to cancel office child task";
}

export function officeChildCancelFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error
        ? error.message
        : officeChildCancelFallbackError(locale),
    tone: "warning",
  };
}

export function officeRunRetryFallbackError(locale: Locale): string {
  return locale === "zh" ? "重试办公室任务失败" : "Unable to retry office run";
}

export function officeRunRetryFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error
        ? error.message
        : officeRunRetryFallbackError(locale),
    tone: "warning",
  };
}

export function officeDelegationDispatchUnavailableNotice(
  locale: Locale,
): string {
  return locale === "zh"
    ? "只能派发已配置的后端成员任务"
    : "Only configured backend delegations can be dispatched";
}

export function officeDelegationDispatchUnavailableNoticeState(
  locale: Locale,
): NoticeState {
  return {
    text: officeDelegationDispatchUnavailableNotice(locale),
    tone: "warning",
  };
}

export function officeDelegationDispatchFallbackError(locale: Locale): string {
  return locale === "zh"
    ? "派发成员任务失败"
    : "Unable to dispatch office delegation";
}

export function officeDelegationDispatchFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error
        ? error.message
        : officeDelegationDispatchFallbackError(locale),
    tone: "warning",
  };
}

export function officeDelegationRetryUnavailableNoticeState(
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? "只能重试已失败或已中断的后端成员任务"
        : "Only failed or interrupted backend delegations can be retried",
    tone: "warning",
  };
}

export function officeDelegationRetryFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "重试成员任务失败"
          : "Unable to retry office delegation",
    tone: "warning",
  };
}

export function officeVerificationRetryUnavailableNoticeState(
  locale: Locale,
): NoticeState {
  return {
    text:
      locale === "zh"
        ? "只能重试已失败或已中断的自动化验证检查"
        : "Only failed or interrupted automation verification checks can be retried",
    tone: "warning",
  };
}

export function officeVerificationRetryFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "重试自动化验证失败"
          : "Unable to retry automation verification",
    tone: "warning",
  };
}

export function officeRunTurnRecord(
  cwd: string,
  response: OfficeRunResponse,
): OfficeRunTurnRecord {
  const officeThreadId = officeThreadIdForRunResponse(response);
  return {
    cwd,
    runId: response.runId,
    threadId: officeThreadId,
    turnThreadId: response.threadId,
    config: response.config,
  };
}

export function officeRunActiveTurnByThread(
  current: Record<string, string>,
  response: OfficeRunResponse,
): Record<string, string> {
  if (response.turn.status !== "inProgress") {
    return current;
  }
  return {
    ...current,
    [response.threadId]: response.turn.id,
  };
}

export function officeWorkspaceFromRunResponse(
  response: OfficeRunResponse,
): OfficeWorkspace {
  return {
    ...response.config.workspace,
    threadId: officeThreadIdForRunResponse(response),
    backendStatus: "connected",
  };
}

function officeThreadIdForRunResponse(response: OfficeRunResponse): string {
  return isDelegationTurnResponse(response)
    ? (response.config.workspace.threadId ?? response.threadId)
    : response.threadId;
}

function isDelegationTurnResponse(response: OfficeRunResponse): boolean {
  return (
    response.config.workspace.activity?.runs?.some((run) =>
      run.delegations?.some((delegation) => {
        const matchesTurn = delegation.turnId === response.turn.id;
        const matchesThread =
          delegation.threadId === response.threadId ||
          delegation.target === response.threadId;
        return matchesTurn && matchesThread;
      }),
    ) ?? false
  );
}

export function officeRunResponsePanel(
  panel: LibraryPanel | null,
  response: OfficeRunResponse,
): LibraryPanel | null {
  return panel?.kind === "office" && panel.workspace
    ? {
        ...panel,
        configPath: response.filePath,
        workspace: officeWorkspaceFromRunResponse(response),
      }
    : panel;
}

export function officeRunSyncedPanel(
  panel: LibraryPanel | null,
  params: {
    config: OfficeConfig;
    threadId: string;
  },
): LibraryPanel | null {
  return panel?.kind === "office" &&
    panel.workspace?.threadId === params.threadId
    ? {
        ...panel,
        ...officeWorkspaceConnectedPatch(
          params.config.workspace,
          params.threadId,
        ),
      }
    : panel;
}

export function officeRunCancelingPanel(
  panel: LibraryPanel | null,
  params: {
    cancelRequestedAt: string;
    runId: string;
  },
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        workspace: officeWorkspaceWithCancelingRun({
          workspace: panel.workspace,
          runId: params.runId,
          cancelRequestedAt: params.cancelRequestedAt,
        }),
      }
    : panel;
}

export function officeRunCanceledPanel(
  panel: LibraryPanel | null,
  params: {
    config: OfficeConfig;
    threadId: string;
  },
): LibraryPanel | null {
  return panel?.kind === "office" && panel.workspace
    ? {
        ...panel,
        ...officeWorkspaceConnectedPatch(
          params.config.workspace,
          params.threadId,
        ),
      }
    : panel;
}

export function officeRunCancelRollbackPanel(
  panel: LibraryPanel | null,
  params: {
    previousStatus: OfficeRunStatus;
    runId: string;
  },
): LibraryPanel | null {
  return panel?.workspace
    ? {
        ...panel,
        workspace: officeWorkspaceWithRunStatus({
          workspace: panel.workspace,
          runId: params.runId,
          status: params.previousStatus,
        }),
      }
    : panel;
}

export function officeWorkspaceWithCancelingRun(params: {
  cancelRequestedAt: string;
  runId: string;
  workspace: OfficeWorkspace;
}): OfficeWorkspace {
  const { cancelRequestedAt, runId, workspace } = params;
  return officeWorkspaceWithRunPatch(workspace, runId, (run) => ({
    ...run,
    status: "canceling",
    cancelRequestedAt: run.cancelRequestedAt ?? cancelRequestedAt,
  }));
}

export function officeWorkspaceWithRunStatus(params: {
  runId: string;
  status: OfficeRunStatus;
  workspace: OfficeWorkspace;
}): OfficeWorkspace {
  const { runId, status, workspace } = params;
  return officeWorkspaceWithRunPatch(workspace, runId, (run) => ({
    ...run,
    status,
  }));
}

function officeWorkspaceWithRunPatch(
  workspace: OfficeWorkspace,
  runId: string,
  patchRun: (run: OfficeRunActivity) => OfficeRunActivity,
): OfficeWorkspace {
  return {
    ...workspace,
    activity: workspace.activity
      ? {
          ...workspace.activity,
          runs: workspace.activity.runs?.map((run) =>
            run.id === runId ? patchRun(run) : run,
          ),
        }
      : workspace.activity,
  };
}
