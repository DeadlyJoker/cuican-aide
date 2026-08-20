import type { OfficeConfig } from "../domain/crewonDomain";

type OfficeRecordReferenceBase = {
  filePath: string;
  savedAt?: string | null;
  workspaceCwd?: string;
};

export type ControlOfficeDefinitionRecordReference =
  OfficeRecordReferenceBase & {
    authority: "controlDefinition";
    config: Pick<OfficeConfig, "subtitle" | "title">;
    definition: {
      officeVersionId: string;
      revision: number;
      members: ReadonlyArray<{
        agentVersionId: string;
        displayName: string;
        memberId: string;
      }>;
    };
  };

export type OfficeRuntimeRecordReference = OfficeRecordReferenceBase & {
  authority?: "runtime";
  config: OfficeConfig;
};

export type OfficeConfigRecordReference =
  | ControlOfficeDefinitionRecordReference
  | OfficeRuntimeRecordReference;

export function isControlOfficeDefinitionRecord(
  record: OfficeConfigRecordReference,
): record is ControlOfficeDefinitionRecordReference {
  return record.authority === "controlDefinition";
}

function normalizedIdentityValue(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

export function officeRecordKey(
  record: OfficeConfigRecordReference,
): string | null {
  const workspaceCwd = normalizedIdentityValue(record.workspaceCwd);
  const workspacePrefix = workspaceCwd ? `workspace:${workspaceCwd}|` : "";
  if (isControlOfficeDefinitionRecord(record)) {
    return `${workspacePrefix}record:${record.definition.officeVersionId}`;
  }
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
