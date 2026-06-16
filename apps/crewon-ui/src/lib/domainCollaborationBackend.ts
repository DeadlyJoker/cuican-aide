import type { McpServerConfigRecord } from "@crewon-protocol/v2/McpServerConfigRecord";
import type { McpServerStatus } from "@crewon-protocol/v2/McpServerStatus";

import { AppServerRpcError, type AppServerClient } from "./appServer";
import type { AgentConfig, OfficeConfig, OfficeMember } from "./crewonDomain";

export type McpInventoryServer = {
  config?: McpServerConfigRecord;
  name: string;
  status?: McpServerStatus;
};

export type McpInventory = {
  configs: McpServerConfigRecord[];
  servers: McpInventoryServer[];
  statuses: McpServerStatus[];
};

export async function loadMcpInventory(
  client: AppServerClient | null | undefined,
  effectiveThreadId: string | undefined,
  effectiveCwd: string | null | undefined,
): Promise<McpInventory> {
  const [statuses, configs] = await Promise.all([
    loadMcpRuntimeStatus(client, effectiveThreadId),
    loadMcpConfigRecords(client, effectiveCwd),
  ]);
  const byName = new Map<string, McpInventoryServer>();
  statuses.forEach((status) => {
    byName.set(status.name, { name: status.name, status });
  });
  configs.forEach((config) => {
    const existing = byName.get(config.name);
    byName.set(config.name, {
      name: config.name,
      status: existing?.status,
      config,
    });
  });

  return {
    statuses,
    configs,
    servers: [...byName.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}

export async function readRecruitableAgentConfig(
  client: AppServerClient,
  cwd: string,
  existingMembers: OfficeMember[],
): Promise<AgentConfig | null> {
  const memberNames = new Set(existingMembers.map((member) => member.name));
  const memberAgentIds = new Set(
    existingMembers
      .map((member) => member.agentId)
      .filter((agentId): agentId is string => Boolean(agentId)),
  );

  try {
    const response = await client.listRecruitableAgentConfigs(cwd, {
      cursor: null,
      existingAgentIds: [...memberAgentIds],
      existingNames: [...memberNames],
      limit: 24,
    });
    const backendConfig = response.data.find((record) =>
      Boolean(record.config.agentId),
    )?.config;
    if (backendConfig) {
      return backendConfig;
    }
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
  }

  try {
    const response = await client.listAgentConfigs(cwd);
    const candidates = response.data
      .map((record) => record.config)
      .filter(
        (config): config is AgentConfig & { agentId: string } =>
          Boolean(config.agentId),
      );
    return (
      candidates.find(
        (config) =>
          !memberNames.has(config.name) && !memberAgentIds.has(config.agentId),
      ) ?? null
    );
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
  }

  return null;
}

export async function readLatestOfficeConfig(
  client: AppServerClient,
  cwd: string,
): Promise<OfficeConfig | null> {
  try {
    const response = await client.listOfficeConfigs(cwd);
    return (
      response.data
        .map((record) => ({
          updatedAt: record.savedAt ? new Date(record.savedAt).getTime() : 0,
          config: record.config,
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.config ??
      null
    );
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
  }

  return null;
}

async function loadMcpRuntimeStatus(
  client: AppServerClient | null | undefined,
  effectiveThreadId: string | undefined,
): Promise<McpServerStatus[]> {
  if (!client) {
    return [];
  }

  try {
    return (await client.listMcpServerStatus(effectiveThreadId, "full")).data;
  } catch (threadScopedError) {
    if (
      !(threadScopedError instanceof Error) ||
      !threadScopedError.message.includes("thread not found")
    ) {
      throw threadScopedError;
    }
    return (await client.listMcpServerStatus(undefined, "full")).data;
  }
}

async function loadMcpConfigRecords(
  client: AppServerClient | null | undefined,
  effectiveCwd: string | null | undefined,
): Promise<McpServerConfigRecord[]> {
  if (!client) {
    return [];
  }

  try {
    return (
      await client.listMcpServerConfigs({
        cwd: effectiveCwd ?? null,
        limit: 100,
      })
    ).data;
  } catch {
    return [];
  }
}

function isUnsupportedRpcError(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.code === -32601;
}
