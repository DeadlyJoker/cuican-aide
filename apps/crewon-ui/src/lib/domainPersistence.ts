import {
  AppServerRpcError,
  type AppServerClient,
  type DomainConfigListResponse,
} from "./appServer";
import type {
  AgentConfig,
  AgentConfigRecord,
  AutomationConfig,
  AutomationConfigRecord,
  OfficeConfig,
  OfficeConfigRecord,
  ToolConfig,
  ToolConfigKind,
  ToolConfigRecord,
} from "./domainTypes";

export type DomainConfigKind = "agent" | "automation" | "office" | "tool";

export type DomainConfigRecord<TConfig> = {
  filePath: string;
  savedAt: string;
  config: TConfig;
};

export type AgentConfigWriteResult = {
  filePath: string;
  agentId?: string;
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

export function agentConfigDirectory(cwd: string): string {
  return crewonConfigDirectory(cwd, "agent");
}

export function automationConfigDirectory(cwd: string): string {
  return crewonConfigDirectory(cwd, "automation");
}

export function officeConfigDirectory(cwd: string): string {
  return crewonConfigDirectory(cwd, "office");
}

export function toolConfigDirectory(cwd: string): string {
  return crewonConfigDirectory(cwd, "tool");
}

export function slugifyDomainFileName(
  name: string,
  fallback = "crewon-config",
): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

export function domainConfigFileName(
  kind: DomainConfigKind,
  title: string,
  threadId?: string,
  now: Date = new Date(),
): string {
  const fileStem = [
    slugifyDomainFileName(title || kind, kind),
    threadId ? threadId.slice(0, 8) : now.getTime().toString(36),
  ]
    .filter(Boolean)
    .join("-");
  return `${fileStem}.json`;
}

export async function writeAgentConfigFile(
  client: AppServerClient,
  cwd: string,
  config: AgentConfig,
): Promise<AgentConfigWriteResult> {
  try {
    const response = await client.saveAgentConfig(cwd, config);
    return { filePath: response.filePath, agentId: response.agentId };
  } catch (error) {
    if (!shouldFallbackToFsPersistence(error)) {
      throw error;
    }
  }

  const agentsDir = agentConfigDirectory(cwd);
  const filePath = joinDomainPath(
    agentsDir,
    domainConfigFileName("agent", config.name, config.threadId),
  );
  const record: AgentConfigRecord = createAgentConfigRecord(config);
  await writeConfigRecord(client, agentsDir, filePath, record);
  return { filePath, agentId: config.agentId };
}

export async function writeAutomationConfigFile(
  client: AppServerClient,
  cwd: string,
  config: AutomationConfig,
): Promise<string> {
  try {
    return (await client.saveAutomationConfig(cwd, config)).filePath;
  } catch (error) {
    if (!shouldFallbackToFsPersistence(error)) {
      throw error;
    }
  }

  const automationsDir = automationConfigDirectory(cwd);
  const filePath = joinDomainPath(
    automationsDir,
    domainConfigFileName("automation", config.title, config.threadId),
  );
  const record: AutomationConfigRecord = createAutomationConfigRecord(config);
  await writeConfigRecord(client, automationsDir, filePath, record);
  return filePath;
}

export async function writeOfficeConfigFile(
  client: AppServerClient,
  cwd: string,
  config: OfficeConfig,
): Promise<string> {
  try {
    return (await client.saveOfficeConfig(cwd, config)).filePath;
  } catch (error) {
    if (!shouldFallbackToFsPersistence(error)) {
      throw error;
    }
  }

  const officesDir = officeConfigDirectory(cwd);
  const filePath = joinDomainPath(
    officesDir,
    domainConfigFileName("office", config.title, config.workspace.threadId),
  );
  const record: OfficeConfigRecord = createOfficeConfigRecord(config);
  await writeConfigRecord(client, officesDir, filePath, record);
  return filePath;
}

export async function writeToolConfigFile(
  client: AppServerClient,
  cwd: string,
  config: ToolConfig,
): Promise<string> {
  try {
    return (await client.saveToolConfig(cwd, config)).filePath;
  } catch (error) {
    if (!shouldFallbackToFsPersistence(error)) {
      throw error;
    }
  }

  const toolsDir = toolConfigDirectory(cwd);
  const filePath = joinDomainPath(
    toolsDir,
    domainConfigFileName("tool", config.title, config.name),
  );
  const record: ToolConfigRecord = createToolConfigRecord(config);
  await writeConfigRecord(client, toolsDir, filePath, record);
  return filePath;
}

export async function readAgentConfigFiles(
  client: AppServerClient,
  cwd: string,
): Promise<Array<DomainConfigRecord<AgentConfig>>> {
  try {
    return normalizeDomainConfigList(await client.listAgentConfigs(cwd));
  } catch (error) {
    if (!shouldFallbackToFsPersistence(error)) {
      throw error;
    }
  }

  return readConfigRecords(client, agentConfigDirectory(cwd), isAgentConfigRecord);
}

export async function readAutomationConfigFiles(
  client: AppServerClient,
  cwd: string,
): Promise<Array<DomainConfigRecord<AutomationConfig>>> {
  try {
    return normalizeDomainConfigList(await client.listAutomationConfigs(cwd));
  } catch (error) {
    if (!shouldFallbackToFsPersistence(error)) {
      throw error;
    }
  }

  return readConfigRecords(
    client,
    automationConfigDirectory(cwd),
    isAutomationConfigRecord,
  );
}

export async function readOfficeConfigFiles(
  client: AppServerClient,
  cwd: string,
): Promise<Array<DomainConfigRecord<OfficeConfig>>> {
  try {
    return normalizeDomainConfigList(await client.listOfficeConfigs(cwd));
  } catch (error) {
    if (!shouldFallbackToFsPersistence(error)) {
      throw error;
    }
  }

  return readConfigRecords(
    client,
    officeConfigDirectory(cwd),
    isOfficeConfigRecord,
  );
}

export async function readToolConfigFiles(
  client: AppServerClient,
  cwd: string,
  kind?: ToolConfigKind,
): Promise<Array<DomainConfigRecord<ToolConfig>>> {
  try {
    return normalizeDomainConfigList(await client.listToolConfigs(cwd, kind));
  } catch (error) {
    if (!shouldFallbackToFsPersistence(error)) {
      throw error;
    }
  }

  const records = await readConfigRecords<ToolConfig>(
    client,
    toolConfigDirectory(cwd),
    isToolConfigRecord,
  );
  return kind
    ? records.filter((record) => record.config.kind === kind)
    : records;
}

export async function deleteDomainConfigFile(
  client: AppServerClient,
  cwd: string,
  filePath: string,
): Promise<boolean> {
  const kind = inferDomainConfigKind(cwd, filePath);
  if (!kind) {
    await client.removePath(filePath, false, true);
    return true;
  }

  try {
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
  } catch (error) {
    if (!shouldFallbackToFsPersistence(error)) {
      throw error;
    }
  }

  await client.removePath(filePath, false, true);
  return true;
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
      normalizedFilePath.startsWith(`${normalizePath(crewonConfigDirectory(cwd, kind))}/`),
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

function shouldFallbackToFsPersistence(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof AppServerRpcError) {
    return error.code === -32601;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("app-server is not connected") ||
    message.includes("app-server connection closed") ||
    message.includes("unable to connect") ||
    message.includes("unable to send app-server request")
  );
}

function createAgentConfigRecord(config: AgentConfig): AgentConfigRecord {
  return {
    version: 1,
    kind: "agent",
    savedAt: new Date().toISOString(),
    config,
  };
}

function createAutomationConfigRecord(
  config: AutomationConfig,
): AutomationConfigRecord {
  return {
    version: 1,
    kind: "automation",
    savedAt: new Date().toISOString(),
    config,
  };
}

function createOfficeConfigRecord(config: OfficeConfig): OfficeConfigRecord {
  return {
    version: 1,
    kind: "office",
    savedAt: new Date().toISOString(),
    config,
  };
}

function createToolConfigRecord(config: ToolConfig): ToolConfigRecord {
  return {
    version: 1,
    kind: "tool",
    savedAt: new Date().toISOString(),
    config,
  };
}

async function writeConfigRecord(
  client: AppServerClient,
  directory: string,
  filePath: string,
  record:
    | AgentConfigRecord
    | AutomationConfigRecord
    | OfficeConfigRecord
    | ToolConfigRecord,
): Promise<void> {
  await client.createDirectory(directory, true);
  await client.writeTextFile(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

async function readConfigRecords<TConfig>(
  client: AppServerClient,
  directory: string,
  isExpectedRecord: (value: unknown) => value is
    | AgentConfigRecord
    | AutomationConfigRecord
    | OfficeConfigRecord
    | ToolConfigRecord,
): Promise<Array<DomainConfigRecord<TConfig>>> {
  let entries: Awaited<ReturnType<AppServerClient["readDirectory"]>>["entries"];
  try {
    entries = (await client.readDirectory(directory)).entries;
  } catch {
    return [];
  }

  const records = await Promise.allSettled(
    entries
      .filter((entry) => entry.isFile && entry.fileName.endsWith(".json"))
      .map(async (entry) => {
        const filePath = joinDomainPath(directory, entry.fileName);
        const response = await client.readFile(filePath);
        const parsed = JSON.parse(decodeBase64Text(response.dataBase64));
        if (!isExpectedRecord(parsed)) {
          return null;
        }
        return {
          filePath,
          savedAt: parsed.savedAt ?? "",
          config: parsed.config as TConfig,
        };
      }),
  );

  return records
    .flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    )
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    .slice(0, MAX_CONFIG_RECORDS);
}

function isAgentConfigRecord(value: unknown): value is AgentConfigRecord {
  return (
    isRecord(value, "agent") &&
    isObject(value.config) &&
    "name" in value.config
  );
}

function isAutomationConfigRecord(value: unknown): value is AutomationConfigRecord {
  return (
    isRecord(value, "automation") &&
    isObject(value.config) &&
    "title" in value.config
  );
}

function isOfficeConfigRecord(value: unknown): value is OfficeConfigRecord {
  return (
    isRecord(value, "office") &&
    isObject(value.config) &&
    isObject(value.config.workspace)
  );
}

function isToolConfigRecord(value: unknown): value is ToolConfigRecord {
  return (
    isRecord(value, "tool") &&
    isObject(value.config) &&
    (value.config.kind === "mcp" || value.config.kind === "skill") &&
    typeof value.config.title === "string" &&
    typeof value.config.name === "string"
  );
}

function isRecord(
  value: unknown,
  kind: DomainConfigKind,
): value is { config: unknown; savedAt?: string } {
  return isObject(value) && value.kind === kind && value.version === 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeBase64Text(dataBase64: string): string {
  const binary = atob(dataBase64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
