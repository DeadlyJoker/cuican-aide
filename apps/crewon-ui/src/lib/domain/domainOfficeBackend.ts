import type { Turn } from "@crewon-protocol/v2/Turn";

import {
  isUnsupportedRpcError,
  type AppServerClient,
  type OfficeDelegationCancelResponse,
  type OfficeDelegationDispatchResponse,
  type OfficeDelegationRetryResponse,
  type OfficeMemoryDecideResponse,
  type OfficeMemoryListResponse,
  type OfficeMemberContextPreviewResponse,
  type OfficeVerificationCancelResponse,
  type OfficeRunResponse,
  type OfficeRunSyncResponse,
  type OfficeVerificationDispatchResponse,
  type OfficeVerificationRetryResponse,
} from "../app-server/appServer";
import { withBackendWorkspace } from "../backend/backendWorkspace";
import {
  officeConfigForThread,
  type ArtifactItem,
  type LibraryPanel,
  type OfficeConfig,
  type OfficeMember,
  type OfficeMessage,
  type OfficeMemoryStatus,
  type OfficeRunActivity,
  type OfficeRunDelegationActivity,
  type OfficeRunVerificationCheckActivity,
  type OfficeWorkspace,
} from "./crewonDomain";
import { writeOfficeConfigFile as writeStoredOfficeConfigFile } from "./domainPersistence";
import type { Locale } from "../i18n";
import { officeRunRetryText } from "../office/officeRunPanel";

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

export type AppOfficeDelegationDispatchResult = {
  cwd: string;
  response: OfficeDelegationDispatchResponse | null;
};

export type AppOfficeDelegationRetryResult = {
  cwd: string;
  response: OfficeDelegationRetryResponse | null;
};

export type AppOfficeDelegationCancelResult = {
  cwd: string;
  response: OfficeDelegationCancelResponse | null;
};

export type AppOfficeVerificationCancelResult = {
  cwd: string;
  response: OfficeVerificationCancelResponse | null;
};

export type AppOfficeVerificationRetryResult = {
  cwd: string;
  response: OfficeVerificationRetryResponse | null;
};

export type AppOfficeMemoryListResult = {
  cwd: string;
  response: OfficeMemoryListResponse | null;
};

export type AppOfficeMemoryDecisionResult = {
  cwd: string;
  response: OfficeMemoryDecideResponse | null;
};

