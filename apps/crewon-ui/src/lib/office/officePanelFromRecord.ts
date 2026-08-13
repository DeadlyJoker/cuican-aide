import type { OfficeConfig } from "../domain/crewonDomain";

export type OfficeConfigRecordReference = {
  config: OfficeConfig;
  filePath: string;
  savedAt?: string | null;
  workspaceCwd?: string;
};

function normalizedIdentityValue(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

export function officeRecordKey(
  record: OfficeConfigRecordReference,
): string | null {
  const workspaceCwd = normalizedIdentityValue(record.workspaceCwd);
  const workspacePrefix = workspaceCwd ? `workspace:${workspaceCwd}|` : "";
  const recordId = normalizedIdentityValue(record.config.workspace.recordId);
  if (recordId) {
    return `${workspacePrefix}record:${recordId}`;
  }
  const filePath = normalizedIdentityValue(record.filePath);
  if (filePath) {
    return `${workspacePrefix}path:${filePath}`;
  }
  const threadId = normalizedIdentityValue(record.config.workspace.threadId);
  return threadId ? `${workspacePrefix}thread:${threadId}` : null;
}
