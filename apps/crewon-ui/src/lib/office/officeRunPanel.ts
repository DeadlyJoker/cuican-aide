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
  config: OfficeConfig;
};

export function officeRunRetryText(run: OfficeRunActivity): string {
  return (run.requestText ?? run.promptPreview ?? run.title).trim();
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
  return locale === "zh"
    ? "取消办公室任务失败"
    : "Unable to cancel office run";
}

export function officeRunCancelFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error ? error.message : officeRunCancelFallbackError(locale),
    tone: "warning",
  };
}

export function officeRunRetryFallbackError(locale: Locale): string {
  return locale === "zh"
    ? "重试办公室任务失败"
    : "Unable to retry office run";
}

export function officeRunRetryFailureNotice(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error ? error.message : officeRunRetryFallbackError(locale),
    tone: "warning",
  };
}

export function officeRunTurnRecord(
  cwd: string,
  response: OfficeRunResponse,
): OfficeRunTurnRecord {
  return {
    cwd,
    runId: response.runId,
    threadId: response.threadId,
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
    threadId: response.threadId,
    backendStatus: "connected",
  };
}

export function officeRunResponsePanel(
  panel: LibraryPanel | null,
  response: OfficeRunResponse,
): LibraryPanel | null {
  return panel?.kind === "office" && panel.workspace
    ? {
        ...panel,
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
  return panel?.kind === "office" && panel.workspace?.threadId === params.threadId
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
        ...officeWorkspaceConnectedPatch(params.config.workspace, params.threadId),
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