export type AppOfficeMemberContextPreviewResult = {
  cwd: string;
  response: OfficeMemberContextPreviewResponse | null;
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
  return writeOfficeConfig(
    client,
    cwd,
    stableThreadId
      ? officeConfigForThread(
          panel.title,
          panel.subtitle,
          workspace,
          stableThreadId,
        )
      : {
          title: panel.title,
          subtitle: panel.subtitle,
          workspace,
        },
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

export async function cancelOfficeDelegation(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  run: OfficeRunActivity,
  delegation: OfficeRunDelegationActivity,
  locale: Locale,
): Promise<OfficeDelegationCancelResponse | null> {
  const delegationId = delegation.id;
  if (!delegationId) {
    return null;
  }
  try {
    return await client.cancelOfficeDelegationConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        run.threadId ?? workspace.threadId ?? "",
      ),
      run.id,
      delegationId,
      {
        threadId:
          delegation.threadId ??
          (delegation.targetKind === "runtimeThread" ? delegation.target : null),
        turnId: delegation.turnId ?? null,
        locale,
      },
    );
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function cancelAppOfficeDelegation(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  run: OfficeRunActivity;
  delegation: OfficeRunDelegationActivity;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeDelegationCancelResult | null> {
  const {
    client,
    panel,
    workspace,
    run,
    delegation,
    locale,
    resolveBackendCwd,
  } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: async ({ client, cwd }) => ({
      cwd,
      response: await cancelOfficeDelegation(
        client,
        cwd,
        panel,
        workspace,
        run,
        delegation,
        locale,
      ),
    }),
  });
}

export async function cancelOfficeVerification(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  run: OfficeRunActivity,
  check: OfficeRunVerificationCheckActivity,
  locale: Locale,
): Promise<OfficeVerificationCancelResponse | null> {
  const verificationCheckId = check.itemId ?? check.automationId ?? check.check;
  if (!verificationCheckId?.trim()) {
    return null;
  }
  try {
    return await client.cancelOfficeVerificationConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        run.threadId ?? workspace.threadId ?? "",
      ),
      run.id,
      verificationCheckId,
      {
        threadId: check.automationThreadId ?? check.sourceThreadId ?? null,
        turnId: check.automationTurnId ?? check.sourceTurnId ?? null,
        locale,
      },
    );
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function cancelAppOfficeVerification(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  run: OfficeRunActivity;
  check: OfficeRunVerificationCheckActivity;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeVerificationCancelResult | null> {
  const { client, panel, workspace, run, check, locale, resolveBackendCwd } =
    params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: async ({ client, cwd }) => ({
      cwd,
      response: await cancelOfficeVerification(
        client,
        cwd,
        panel,
        workspace,
        run,
        check,
        locale,
      ),
    }),
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
        text: officeRunRetryText(run, locale),
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

export async function dispatchNextOfficeVerification(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  run: OfficeRunActivity,
  locale: Locale,
  clientUserMessageId?: string | null,
): Promise<OfficeVerificationDispatchResponse | null> {
  try {
    return await client.dispatchNextOfficeVerificationConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        run.threadId ?? workspace.threadId ?? "",
      ),
      run.id,
      {
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

export async function dispatchNextAppOfficeVerification(params: {
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
      response: await dispatchNextOfficeVerification(
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

export async function retryOfficeVerification(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  run: OfficeRunActivity,
  check: OfficeRunVerificationCheckActivity,
  locale: Locale,
  clientUserMessageId?: string | null,
): Promise<OfficeVerificationRetryResponse | null> {
  const verificationCheckId = check.itemId ?? check.automationId ?? check.check;
  if (!verificationCheckId?.trim()) {
    return null;
  }
  try {
    return await client.retryOfficeVerificationConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        run.threadId ?? workspace.threadId ?? "",
      ),
      run.id,
      verificationCheckId,
      {
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

export async function retryAppOfficeVerification(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  run: OfficeRunActivity;
  check: OfficeRunVerificationCheckActivity;
  locale: Locale;
  clientUserMessageId: string;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeVerificationRetryResult | null> {
  const {
    client,
    panel,
    workspace,
    run,
    check,
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
      response: await retryOfficeVerification(
        client,
        cwd,
        panel,
        workspace,
        run,
        check,
        locale,
        clientUserMessageId,
      ),
    }),
  });
}

export async function dispatchOfficeDelegation(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  run: OfficeRunActivity,
  task: string,
  locale: Locale,
  params?: {
    member?: string | null;
    agentId?: string | null;
    clientUserMessageId?: string | null;
  },
): Promise<OfficeDelegationDispatchResponse | null> {
  try {
    return await client.dispatchOfficeDelegationConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        run.threadId ?? workspace.threadId ?? "",
      ),
      run.id,
      task,
      {
        member: params?.member ?? null,
        agentId: params?.agentId ?? null,
        locale,
        clientUserMessageId: params?.clientUserMessageId ?? null,
      },
    );
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function dispatchAppOfficeDelegation(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  run: OfficeRunActivity;
  task: string;
  locale: Locale;
  member?: string | null;
  agentId?: string | null;
  clientUserMessageId: string;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeDelegationDispatchResult | null> {
  const {
    client,
    panel,
    workspace,
    run,
    task,
    locale,
    member,
    agentId,
    clientUserMessageId,
    resolveBackendCwd,
  } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: async ({ client, cwd }) => ({
      cwd,
      response: await dispatchOfficeDelegation(
        client,
        cwd,
        panel,
        workspace,
        run,
        task,
        locale,
        {
          member: member ?? null,
          agentId: agentId ?? null,
          clientUserMessageId,
        },
      ),
    }),
  });
}

export async function retryOfficeDelegation(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  run: OfficeRunActivity,
  delegation: OfficeRunDelegationActivity,
  locale: Locale,
  clientUserMessageId?: string | null,
): Promise<OfficeDelegationRetryResponse | null> {
  const delegationId = delegation.id;
  if (!delegationId) {
    return null;
  }
  try {
    return await client.retryOfficeDelegationConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        run.threadId ?? workspace.threadId ?? "",
      ),
      run.id,
      delegationId,
      {
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

export async function retryAppOfficeDelegation(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  run: OfficeRunActivity;
  delegation: OfficeRunDelegationActivity;
  locale: Locale;
  clientUserMessageId: string;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeDelegationRetryResult | null> {
  const {
    client,
    panel,
    workspace,
    run,
    delegation,
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
      response: await retryOfficeDelegation(
        client,
        cwd,
        panel,
        workspace,
        run,
        delegation,
        locale,
        clientUserMessageId,
      ),
    }),
  });
}

export async function dispatchNextOfficeDelegation(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  run: OfficeRunActivity,
  locale: Locale,
  clientUserMessageId?: string | null,
  dispatchPolicy?: "interactive" | "auto" | null,
): Promise<OfficeDelegationDispatchResponse | null> {
  try {
    return await client.dispatchNextOfficeDelegationConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        run.threadId ?? workspace.threadId ?? "",
      ),
      run.id,
      {
        dispatchPolicy: dispatchPolicy ?? null,
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

export async function dispatchNextAppOfficeDelegation(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  run: OfficeRunActivity;
  locale: Locale;
  clientUserMessageId: string;
  dispatchPolicy?: "interactive" | "auto" | null;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeDelegationDispatchResult | null> {
  const {
    client,
    panel,
    workspace,
    run,
    locale,
    clientUserMessageId,
    dispatchPolicy,
    resolveBackendCwd,
  } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: async ({ client, cwd }) => ({
      cwd,
      response: await dispatchNextOfficeDelegation(
        client,
        cwd,
        panel,
        workspace,
        run,
        locale,
        clientUserMessageId,
        dispatchPolicy,
      ),
    }),
  });
}

export async function previewOfficeMemberContext(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  run: OfficeRunActivity,
  locale: Locale,
  params?: {
    task?: string | null;
    member?: string | null;
    agentId?: string | null;
  },
): Promise<OfficeMemberContextPreviewResponse | null> {
  try {
    return await client.previewOfficeMemberContextConfig(
      cwd,
      officeConfigForThread(
        panel.title,
        panel.subtitle,
        workspace,
        run.threadId ?? workspace.threadId ?? "",
      ),
      run.id,
      {
        task: params?.task ?? null,
        member: params?.member ?? null,
        agentId: params?.agentId ?? null,
        locale,
      },
    );
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function previewAppOfficeMemberContext(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  run: OfficeRunActivity;
  locale: Locale;
  task?: string | null;
  member?: string | null;
  agentId?: string | null;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeMemberContextPreviewResult | null> {
  const {
    client,
    panel,
    workspace,
    run,
    locale,
    task,
    member,
    agentId,
    resolveBackendCwd,
  } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: async ({ client, cwd }) => ({
      cwd,
      response: await previewOfficeMemberContext(
        client,
        cwd,
        panel,
        workspace,
        run,
        locale,
        {
          task: task ?? null,
          member: member ?? null,
          agentId: agentId ?? null,
        },
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
  threadId?: string | null,
): Promise<OfficeConfig | null> {
  if (!agentId) {
    return null;
  }
  try {
    const response = await client.addOfficeMemberConfig(
      cwd,
      threadId
        ? officeConfigForThread(
            panel.title,
            panel.subtitle,
            workspaceBeforeMember,
            threadId,
          )
        : {
            title: panel.title,
            subtitle: panel.subtitle,
            workspace: workspaceBeforeMember,
          },
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
  threadId?: string | null;
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

export async function listOfficeMemories(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  threadId: string,
  params?: {
    status?: OfficeMemoryStatus | null;
    cursor?: string | null;
    limit?: number | null;
  },
): Promise<OfficeMemoryListResponse | null> {
  try {
    return await client.listOfficeMemories(
      cwd,
      officeConfigForThread(panel.title, panel.subtitle, workspace, threadId),
      {
        status: params?.status ?? null,
        cursor: params?.cursor ?? null,
        limit: params?.limit ?? null,
      },
    );
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function listAppOfficeMemories(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  threadId: string;
  status?: OfficeMemoryStatus | null;
  cursor?: string | null;
  limit?: number | null;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeMemoryListResult | null> {
  const {
    client,
    panel,
    workspace,
    threadId,
    status,
    cursor,
    limit,
    resolveBackendCwd,
  } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: async ({ client, cwd }) => ({
      cwd,
      response: await listOfficeMemories(
        client,
        cwd,
        panel,
        workspace,
        threadId,
        {
          status: status ?? null,
          cursor: cursor ?? null,
          limit: limit ?? null,
        },
      ),
    }),
  });
}

export async function decideOfficeMemory(
  client: AppServerClient,
  cwd: string,
  panel: OfficePanelIdentity,
  workspace: OfficeWorkspace,
  threadId: string,
  memoryId: string,
  status: OfficeMemoryStatus,
): Promise<OfficeMemoryDecideResponse | null> {
  try {
    return await client.decideOfficeMemory(
      cwd,
      officeConfigForThread(panel.title, panel.subtitle, workspace, threadId),
      memoryId,
      status,
    );
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function decideAppOfficeMemory(params: {
  client: AppServerClient | null;
  panel: OfficePanelIdentity;
  workspace: OfficeWorkspace;
  threadId: string;
  memoryId: string;
  status: OfficeMemoryStatus;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AppOfficeMemoryDecisionResult | null> {
  const {
    client,
    panel,
    workspace,
    threadId,
    memoryId,
    status,
    resolveBackendCwd,
  } = params;
  return withBackendWorkspace({
    client,
    fallback: null,
    resolveBackendCwd,
    run: async ({ client, cwd }) => ({
      cwd,
      response: await decideOfficeMemory(
        client,
        cwd,
        panel,
        workspace,
        threadId,
        memoryId,
        status,
      ),
    }),
  });
}
