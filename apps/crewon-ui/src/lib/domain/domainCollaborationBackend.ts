import type { McpServerConfigRecord } from "@crewon/app-server-protocol/v2/McpServerConfigRecord";
import type { McpServerStatus } from "@crewon/app-server-protocol/v2/McpServerStatus";

import { isUnsupportedRpcError, type AppServerClient } from "../app-server/appServer";
import { isLegacyGeneratedAgentPlaceholder } from "../agent-config/legacyAgentPlaceholder";
import { withBackendWorkspace } from "../backend/backendWorkspace";
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
  return (await listRecruitableAgentConfigs(client, cwd, existingMembers))[0] ?? null;
}

export async function listRecruitableAgentConfigs(
  client: AppServerClient,
  cwd: string,
  existingMembers: OfficeMember[],
): Promise<AgentConfig[]> {
  const memberNames = new Set(existingMembers.map((member) => member.name));
  const memberAgentIds = new Set(
    existingMembers
      .map((member) => member.agentId)
      .filter((agentId): agentId is string => Boolean(agentId)),
  );
  const identityUpgradeAgentIds = new Set(
    existingMembers.flatMap((member) => {
      const agentId = member.agentId?.trim();
      return agentId && !member.memberId?.trim() ? [agentId] : [];
    }),
  );

  try {
    const response = await client.listRecruitableAgentConfigs(cwd, {
      cursor: null,
      existingAgentIds: [...memberAgentIds],
      existingNames: [...memberNames],
      limit: 24,
    });
    const recruitable = response.data
      .map((record) => record.config)
      .filter((config) => !isLegacyGeneratedAgentPlaceholder(config))
      .filter((config): config is AgentConfig & { agentId: string } =>
        Boolean(config.agentId),
      );
    if (identityUpgradeAgentIds.size === 0) {
      return recruitable;
    }
    try {
      const allAgents = await client.listAgentConfigs(cwd);
      const upgrades = allAgents.data
        .map((record) => record.config)
        .filter((config) => !isLegacyGeneratedAgentPlaceholder(config))
        .filter(
          (config): config is AgentConfig & { agentId: string } =>
            Boolean(
              config.agentId && identityUpgradeAgentIds.has(config.agentId),
            ),
        );
      return mergeAgentConfigs(upgrades, recruitable);
    } catch {
      return recruitable;
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
      .filter((config) => !isLegacyGeneratedAgentPlaceholder(config))
      .filter((config): config is AgentConfig & { agentId: string } =>
        Boolean(config.agentId),
      );
    return candidates.filter((config) => {
      if (identityUpgradeAgentIds.has(config.agentId)) {
        return true;
      }
      return (
        !memberNames.has(config.name) && !memberAgentIds.has(config.agentId)
      );
    });
  } catch (error) {
    if (!isUnsupportedRpcError(error)) {
      throw error;
    }
  }

  return [];
}

function mergeAgentConfigs(
  preferred: Array<AgentConfig & { agentId: string }>,
  fallback: Array<AgentConfig & { agentId: string }>,
): Array<AgentConfig & { agentId: string }> {
  const byAgentId = new Map<string, AgentConfig & { agentId: string }>();
  for (const config of [...preferred, ...fallback]) {
    if (!byAgentId.has(config.agentId)) {
      byAgentId.set(config.agentId, config);
    }
  }
  return [...byAgentId.values()];
}

export async function readAppRecruitableAgentConfig(params: {
  client: AppServerClient | null | undefined;
  existingMembers: OfficeMember[];
  isConnected: boolean;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AgentConfig | null> {
  if (!params.isConnected) {
    return null;
  }

  return withBackendWorkspace({
    client: params.client,
    fallback: null,
    resolveBackendCwd: params.resolveBackendCwd,
    run: ({ client, cwd }) =>
      readRecruitableAgentConfig(client, cwd, params.existingMembers),
  });
}

export async function listAppRecruitableAgentConfigs(params: {
  client: AppServerClient | null | undefined;
  existingMembers: OfficeMember[];
  isConnected: boolean;
  resolveBackendCwd: () => Promise<string>;
}): Promise<AgentConfig[]> {
  if (!params.isConnected) {
    return [];
  }

  return withBackendWorkspace({
    client: params.client,
    fallback: [],
    resolveBackendCwd: params.resolveBackendCwd,
    run: ({ client, cwd }) =>
      listRecruitableAgentConfigs(client, cwd, params.existingMembers),
  });
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

export async function readAppLatestOfficeConfig(params: {
  client: AppServerClient | null | undefined;
  isConnected: boolean;
  resolveBackendCwd: () => Promise<string>;
}): Promise<OfficeConfig | null> {
  if (!params.isConnected) {
    return null;
  }

  return withBackendWorkspace({
    client: params.client,
    fallback: null,
    resolveBackendCwd: params.resolveBackendCwd,
    run: ({ client, cwd }) => readLatestOfficeConfig(client, cwd),
  });
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
