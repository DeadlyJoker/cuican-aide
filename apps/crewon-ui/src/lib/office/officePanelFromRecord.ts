import type {
  LibraryItemAction,
  LibraryPanel,
  OfficeConfig,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { buildOfficeDetailPanel } from "./officeDetailPanel";

export type OfficeConfigRecordReference = {
  config: OfficeConfig;
  filePath: string;
  savedAt?: string | null;
  workspaceCwd?: string;
};

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
  record: OfficeConfigRecordReference,
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
  record: OfficeConfigRecordReference,
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
