import type { WorkspaceOperationView } from "@crewon/contracts";
import {
  File,
  Folder,
  LoaderCircle,
  Plus,
  RefreshCw,
  Square,
} from "lucide-react";

import type { ControlWorkspaceState } from "../../lib/control-runtime/controlWorkspaceRuntime";
import type { Locale } from "../../lib/i18n";
import { classNames } from "./commandWorkspaceUtils";

const MAX_VISIBLE_ENTRIES = 5;

const WORKSPACE_COPY = {
  zh: {
    panelTitle: "工作空间操作",
    safeEntriesOnly: "仅显示顶层安全条目",
    processing: "处理中…",
    readTopLevel: "读取顶层目录",
    selectWorkspace: "选择工作空间",
    replaceWorkspace: "更换",
    clearWorkspace: "清除",
    nativeWorkspaceLabel: "本机工作空间",
    nativeActiveAuthority:
      "请先结束活动任务或工作空间操作，再更换本机工作空间。",
    nativeConflict: "本机工作空间状态已变化，请检查当前选择后再继续。",
    nativeUnavailable: "本机工作空间 authority 暂不可用。",
    nativeUnknown: "本机工作空间操作结果尚未确认，请勿重复提交。",
    rehydrationFailed:
      "本机工作空间已更新，但 Control 运行态恢复失败；当前操作已安全停用。",
    operationsLabel: "工作空间操作记录",
    entriesLabel: "顶层条目",
    reconcile: "重新确认",
    cancel: "取消",
    directory: "文件夹",
    file: "文件",
    deviceResultTruncated: "设备返回的顶层结果已截断。",
    authorityReadOnly:
      "团队环境当前只读；可以查看结果，但不能发起、重新确认或取消工作空间操作。",
    authorityUnavailable:
      "工作空间 Control 服务暂不可用；不会回退到旧文件接口。",
    authoritySelectThread: "选择一个线程后才能读取工作空间顶层目录。",
    authorityInactiveThread: "当前线程不是活动状态，不能发起新的工作空间操作。",
    authorityNoWorkspace: "当前线程没有已选择的工作空间。",
    selectionNone: "未选择线程",
    selectionWorkspace: "当前线程 · 已选择工作空间",
    selectionNoWorkspace: "当前线程 · 未选择工作空间",
    emptyLoading: "正在读取工作空间操作。",
    emptyUnavailable: "工作空间操作当前不可用。",
    empty: "当前线程还没有工作空间操作。",
    liveAvailable: "工作空间 Control 已可用，等待选择线程。",
    liveUnavailable: "工作空间 Control 不可用。",
    liveLoading: "正在同步工作空间操作。",
    live: "工作空间操作已同步。",
    liveMutating: "正在提交工作空间操作。",
    liveConflict: "工作空间状态已变化，请检查刷新后的操作再继续。",
    liveError: "工作空间操作同步失败。",
    stateAvailable: "可用",
    stateUnavailable: "不可用",
    stateLoading: "载入中",
    stateLive: "实时",
    stateMutating: "处理中",
    stateConflict: "状态冲突",
    stateError: "同步失败",
    operationTitle: "顶层目录读取",
    summaryPending: "设备正在读取已授权工作空间的顶层条目。",
    summaryUnknown: "发送结果尚未确认，可以使用相同操作记录重新确认。",
    summaryFailedRetryable: "操作失败，可以重新发起。",
    summaryFailed: "操作失败，当前结果不可重试。",
    summaryCanceled: "操作已取消，没有继续读取工作空间。",
    statusPending: "执行中",
    statusUnknown: "结果待确认",
    statusCompleted: "已完成",
    statusFailed: "失败",
    statusCanceled: "已取消",
  },
  en: {
    panelTitle: "Workspace operations",
    safeEntriesOnly: "Safe top-level entries only",
    processing: "Working…",
    readTopLevel: "Read top level",
    selectWorkspace: "Select Workspace",
    replaceWorkspace: "Replace",
    clearWorkspace: "Clear",
    nativeWorkspaceLabel: "Native Workspace",
    nativeActiveAuthority:
      "End the active task or Workspace operation before changing the native Workspace.",
    nativeConflict:
      "The native Workspace changed. Review the current selection before continuing.",
    nativeUnavailable: "Native Workspace authority is unavailable.",
    nativeUnknown:
      "The native Workspace outcome is unknown. Do not submit it again.",
    rehydrationFailed:
      "The native Workspace changed, but Control runtime recovery failed. Operations are safely disabled.",
    operationsLabel: "Workspace operation records",
    entriesLabel: "Top-level entries",
    reconcile: "Check again",
    cancel: "Cancel",
    directory: "Folder",
    file: "File",
    deviceResultTruncated: "The Device truncated the top-level result.",
    authorityReadOnly:
      "Team environments are currently read-only. Results remain visible, but Workspace operations cannot be started, checked again, or canceled.",
    authorityUnavailable:
      "Workspace Control is unavailable. CrewON will not fall back to the legacy file API.",
    authoritySelectThread:
      "Select a thread before reading the Workspace top level.",
    authorityInactiveThread:
      "The selected thread is not active, so a new Workspace operation cannot start.",
    authorityNoWorkspace: "The selected thread has no selected Workspace.",
    selectionNone: "No thread selected",
    selectionWorkspace: "Current thread · Workspace selected",
    selectionNoWorkspace: "Current thread · No Workspace selected",
    emptyLoading: "Loading Workspace operations.",
    emptyUnavailable: "Workspace operations are unavailable.",
    empty: "This thread has no Workspace operations yet.",
    liveAvailable: "Workspace Control is available and waiting for a thread.",
    liveUnavailable: "Workspace Control is unavailable.",
    liveLoading: "Syncing Workspace operations.",
    live: "Workspace operations are synchronized.",
    liveMutating: "Submitting a Workspace operation.",
    liveConflict:
      "Workspace state changed. Review the refreshed operation before continuing.",
    liveError: "Workspace operation synchronization failed.",
    stateAvailable: "Available",
    stateUnavailable: "Unavailable",
    stateLoading: "Loading",
    stateLive: "Live",
    stateMutating: "Working",
    stateConflict: "Conflict",
    stateError: "Sync failed",
    operationTitle: "Top-level read",
    summaryPending:
      "The Device is reading safe top-level entries from the authorized Workspace.",
    summaryUnknown:
      "The delivery outcome is not confirmed. Check the same operation record again.",
    summaryFailedRetryable: "The operation failed and can be started again.",
    summaryFailed: "The operation failed and cannot be retried.",
    summaryCanceled: "The operation was canceled without reading further.",
    statusPending: "Running",
    statusUnknown: "Outcome unknown",
    statusCompleted: "Completed",
    statusFailed: "Failed",
    statusCanceled: "Canceled",
  },
} as const;

