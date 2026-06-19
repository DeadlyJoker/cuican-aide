import type { Turn } from "@crewon-protocol/v2/Turn";

import {
  isUnsupportedRpcError,
  type AppServerClient,
  type OfficeRunResponse,
  type OfficeRunSyncResponse,
} from "../app-server/appServer";
import { withBackendWorkspace } from "../backend/backendWorkspace";
import {
  officeConfigForThread,
  type ArtifactItem,
  type LibraryPanel,
  type OfficeConfig,
  type OfficeMember,
  type OfficeMessage,
  type OfficeRunActivity,
  type OfficeWorkspace,
} from "./crewonDomain";
import { writeOfficeConfigFile as writeStoredOfficeConfigFile } from "./domainPersistence";
import type { Locale } from "../i18n";

type OfficePanelIdentity = Pick<LibraryPanel, "title" | "subtitle">;
export type OfficeRunSyncClient = {
  syncOfficeRunConfig(
    cwd: string,
    config: OfficeConfig,
    turn: Turn,
    params?: {
      runId?: string | null;
      locale?: Locale | null;
    },
  ): Promise<OfficeRunSyncResponse>;
};

export type AppOfficeMessageRunResult = {
  cwd: string;
  handled: true;
  response: OfficeRunResponse | null;
};

export type AppOfficeRunRetryResult = {
  cwd: string;
  response: OfficeRunResponse | null;
};

export async function writeOfficeConfig(
  client: AppServerClient,
  cwd: string,
  config: OfficeConfig,
): Promise<string> {
  return writeStoredOfficeConfigFile(client, cwd, config);
}

export async function writeAppOfficeConfig(params: {
  client: AppServerClient | null;
  config: OfficeConfig;
  resolveBackendCwd: () => Promise<string>;
}): Promise<string | null> {
  const { client, config, resolveBackendCwd } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: ({ client, cwd }) => writeOfficeConfig(client, cwd, config),
  });
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

export async function persistAppOfficeWorkspace(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  threadId?: string | null;
  resolveBackendCwd: () => Promise<string>;
}): Promise<string | null> {
  const { client, panel, workspace, threadId, resolveBackendCwd } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: ({ client, cwd }) =>
      persistOfficeWorkspace(client, cwd, panel, workspace, threadId),
  });
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

export async function persistAppOfficeMessage(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspaceBeforeMessage: OfficeWorkspace;
  message: OfficeMessage;
  text: string;
  threadId: string;
  locale: Locale;
  fallbackWorkspace: OfficeWorkspace;
  resolveBackendCwd: () => Promise<string>;
}): Promise<OfficeConfig | null> {
  const {
    client,
    panel,
    workspaceBeforeMessage,
    message,
    text,
    threadId,
    locale,
    fallbackWorkspace,
    resolveBackendCwd,
  } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: ({ client, cwd }) =>
      persistOfficeMessage(
        client,
        cwd,
        panel,
        workspaceBeforeMessage,
        message,
        text,
        threadId,
        locale,
        fallbackWorkspace,
      ),
  });
}

export async function runOfficeMessage(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspaceBeforeMessage: OfficeWorkspace,
  message: OfficeMessage,
  text: string,
  threadId: string,
  locale: Locale,
  fallbackWorkspace: OfficeWorkspace,
  clientUserMessageId?: string | null,
): Promise<OfficeRunResponse | null> {
  try {
    return await client.runOfficeConfig(
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
      threadId,
      clientUserMessageId ?? null,
    );
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    await persistOfficeMessage(
      client,
      cwd,
      panel,
      workspaceBeforeMessage,
      message,
      text,
      threadId,
      locale,
      fallbackWorkspace,
    );
    return null;
  }
}

