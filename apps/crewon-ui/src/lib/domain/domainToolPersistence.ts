import { isUnsupportedRpcError, type AppServerClient } from "../app-server/appServer";
import type {
  LibraryItem,
  LibraryPanelAction,
  McpDetailAction,
  SkillFileAction,
  ToolConfig,
} from "./crewonDomain";
import { toolConfigRecordsToLibraryItems } from "./domainLibraryItems";
import type { Locale } from "../i18n";
import { pathBaseName } from "../shared/pathUtils";

export type ToolConfigWriteResult = {
  filePath: string;
  operation: "created" | "updated";
};

export async function saveOrUpdateToolConfig(
  client: AppServerClient,
  cwd: string,
  config: ToolConfig,
): Promise<ToolConfigWriteResult> {
  const existingRecords = await client.listToolConfigs(cwd, config.kind);
  const existingRecord = existingRecords.data.find((record) => {
    if (record.config.kind !== config.kind) {
      return false;
    }
    if (config.kind === "mcp") {
      return record.config.name === config.name;
    }
    return (
      record.config.path === config.path || record.config.name === config.name
    );
  });

  if (existingRecord) {
    try {
      const response = await client.updateToolConfig(
        cwd,
        existingRecord.filePath,
        config,
      );
      return { filePath: response.filePath, operation: "updated" };
    } catch (error) {
      if (!isUnsupportedRpcError(error)) {
        throw error;
      }
    }
  }

  const response = await client.saveToolConfig(cwd, config);
  return { filePath: response.filePath, operation: "created" };
}

export async function deleteMcpToolConfigRecord(
  client: AppServerClient,
  cwd: string,
  mcpServerName: string,
): Promise<string | null> {
  try {
    const records = await client.listToolConfigs(cwd, "mcp");
    const record = records.data.find(
      ({ config }) =>
        config.kind === "mcp" &&
        (config.name === mcpServerName || config.title === mcpServerName),
    );
    if (!record) {
      return null;
    }
    const response = await client.deleteToolConfig(cwd, record.filePath);
    return response.deleted ? record.filePath : null;
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return null;
  }
}

export async function loadToolLibraryItems(
  client: AppServerClient,
  cwd: string,
  locale: Locale,
): Promise<LibraryItem[]> {
  try {
    const response = await client.listToolConfigs(cwd);
    return toolConfigRecordsToLibraryItems(response.data, locale);
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return [];
  }
}

export async function loadAppToolLibraryItems(params: {
  client: AppServerClient | null;
  cwd: string;
  locale: Locale;
}): Promise<LibraryItem[]> {
  const { client, cwd, locale } = params;
  if (!client) {
    return [];
  }
  return loadToolLibraryItems(client, cwd, locale);
}

export async function refreshToolActionFromBackend(
  client: AppServerClient,
  cwd: string,
  action: McpDetailAction | SkillFileAction,
  locale: Locale,
): Promise<McpDetailAction | SkillFileAction> {
  try {
    const expectedKind = action.type === "mcp-detail" ? "mcp" : "skill";
    const directRecord = action.configPath
      ? await client
          .readToolConfig(cwd, action.configPath)
          .then((response) => response.record)
          .catch((error) => {
            if (isUnsupportedRpcError(error)) {
              return null;
            }
            throw error;
          })
      : null;
    let matchedRecord =
      directRecord?.kind === expectedKind ? directRecord : undefined;

    if (!matchedRecord) {
      const response = await client.listToolConfigs(cwd, expectedKind);
      matchedRecord = response.data.find((record) => {
        if (record.filePath === action.configPath) {
          return true;
        }
        if (action.type === "mcp-detail") {
          return (
            record.config.kind === "mcp" &&
            (record.config.name === action.configName ||
              record.config.name === action.subtitle ||
              record.config.title === action.title)
          );
        }
        return (
          record.config.kind === "skill" &&
          (record.config.path === action.path ||
            record.config.name === action.skillName)
        );
      });
    }
    if (!matchedRecord) {
      return action;
    }

    const refreshedAction = toolConfigRecordsToLibraryItems(
      [matchedRecord],
      locale,
    )[0]?.action;
    if (refreshedAction?.type !== action.type) {
      return action;
    }

    if (action.type === "mcp-detail") {
      const refreshedMcpAction = refreshedAction as McpDetailAction;
      return {
        ...action,
        ...refreshedMcpAction,
        authStatus: action.authStatus,
        configName: action.configName ?? refreshedMcpAction.subtitle,
        resource: action.resource,
        tool: action.tool,
      };
    }

    const refreshedSkillAction = refreshedAction as SkillFileAction;
    return {
      ...action,
      ...refreshedSkillAction,
    };
  } catch {
    return action;
  }
}

export async function refreshAppToolActionFromBackend(params: {
  client: AppServerClient | null;
  isConnected: boolean;
  action: McpDetailAction | SkillFileAction;
  locale: Locale;
  resolveBackendCwd: () => Promise<string | null>;
}): Promise<McpDetailAction | SkillFileAction> {
  const { client, isConnected, action, locale, resolveBackendCwd } = params;
  if (!isConnected || !client) {
    return action;
  }

  const cwd = await resolveBackendCwd();
  if (!cwd) {
    return action;
  }

  return refreshToolActionFromBackend(client, cwd, action, locale);
}

export async function syncSkillToolConfig(
  client: AppServerClient,
  cwd: string,
  action: LibraryPanelAction,
  enabled: boolean,
  locale: Locale,
): Promise<ToolConfigWriteResult | null> {
  const skillName = action.skillName?.trim();
  const skillPath = action.skillPath?.trim();
  if (!skillName && !skillPath) {
    return null;
  }

  if (action.skillConfigPath) {
    const record = await client
      .readToolConfig(cwd, action.skillConfigPath)
      .then((response) => response.record)
      .catch((error) => {
        if (isUnsupportedRpcError(error)) {
          return null;
        }
        throw error;
      });
    if (record?.config.kind === "skill") {
      try {
        const response = await client.updateToolConfig(
          cwd,
          action.skillConfigPath,
          { ...record.config, enabled },
        );
        return { filePath: response.filePath, operation: "updated" };
      } catch (error) {
        if (!isUnsupportedRpcError(error)) {
          throw error;
        }
      }
    }
  }

  const fallbackName = pathBaseName(skillPath ?? "skill");
  return saveOrUpdateToolConfig(client, cwd, {
    kind: "skill",
    title: skillName || fallbackName,
    name: skillName || fallbackName,
    description:
      locale === "zh"
        ? "从 Crewon UI 同步的 Skill 工具记录。"
        : "Skill tool record synced from the Crewon UI.",
    path: skillPath,
    enabled,
  });
}
