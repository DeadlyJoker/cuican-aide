import { AppServerRpcError, type AppServerClient } from "./appServer";
import {
  officeConfigForThread,
  type ArtifactItem,
  type LibraryPanel,
  type OfficeConfig,
  type OfficeMember,
  type OfficeMessage,
  type OfficeWorkspace,
} from "./crewonDomain";
import { writeOfficeConfigFile as writeStoredOfficeConfigFile } from "./domainPersistence";
import type { Locale } from "./i18n";

type OfficePanelIdentity = Pick<LibraryPanel, "title" | "subtitle">;

export async function writeOfficeConfig(
  client: AppServerClient,
  cwd: string,
  config: OfficeConfig,
): Promise<string> {
  return writeStoredOfficeConfigFile(client, cwd, config);
}

export async function persistOfficeWorkspace(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  threadId?: string | null,
): Promise<string | null> {
  const stableThreadId = threadId ?? workspace.threadId;
  if (!stableThreadId) {
    return null;
  }
  return writeOfficeConfig(
    client,
    cwd,
    officeConfigForThread(
      panel.title,
      panel.subtitle,
      workspace,
      stableThreadId,
    ),
  );
}

export async function persistOfficeMessage(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspaceBeforeMessage: OfficeWorkspace,
  message: OfficeMessage,
  text: string,
  threadId: string,
  locale: Locale,
  fallbackWorkspace: OfficeWorkspace,
): Promise<OfficeConfig | null> {
  try {
    const response = await client.sendOfficeMessageConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspaceBeforeMessage,
        threadId,
      ),
      message,
      text,
      locale,
    );
    return response.config;
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    await persistOfficeWorkspace(
      client,
      cwd,
      panel,
      fallbackWorkspace,
      threadId,
    );
    return null;
  }
}

export async function persistOfficeMember(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspaceBeforeMember: OfficeWorkspace,
  agentId: string | undefined,
  member: OfficeMember,
  threadId: string,
): Promise<OfficeConfig | null> {
  if (!agentId) {
    return null;
  }
  try {
    const response = await client.addOfficeMemberConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspaceBeforeMember,
        threadId,
      ),
      agentId,
      member,
    );
    return response.config;
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function decideOfficeApproval(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  threadId: string,
  approvalId: string,
  decision: "approved" | "denied",
  message?: OfficeMessage | null,
): Promise<OfficeConfig> {
  const response = await client.decideOfficeApprovalConfig(
    cwd,
    officeConfigForThread(panel.title, panel.subtitle, workspace, threadId),
    approvalId,
    decision,
    message ?? null,
  );
  return response.config;
}

export async function upsertOfficeArtifact(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  threadId: string,
  artifact: ArtifactItem,
  message?: OfficeMessage | null,
): Promise<OfficeConfig> {
  const response = await client.upsertOfficeArtifactConfig(
    cwd,
    officeConfigForThread(panel.title, panel.subtitle, workspace, threadId),
    artifact,
    message ?? null,
  );
  return response.config;
}

function isUnsupportedRpcError(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.code === -32601;
}
