import { AppServerRpcError, type AppServerClient } from "./appServer";
import type { LibraryPanelAction, ToolConfig } from "./crewonDomain";
import type { Locale } from "./i18n";

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

function isUnsupportedRpcError(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.code === -32601;
}

function pathBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
