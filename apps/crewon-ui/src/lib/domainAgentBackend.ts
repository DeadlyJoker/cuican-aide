import {
  AppServerRpcError,
  type AppServerClient,
} from "./appServer";
import type { AgentConfig, LibraryItem } from "./crewonDomain";
import { agentConfigRecordsToLibraryItems } from "./domainLibraryItems";
import {
  type AgentConfigWriteResult,
  writeAgentConfigFile as writeStoredAgentConfigFile,
} from "./domainPersistence";
import type { Locale } from "./i18n";

export async function writeAgentConfig(
  client: AppServerClient,
  cwd: string,
  config: AgentConfig,
): Promise<AgentConfigWriteResult> {
  const existing = await client.readAgentConfig(cwd, {
    agentId: config.agentId ?? null,
    threadId: config.threadId ?? null,
    name: config.name,
  });
  if (existing.record) {
    return client.updateAgentConfig(cwd, existing.record.filePath, config);
  }
  return writeStoredAgentConfigFile(client, cwd, config);
}

export async function loadAgentLibraryItems(
  client: AppServerClient,
  cwd: string,
  locale: Locale,
): Promise<{ items: LibraryItem[] }> {
  try {
    const response = await client.listAgentConfigs(cwd);
    return {
      items: agentConfigRecordsToLibraryItems(response.data, locale),
    };
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
    return { items: [] };
  }
}

function isUnsupportedRpcError(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.code === -32601;
}
