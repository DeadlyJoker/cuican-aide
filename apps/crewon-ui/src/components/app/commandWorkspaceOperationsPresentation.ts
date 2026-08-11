import type { Locale } from "../../lib/i18n";
import type { ControlWorkspaceState } from "../../lib/control-runtime/controlWorkspaceRuntime";
import { classNames } from "./commandWorkspaceUtils";
import type { CommandWorkspaceOperationsPanelProps } from "./CommandWorkspaceOperationsPanel";
import { workspaceCopy } from "./commandWorkspaceOperationsCopy";

export function workspaceAuthorityNotice(
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

export function workspaceSelectionLabel(
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

export function safeNativeWorkspaceDisplayName(value: unknown): string | null {
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

export function workspaceEmptyLabel(
  status: ControlWorkspaceState["status"],
  locale: Locale,
): string {
  if (status === "loading") return workspaceCopy(locale, "emptyLoading");
  if (status === "unavailable") {
    return workspaceCopy(locale, "emptyUnavailable");
  }
  return workspaceCopy(locale, "empty");
}

export function workspaceLiveNotice(
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

export function workspaceStateLabel(
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

export function workspaceStateClassName(
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