export async function runAppOfficeMessage(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspaceBeforeMessage: OfficeWorkspace;
  message: OfficeMessage;
  text: string;
  threadId: string;
  locale: Locale;
  fallbackWorkspace: OfficeWorkspace;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeMessageRunResult | null> {
  const {
    client,
    panel,
    workspaceBeforeMessage,
    message,
    text,
    threadId,
    locale,
    fallbackWorkspace,
    resolveBackendCwd,
  } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: async ({ client, cwd }) => ({
      cwd,
      handled: true,
      response: await runOfficeMessage(
        client,
        cwd,
        panel,
        workspaceBeforeMessage,
        message,
        text,
        threadId,
        locale,
        fallbackWorkspace,
      ),
    }),
  });
}

export async function syncOfficeRun(
  client: OfficeRunSyncClient,
  cwd: string,
  config: OfficeConfig,
  turn: Turn,
  locale: Locale,
  runId?: string | null,
): Promise<OfficeConfig | null> {
  try {
    const response = await client.syncOfficeRunConfig(cwd, config, turn, {
      runId: runId ?? null,
      locale,
    });
    return response.config;
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function cancelOfficeRun(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  run: OfficeRunActivity,
  locale: Locale,
): Promise<OfficeConfig | null> {
  try {
    const response = await client.cancelOfficeRunConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        run.threadId ?? workspace.threadId ?? "",
      ),
      run.id,
      {
        threadId: run.threadId ?? workspace.threadId ?? null,
        turnId: run.turnId ?? null,
        locale,
      },
    );
    return response.config;
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function cancelAppOfficeRun(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  run: OfficeRunActivity;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
}): Promise<OfficeConfig | null> {
  const { client, panel, workspace, run, locale, resolveBackendCwd } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: ({ client, cwd }) =>
      cancelOfficeRun(client, cwd, panel, workspace, run, locale),
  });
}

export async function retryOfficeRun(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  run: OfficeRunActivity,
  locale: Locale,
  clientUserMessageId?: string | null,
): Promise<OfficeRunResponse | null> {
  try {
    return await client.retryOfficeRunConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        run.threadId ?? workspace.threadId ?? "",
      ),
      run.id,
      {
        text: run.requestText ?? run.promptPreview ?? run.title,
        locale,
        clientUserMessageId: clientUserMessageId ?? null,
      },
    );
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function retryAppOfficeRun(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  run: OfficeRunActivity;
  locale: Locale;
  clientUserMessageId: string;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeRunRetryResult | null> {
  const {
    client,
    panel,
    workspace,
    run,
    locale,
    clientUserMessageId,
    resolveBackendCwd,
  } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: async ({ client, cwd }) => ({
      cwd,
      response: await retryOfficeRun(
        client,
        cwd,
        panel,
        workspace,
        run,
        locale,
        clientUserMessageId,
      ),
    }),
  });
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

export async function persistAppOfficeMember(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspaceBeforeMember: OfficeWorkspace;
  agentId: string | undefined;
  member: OfficeMember;
  threadId: string;
  resolveBackendCwd: () => Promise<string>;
}): Promise<OfficeConfig | null> {
  const {
    client,
    panel,
    workspaceBeforeMember,
    agentId,
    member,
    threadId,
    resolveBackendCwd,
  } = params;
  if (!agentId) {
    return null;
  }
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: ({ client, cwd }) =>
      persistOfficeMember(
        client,
        cwd,
        panel,
        workspaceBeforeMember,
        agentId,
        member,
        threadId,
      ),
  });
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

export async function decideAppOfficeApproval(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  threadId: string;
  approvalId: string;
  decision: "approved" | "denied";
  message?: OfficeMessage | null;
  resolveBackendCwd: () => Promise<string>;
}): Promise<OfficeConfig | null> {
  const {
    client,
    panel,
    workspace,
    threadId,
    approvalId,
    decision,
    message,
    resolveBackendCwd,
  } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: ({ client, cwd }) =>
      decideOfficeApproval(
        client,
        cwd,
        panel,
        workspace,
        threadId,
        approvalId,
        decision,
        message,
      ),
  });
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
