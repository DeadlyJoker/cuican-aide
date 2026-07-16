import type { LibraryPanel, OfficeConfig } from "../domain/crewonDomain";

export type OfficeIdentity =
  | { kind: "recordId"; value: string; workspaceCwd?: string }
  | { kind: "configPath"; value: string; workspaceCwd?: string }
  | { kind: "threadId"; value: string; workspaceCwd?: string };

export type OfficeIdentitySnapshot = {
  configPath: string | null;
  recordId: string | null;
  threadId: string | null;
  workspaceCwd: string | null;
};

export function officeIdentityFromPanel(
  panel: LibraryPanel | null,
): OfficeIdentity | null {
  if (panel?.kind !== "office" || !panel.workspace) return null;
  const snapshot = officeIdentitySnapshotFromPanel(panel);
  const workspaceFence = snapshot.workspaceCwd
    ? { workspaceCwd: snapshot.workspaceCwd }
    : {};
  if (snapshot.recordId) {
    return { kind: "recordId", value: snapshot.recordId, ...workspaceFence };
  }
  if (snapshot.configPath) {
    return { kind: "configPath", value: snapshot.configPath, ...workspaceFence };
  }
  return snapshot.threadId
    ? { kind: "threadId", value: snapshot.threadId, ...workspaceFence }
    : null;
}

export function officeIdentitySnapshotFromPanel(
  panel: LibraryPanel | null,
): OfficeIdentitySnapshot {
  return {
    configPath: normalizedIdentityValue(panel?.configPath),
    recordId: normalizedIdentityValue(panel?.workspace?.recordId),
    threadId: normalizedIdentityValue(panel?.workspace?.threadId),
    workspaceCwd: normalizedIdentityValue(panel?.workspaceCwd),
  };
}

export function officeIdentitySnapshotsMatch(
  left: OfficeIdentitySnapshot,
  right: OfficeIdentitySnapshot,
): boolean {
  if (left.workspaceCwd || right.workspaceCwd) {
    if (
      !left.workspaceCwd ||
      !right.workspaceCwd ||
      left.workspaceCwd !== right.workspaceCwd
    ) {
      return false;
    }
  }
  if (left.recordId || right.recordId) {
    return Boolean(left.recordId && right.recordId && left.recordId === right.recordId);
  }
  if (left.configPath || right.configPath) {
    return Boolean(
      left.configPath && right.configPath && left.configPath === right.configPath,
    );
  }
  if (left.threadId || right.threadId) {
    return Boolean(left.threadId && right.threadId && left.threadId === right.threadId);
  }
  return false;
}

export function officePanelMatchesIdentity(
  panel: LibraryPanel | null,
  identity: OfficeIdentity,
): boolean {
  if (panel?.kind !== "office" || !panel.workspace) return false;
  if (
    identity.workspaceCwd &&
    normalizedIdentityValue(panel.workspaceCwd) !== identity.workspaceCwd
  ) {
    return false;
  }
  switch (identity.kind) {
    case "recordId":
      return normalizedIdentityValue(panel.workspace.recordId) === identity.value;
    case "configPath":
      return normalizedIdentityValue(panel.configPath) === identity.value;
    case "threadId":
      return normalizedIdentityValue(panel.workspace.threadId) === identity.value;
  }
}

export function officeResponseMatchesIdentity(
  config: OfficeConfig,
  filePath: string,
  identity: OfficeIdentity,
  deliveryThreadId: string | null,
  responseWorkspaceCwd?: string | null,
): boolean {
  if (
    identity.workspaceCwd &&
    normalizedIdentityValue(responseWorkspaceCwd) !== identity.workspaceCwd
  ) {
    return false;
  }
  switch (identity.kind) {
    case "recordId":
      return normalizedIdentityValue(config.workspace.recordId) === identity.value;
    case "configPath":
      return normalizedIdentityValue(filePath) === identity.value;
    case "threadId":
      return (
        normalizedIdentityValue(config.workspace.threadId) ??
        normalizedIdentityValue(deliveryThreadId)
      ) === identity.value;
  }
}

function normalizedIdentityValue(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
