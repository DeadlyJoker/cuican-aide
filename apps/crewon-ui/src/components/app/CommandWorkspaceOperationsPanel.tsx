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

import { workspaceCopy } from "./commandWorkspaceOperationsCopy";
import {
  workspaceAuthorityNotice,
  workspaceSelectionLabel,
  safeNativeWorkspaceDisplayName,
  workspaceEmptyLabel,
  workspaceLiveNotice,
  workspaceStateLabel,
  workspaceStateClassName,
} from "./commandWorkspaceOperationsPresentation";


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
