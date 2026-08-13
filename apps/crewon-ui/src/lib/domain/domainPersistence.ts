import {
  type AppServerClient,
  type DomainConfigListResponse,
} from "../app-server/appServer";
import { isUnsupportedRpcError } from "../shared/rpcErrors";
import type {
  AgentConfig,
  AutomationConfig,
  DomainConfigKind,
  OfficeConfig,
  ToolConfig,
  ToolConfigKind,
} from "./domainTypes";

export type DomainConfigRecord<TConfig> = {
  filePath: string;
  savedAt: string;
  config: TConfig;
};

export type AgentConfigWriteResult = {
  filePath: string;
  agentId?: string;
};

export type OfficeConfigWriteResult = {
  config: OfficeConfig;
  filePath: string;
};

const MAX_CONFIG_RECORDS = 24;

export function joinDomainPath(basePath: string, childName: string): string {
  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath.replace(/[\\/]+$/, "")}${separator}${childName}`;
}

export function crewonConfigDirectory(
  cwd: string,
  kind: DomainConfigKind,
): string {
  return joinDomainPath(
    joinDomainPath(cwd, ".crewon"),
    configDirectoryName(kind),
  );
}

export async function writeAgentConfigFile(
  client: AppServerClient,
  cwd: string,
  config: AgentConfig,
): Promise<AgentConfigWriteResult> {
  try {
    const response = await client.createAgentConfig(cwd, config);
    return { filePath: response.filePath, agentId: response.agentId };
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    const response = await client.saveAgentConfig(cwd, config);
    return { filePath: response.filePath, agentId: response.agentId };
  }
}

export async function writeAutomationConfigFile(
  client: AppServerClient,
  cwd: string,
  config: AutomationConfig,
): Promise<string> {
  return (await client.saveAutomationConfig(cwd, config)).filePath;
}

export async function writeOfficeConfigFile(
  client: AppServerClient,
  cwd: string,
  config: OfficeConfig,
): Promise<OfficeConfigWriteResult> {
  const response = await client.saveOfficeConfig(cwd, config);
  return {
    config: response.config ?? config,
    filePath: response.filePath,
  };
}

export async function readAgentConfigFiles(
  client: AppServerClient,
  cwd: string,
): Promise<Array<DomainConfigRecord<AgentConfig>>> {
  return normalizeDomainConfigList(await client.listAgentConfigs(cwd));
}

export async function readAutomationConfigFiles(
  client: AppServerClient,
  cwd: string,
): Promise<Array<DomainConfigRecord<AutomationConfig>>> {
  return normalizeDomainConfigList(await client.listAutomationConfigs(cwd));
}

export async function readOfficeConfigFiles(
  client: AppServerClient,
  cwd: string,
): Promise<Array<DomainConfigRecord<OfficeConfig>>> {
  return normalizeDomainConfigList(await client.listOfficeConfigs(cwd));
}

export async function readToolConfigFiles(
  client: AppServerClient,
  cwd: string,
  kind?: ToolConfigKind,
): Promise<Array<DomainConfigRecord<ToolConfig>>> {
  return normalizeDomainConfigList(await client.listToolConfigs(cwd, kind));
}

export async function deleteDomainConfigFile(
  client: AppServerClient,
  cwd: string,
  filePath: string,
  configKind?: DomainConfigKind,
): Promise<boolean> {
  const kind = configKind ?? inferDomainConfigKind(cwd, filePath);
  if (!kind) {
    throw new Error(`Unknown domain record path: ${filePath}`);
  }

  switch (kind) {
    case "agent":
      return (await client.deleteAgentConfig(cwd, filePath)).deleted;
    case "automation":
      return (await client.deleteAutomationConfig(cwd, filePath)).deleted;
    case "office":
      return (await client.deleteOfficeConfig(cwd, filePath)).deleted;
    case "tool":
      return (await client.deleteToolConfig(cwd, filePath)).deleted;
  }
}

function configDirectoryName(kind: DomainConfigKind): string {
  switch (kind) {
    case "agent":
      return "agents";
    case "automation":
      return "automations";
    case "office":
      return "offices";
    case "tool":
      return "tools";
  }
}

function inferDomainConfigKind(
  cwd: string,
  filePath: string,
): DomainConfigKind | null {
  const normalizedFilePath = normalizePath(filePath);
  const kinds: DomainConfigKind[] = ["agent", "automation", "office", "tool"];
  return (
    kinds.find((kind) =>
      normalizedFilePath.startsWith(
        `${normalizePath(crewonConfigDirectory(cwd, kind))}/`,
      ),
    ) ?? null
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeDomainConfigList<TConfig>(
  response: DomainConfigListResponse<TConfig>,
): Array<DomainConfigRecord<TConfig>> {
  return response.data
    .map((record) => ({
      filePath: record.filePath,
      savedAt: record.savedAt,
      config: record.config,
    }))
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    .slice(0, MAX_CONFIG_RECORDS);
}
