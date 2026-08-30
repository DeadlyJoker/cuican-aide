import type {
  LibraryItemAction,
  LibraryPanel,
  OfficeConfig,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { buildOfficeDetailPanel } from "./officeDetailPanel";

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
      executionTargets: ReadonlyArray<{
        agentVersionId: string;
        targetId: string;
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

export function officeMemberDisplayName(
  displayName: string,
  index: number,
  locale: Locale = "zh",
): string {
  const name = displayName.trim();
  const looksGenerated =
    name.length > 36 ||
    name.includes(":") ||
    /^(?:agent|local-dev|member|runtime|target|workspace)[-_]/iu.test(name);
  if (name && !looksGenerated) {
    return name;
  }
  if (index === 0) {
    return locale === "zh" ? "办公室组长" : "Office lead";
  }
  return locale === "zh" ? `成员 ${index + 1}` : `Member ${index + 1}`;
}

type OfficeDetailAction = Extract<LibraryItemAction, { type: "office-detail" }>;

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

export function officePanelFromRecord(
  record: OfficeRuntimeRecordReference,
  locale: Locale,
): LibraryPanel {
  const action: OfficeDetailAction = {
    type: "office-detail",
    title: record.config.title,
    subtitle: record.config.subtitle,
    body: record.config.workspace.goal,
    items: [],
    workspace: record.config.workspace,
    configPath: normalizedIdentityValue(record.filePath) ?? undefined,
    workspaceCwd: normalizedIdentityValue(record.workspaceCwd) ?? undefined,
  };
  return buildOfficeDetailPanel(action, record.config, locale);
}

export function officePanelMatchesRecord(
  panel: LibraryPanel | null,
  record: OfficeRuntimeRecordReference,
): boolean {
  if (panel?.kind !== "office" || !panel.workspace) {
    return false;
  }
  const workspaceCwd = normalizedIdentityValue(record.workspaceCwd);
  if (
    workspaceCwd &&
    normalizedIdentityValue(panel.workspaceCwd) !== workspaceCwd
  ) {
    return false;
  }
  const recordId = normalizedIdentityValue(record.config.workspace.recordId);
  if (recordId) {
    return normalizedIdentityValue(panel.workspace.recordId) === recordId;
  }
  const filePath = normalizedIdentityValue(record.filePath);
  if (filePath) {
    return normalizedIdentityValue(panel.configPath) === filePath;
  }
  const threadId = normalizedIdentityValue(record.config.workspace.threadId);
  return Boolean(
    threadId && normalizedIdentityValue(panel.workspace.threadId) === threadId,
  );
}
