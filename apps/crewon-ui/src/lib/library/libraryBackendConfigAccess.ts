import type { AppServerClient } from "../app-server/appServer";
import { isLegacyGeneratedAgentPlaceholder } from "../agent-config/legacyAgentPlaceholder";
import type { BackendWorkspace } from "../backend/backendWorkspace";
import type { AgentConfig, AutomationConfig, OfficeConfig } from "../domain/crewonDomain";

export type BackendConfigRecord<TConfig> = {
  config: TConfig;
  filePath: string;
};

export type BackendWorkspaceProvider = () => Promise<BackendWorkspace>;
export type OptionalBackendWorkspaceProvider =
  () => Promise<BackendWorkspace | null>;

type OfficeCreateParams = Parameters<AppServerClient["createOfficeConfig"]>[1];
type AutomationCreateParams = Omit<
  Parameters<AppServerClient["createAutomationConfig"]>[1],
  "enabled"
>;

export async function createBackendOfficeConfig(
  workspaceProvider: OptionalBackendWorkspaceProvider,
  params: OfficeCreateParams,
): Promise<BackendConfigRecord<OfficeConfig> | null> {
  const workspace = await workspaceProvider();
  if (!workspace) {
    return null;
  }

  const response = await workspace.client.createOfficeConfig(
    workspace.cwd,
    params,
  );
  return {
    config: response.config,
    filePath: response.filePath,
  };
}

export async function createBackendAutomationConfig(
  workspaceProvider: BackendWorkspaceProvider,
  params: AutomationCreateParams,
): Promise<BackendConfigRecord<AutomationConfig>> {
  const { client, cwd } = await workspaceProvider();
  const response = await client.createAutomationConfig(cwd, {
    ...params,
    enabled: true,
  });
  return {
    config: response.config,
    filePath: response.filePath,
  };
}

export async function listBackendAgentConfigs(
  workspaceProvider: BackendWorkspaceProvider,
): Promise<Array<BackendConfigRecord<AgentConfig>>> {
  const { client, cwd } = await workspaceProvider();
  return (await client.listAgentConfigs(cwd)).data.filter(
    (record) => !isLegacyGeneratedAgentPlaceholder(record.config),
  );
}

export async function listBackendOfficeConfigs(
  workspaceProvider: BackendWorkspaceProvider,
): Promise<Array<BackendConfigRecord<OfficeConfig>>> {
  const { client, cwd } = await workspaceProvider();
  return (await client.listOfficeConfigs(cwd)).data;
}

export async function readBackendAgentConfig(
  workspaceProvider: OptionalBackendWorkspaceProvider,
  params: Parameters<AppServerClient["readAgentConfig"]>[1],
): Promise<Awaited<ReturnType<AppServerClient["readAgentConfig"]>> | null> {
  const workspace = await workspaceProvider();
  if (!workspace) {
    return null;
  }
  return workspace.client.readAgentConfig(workspace.cwd, params);
}

export async function readBackendAutomationConfig(
  workspaceProvider: OptionalBackendWorkspaceProvider,
  params: Parameters<AppServerClient["readAutomationConfig"]>[1],
): Promise<
  Awaited<ReturnType<AppServerClient["readAutomationConfig"]>> | null
> {
  const workspace = await workspaceProvider();
  if (!workspace) {
    return null;
  }
  return workspace.client.readAutomationConfig(workspace.cwd, params);
}

export async function listBackendAutomationRuns(
  workspaceProvider: OptionalBackendWorkspaceProvider,
  threadId: string,
): Promise<Awaited<ReturnType<AppServerClient["listAutomationRuns"]>> | null> {
  const workspace = await workspaceProvider();
  if (!workspace) {
    return null;
  }
  return workspace.client.listAutomationRuns(workspace.cwd, threadId);
}

export async function readBackendOfficeConfig(
  workspaceProvider: OptionalBackendWorkspaceProvider,
  params: Parameters<AppServerClient["readOfficeConfig"]>[1],
): Promise<Awaited<ReturnType<AppServerClient["readOfficeConfig"]>> | null> {
  const workspace = await workspaceProvider();
  if (!workspace) {
    return null;
  }
  return workspace.client.readOfficeConfig(workspace.cwd, params);
}

export async function updateBackendAutomationConfig(
  workspaceProvider: BackendWorkspaceProvider,
  filePath: string,
  config: AutomationConfig,
): Promise<BackendConfigRecord<AutomationConfig>> {
  const { client, cwd } = await workspaceProvider();
  const response = await client.updateAutomationConfig(cwd, filePath, config);
  return {
    config: response.config,
    filePath: response.filePath,
  };
}

export async function updateBackendAutomationConfigPath(
  workspaceProvider: OptionalBackendWorkspaceProvider,
  filePath: string,
  config: AutomationConfig,
): Promise<string | null> {
  const workspace = await workspaceProvider();
  if (!workspace) {
    return null;
  }

  const response = await workspace.client.updateAutomationConfig(
    workspace.cwd,
    filePath,
    config,
  );
  return response.filePath;
}