type WorkspaceCopyKey = keyof (typeof WORKSPACE_COPY)["zh"];

export type WorkspaceMutationAuthority = "desktop" | "readOnly" | "unavailable";

export type CommandWorkspaceOperationsPanelProps = Readonly<{
  locale: Locale;
  state: ControlWorkspaceState;
  nativeWorkspaceSelected: boolean;
  nativeWorkspaceDisplayName?: string | null;
  nativeWorkspaceBusy?: boolean;
  safeError?:
    | "nativeActiveAuthority"
    | "nativeConflict"
    | "nativeUnavailable"
    | "nativeUnknown"
    | "rehydrationFailed"
    | null;
  mutationAuthority: WorkspaceMutationAuthority;
  onCreate: () => void | Promise<void>;
  onReconcile: (executionId: string) => void | Promise<void>;
  onCancel: (executionId: string) => void | Promise<void>;
  onSelectNativeWorkspace?: () => void | Promise<void>;
  onClearNativeWorkspace?: () => void | Promise<void>;
}>;

export function CommandWorkspaceOperationsPanel(
  props: CommandWorkspaceOperationsPanelProps,
) {
  const busy =
    props.state.status === "mutating" || props.nativeWorkspaceBusy === true;
  const nativeWorkspaceDisplayName = safeNativeWorkspaceDisplayName(
    props.nativeWorkspaceDisplayName,
  );
  const operationMutationEnabled =
    props.state.status === "live" || props.state.status === "conflict";
  const canCreate =
    props.mutationAuthority === "desktop" &&
    props.state.status === "live" &&
    props.state.threadId !== null &&
    props.state.threadStatus === "active" &&
    props.nativeWorkspaceSelected &&
    !busy;
  const authorityNotice = workspaceAuthorityNotice(props);
  const liveNotice = workspaceLiveNotice(props.state, props.locale);

  return (
    <section
      className="page-panel workspace-operations-panel"
      aria-labelledby="workspace-operations-title"
      data-workspace-operations="control"
      data-mutation-authority={props.mutationAuthority}
      data-locale={props.locale}
    >
      <header className="panel-head">
        <div>
          <h3 id="workspace-operations-title">
            {workspaceCopy(props.locale, "panelTitle")}
          </h3>
          <p>{workspaceSelectionLabel(props)}</p>
        </div>
        <span className={workspaceStateClassName(props.state.status)}>
          {workspaceStateLabel(props.state.status, props.locale)}
        </span>
      </header>

      {props.mutationAuthority === "desktop" &&
      props.onSelectNativeWorkspace !== undefined ? (
        <div
          className="capability-row workspace-native-selector"
          data-native-workspace-selector="available"
        >
          <div>
            <span className="catalog-context-note">
              {workspaceCopy(props.locale, "nativeWorkspaceLabel")}
            </span>
            <strong>
              {nativeWorkspaceDisplayName ??
                workspaceCopy(props.locale, "selectionNoWorkspace")}
            </strong>
          </div>
          <div className="catalog-header-actions">
            <button
              className="button compact"
              type="button"
              data-workspace-action="select-native"
              disabled={busy}
              onClick={
                busy
                  ? undefined
                  : () =>
                      invokeMutation(() => props.onSelectNativeWorkspace?.())
              }
            >
              {workspaceCopy(
                props.locale,
                nativeWorkspaceDisplayName === null
                  ? "selectWorkspace"
                  : "replaceWorkspace",
              )}
            </button>
            {nativeWorkspaceDisplayName !== null &&
            props.onClearNativeWorkspace !== undefined ? (
              <button
                className="button compact"
                type="button"
                data-workspace-action="clear-native"
                disabled={busy}
                onClick={
                  busy
                    ? undefined
                    : () =>
                        invokeMutation(() => props.onClearNativeWorkspace?.())
                }
              >
                {workspaceCopy(props.locale, "clearWorkspace")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="slim-controls">
        <span className="catalog-context-note">
          {workspaceCopy(props.locale, "safeEntriesOnly")}
        </span>
        <button
          className="button compact primary"
          type="button"
          data-workspace-action="create"
          disabled={!canCreate}
          onClick={
            canCreate ? () => invokeMutation(() => props.onCreate()) : undefined
          }
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" />
          ) : (
            <Plus aria-hidden="true" />
          )}
          {workspaceCopy(props.locale, busy ? "processing" : "readTopLevel")}
        </button>
      </div>

      {authorityNotice ? (
        <div
          className="filter-empty-state"
          data-workspace-authority-notice={props.mutationAuthority}
          role="status"
        >
          {authorityNotice}
        </div>
      ) : null}

      {props.safeError ? (
        <div
          className="filter-empty-state"
          data-workspace-safe-error={props.safeError}
          role="alert"
        >
          {workspaceCopy(props.locale, props.safeError)}
        </div>
      ) : null}

      {props.state.operations.length === 0 ? (
        <div className="filter-empty-state" data-workspace-empty="true">
          {workspaceEmptyLabel(props.state.status, props.locale)}
        </div>
      ) : (
        <div
          className="compact-list"
          role="list"
          aria-label={workspaceCopy(props.locale, "operationsLabel")}
        >
          {props.state.operations.map((operation) => (
            <WorkspaceOperationCard
              key={operation.executionId}
              operation={operation}
              locale={props.locale}
              authority={props.mutationAuthority}
              busy={busy}
              mutationEnabled={operationMutationEnabled}
              onReconcile={props.onReconcile}
              onCancel={props.onCancel}
            />
          ))}
        </div>
      )}

      <div
        className="sr-log"
        role={
          props.state.status === "error" || props.state.status === "conflict"
            ? "alert"
            : "status"
        }
        aria-live="polite"
        data-workspace-live-state={props.state.status}
      >
        {liveNotice}
      </div>
    </section>
  );
}

function WorkspaceOperationCard({
  operation,
  locale,
  authority,
  busy,
  mutationEnabled,
  onReconcile,
  onCancel,
}: {
  operation: WorkspaceOperationView;
  locale: Locale;
  authority: WorkspaceMutationAuthority;
  busy: boolean;
  mutationEnabled: boolean;
  onReconcile: (executionId: string) => void | Promise<void>;
  onCancel: (executionId: string) => void | Promise<void>;
}) {
  const desktop = authority === "desktop";
  const canReconcile =
    desktop &&
    mutationEnabled &&
    operation.status === "unknownOutcome" &&
    !busy;
  const canCancel =
    desktop &&
    mutationEnabled &&
    (operation.status === "pending" || operation.status === "unknownOutcome") &&
    !busy;

  return (
    <article
      className={classNames(
        "capability-row",
        operation.status === "pending" && "is-priority",
      )}
      role="listitem"
      data-workspace-operation={operation.status}
    >
      <div>
        <strong>{workspaceOperationTitle(operation, locale)}</strong>
        <p>{workspaceOperationSummary(operation, locale)}</p>
        {operation.status === "completed" ? (
          <WorkspaceEntries locale={locale} operation={operation} />
        ) : null}
      </div>
      <div className="catalog-header-actions">
        <span className={workspaceOperationStatusClassName(operation.status)}>
          {workspaceOperationStatusLabel(operation.status, locale)}
        </span>
        {operation.status === "unknownOutcome" ? (
          <button
            className="button compact"
            type="button"
            data-workspace-action="reconcile"
            data-execution-id={operation.executionId}
            disabled={!canReconcile}
            onClick={
              canReconcile
                ? () => invokeMutation(() => onReconcile(operation.executionId))
                : undefined
            }
          >
            <RefreshCw aria-hidden="true" />
            {workspaceCopy(locale, "reconcile")}
          </button>
        ) : null}
        {operation.status === "pending" ||
        operation.status === "unknownOutcome" ? (
          <button
            className="button compact"
            type="button"
            data-workspace-action="cancel"
            data-execution-id={operation.executionId}
            disabled={!canCancel}
            onClick={
              canCancel
                ? () => invokeMutation(() => onCancel(operation.executionId))
                : undefined
            }
          >
            <Square aria-hidden="true" />
            {workspaceCopy(locale, "cancel")}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function WorkspaceEntries({
  locale,
  operation,
}: {
  locale: Locale;
  operation: Extract<WorkspaceOperationView, { status: "completed" }>;
}) {
  const visible = operation.result.entries.slice(0, MAX_VISIBLE_ENTRIES);
  const hiddenCount = Math.max(
    operation.result.entries.length - visible.length,
    0,
  );
  const truncated = operation.result.truncated || hiddenCount > 0;

  return (
    <div
      className="compact-list"
      role="list"
      aria-label={workspaceCopy(locale, "entriesLabel")}
    >
      {visible.map((entry) => (
        <div className="run-row" role="listitem" key={entry.name}>
          {entry.kind === "directory" ? (
            <Folder aria-hidden="true" />
          ) : (
            <File aria-hidden="true" />
          )}
          <strong>{entry.name}</strong>
          <span className="status">
            {workspaceCopy(
              locale,
              entry.kind === "directory" ? "directory" : "file",
            )}
          </span>
        </div>
      ))}
      {truncated ? (
        <p data-workspace-result-truncated="true">
          {hiddenCount > 0
            ? workspaceHiddenEntries(locale, hiddenCount)
            : workspaceCopy(locale, "deviceResultTruncated")}
        </p>
      ) : null}
    </div>
  );
}

function workspaceAuthorityNotice(
  props: CommandWorkspaceOperationsPanelProps,
): string | null {
  if (props.mutationAuthority === "readOnly") {
    return workspaceCopy(props.locale, "authorityReadOnly");
  }
  if (props.mutationAuthority === "unavailable") {
    return workspaceCopy(props.locale, "authorityUnavailable");
  }
  if (props.state.threadId === null) {
    return workspaceCopy(props.locale, "authoritySelectThread");
  }
  if (
    props.state.threadStatus === "archived" ||
    props.state.threadStatus === "deleted"
  ) {
    return workspaceCopy(props.locale, "authorityInactiveThread");
  }
  if (!props.nativeWorkspaceSelected) {
    return workspaceCopy(props.locale, "authorityNoWorkspace");
  }
  return null;
}

function workspaceSelectionLabel(
  props: CommandWorkspaceOperationsPanelProps,
): string {
  if (props.state.threadId === null) {
    return workspaceCopy(props.locale, "selectionNone");
  }
  if (!props.nativeWorkspaceSelected) {
    return workspaceCopy(props.locale, "selectionNoWorkspace");
  }
  const displayName = safeNativeWorkspaceDisplayName(
    props.nativeWorkspaceDisplayName,
  );
  return displayName ?? workspaceCopy(props.locale, "selectionWorkspace");
}

function safeNativeWorkspaceDisplayName(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 255 ||
    value.trim() !== value ||
    value.includes("/") ||
    value.includes("\\") ||
    /^(?:file|https?):/iu.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function workspaceEmptyLabel(
  status: ControlWorkspaceState["status"],
  locale: Locale,
): string {
  if (status === "loading") return workspaceCopy(locale, "emptyLoading");
  if (status === "unavailable") {
    return workspaceCopy(locale, "emptyUnavailable");
  }
  return workspaceCopy(locale, "empty");
}

function workspaceLiveNotice(
  state: ControlWorkspaceState,
  locale: Locale,
): string {
  switch (state.status) {
    case "available":
      return workspaceCopy(locale, "liveAvailable");
    case "unavailable":
      return workspaceCopy(locale, "liveUnavailable");
    case "loading":
      return workspaceCopy(locale, "liveLoading");
    case "live":
      return workspaceCopy(locale, "live");
    case "mutating":
      return workspaceCopy(locale, "liveMutating");
    case "conflict":
      return workspaceCopy(locale, "liveConflict");
    case "error":
      return workspaceCopy(locale, "liveError");
  }
}

function workspaceStateLabel(
  status: ControlWorkspaceState["status"],
  locale: Locale,
): string {
  switch (status) {
    case "available":
      return workspaceCopy(locale, "stateAvailable");
    case "unavailable":
      return workspaceCopy(locale, "stateUnavailable");
    case "loading":
      return workspaceCopy(locale, "stateLoading");
    case "live":
      return workspaceCopy(locale, "stateLive");
    case "mutating":
      return workspaceCopy(locale, "stateMutating");
    case "conflict":
      return workspaceCopy(locale, "stateConflict");
    case "error":
      return workspaceCopy(locale, "stateError");
  }
}

function workspaceStateClassName(
  status: ControlWorkspaceState["status"],
): string {
  return classNames(
    "status",
    status === "live" && "success",
    (status === "loading" || status === "mutating" || status === "conflict") &&
      "warn",
    (status === "unavailable" || status === "error") && "danger",
  );
}

function workspaceOperationTitle(
  operation: WorkspaceOperationView,
  locale: Locale,
): string {
  return `${workspaceCopy(locale, "operationTitle")} · ${operation.executionId}`;
}

function workspaceOperationSummary(
  operation: WorkspaceOperationView,
  locale: Locale,
): string {
  switch (operation.status) {
    case "pending":
      return workspaceCopy(locale, "summaryPending");
    case "unknownOutcome":
      return workspaceCopy(locale, "summaryUnknown");
    case "completed":
      return workspaceCompletedEntries(locale, operation.result.entries.length);
    case "failed":
      return operation.result.retryable
        ? workspaceCopy(locale, "summaryFailedRetryable")
        : workspaceCopy(locale, "summaryFailed");
    case "canceled":
      return workspaceCopy(locale, "summaryCanceled");
  }
}

function workspaceOperationStatusLabel(
  status: WorkspaceOperationView["status"],
  locale: Locale,
): string {
  switch (status) {
    case "pending":
      return workspaceCopy(locale, "statusPending");
    case "unknownOutcome":
      return workspaceCopy(locale, "statusUnknown");
    case "completed":
      return workspaceCopy(locale, "statusCompleted");
    case "failed":
      return workspaceCopy(locale, "statusFailed");
    case "canceled":
      return workspaceCopy(locale, "statusCanceled");
  }
}

function workspaceOperationStatusClassName(
  status: WorkspaceOperationView["status"],
): string {
  return classNames(
    "status",
    status === "completed" && "success",
    (status === "pending" || status === "unknownOutcome") && "warn",
    status === "failed" && "danger",
  );
}

function workspaceCopy(locale: Locale, key: WorkspaceCopyKey): string {
  return WORKSPACE_COPY[locale][key];
}

function workspaceCompletedEntries(locale: Locale, count: number): string {
  return locale === "zh"
    ? `已返回 ${count} 个安全顶层条目。`
    : `Returned ${count} safe top-level ${count === 1 ? "entry" : "entries"}.`;
}

function workspaceHiddenEntries(locale: Locale, count: number): string {
  return locale === "zh"
    ? `另有 ${count} 项未在紧凑视图中展开；结果列表已截断。`
    : `${count} more ${count === 1 ? "entry is" : "entries are"} collapsed in this compact view; the result list is truncated.`;
}

function invokeMutation(action: () => void | Promise<void>): void {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // The Control runtime owns the redacted error state rendered by this panel.
  }
}
