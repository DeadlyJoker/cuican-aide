import type { AgentConfig } from "../../lib/domain/crewonDomain";
import {
  agentPlatformAgentToConfig,
  type AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";

export type DownloadedAgentSyncClient = {
  listAgentConfigs(cwd: string): Promise<{
    data: Array<{ config: AgentConfig; filePath: string }>;
  }>;
  saveAgentConfig(cwd: string, config: AgentConfig): Promise<unknown>;
};

export async function syncDownloadedAgentPlatformConfigs({
  client,
  cwd,
  snapshot,
}: {
  client: DownloadedAgentSyncClient;
  cwd: string;
  snapshot: AgentPlatformSnapshot;
}): Promise<number> {
  const downloaded = snapshot.agents.flatMap((agent, index) =>
    agent.downloaded
      ? [agentPlatformAgentToConfig(agent, snapshot, index)]
      : [],
  );
  if (downloaded.length === 0) {
    return 0;
  }

  const existing = await client.listAgentConfigs(cwd);
  const existingByAgentId = new Map(
    existing.data.flatMap(({ config }) =>
      config.agentId ? [[config.agentId, config] as const] : [],
    ),
  );
  let saved = 0;
  for (const downloadedConfig of downloaded) {
    const current = downloadedConfig.agentId
      ? existingByAgentId.get(downloadedConfig.agentId)
      : undefined;
    const nextConfig = current?.threadId
      ? { ...downloadedConfig, threadId: current.threadId }
      : downloadedConfig;
    if (current && stableJson(current) === stableJson(nextConfig)) {
      continue;
    }
    await client.saveAgentConfig(cwd, nextConfig);
    saved += 1;
  }
  return saved;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}
