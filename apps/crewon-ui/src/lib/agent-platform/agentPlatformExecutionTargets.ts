import type { ExecutionTargetOption } from "../scene/sceneCatalog";
import type {
  AgentPlatformSnapshot,
  PlatformAgent,
} from "./agentPlatformClient";

const agentPlatformTargetPrefix = "agent:agent-platform:";

export function agentPlatformExecutionTargetOptions(
  snapshot: AgentPlatformSnapshot,
  persistedAgents: Array<{ config: { agentId?: string } }>,
): ExecutionTargetOption[] {
  const persistedIds = new Set(
    persistedAgents
      .map((record) => record.config.agentId?.trim())
      .filter((agentId): agentId is string => Boolean(agentId)),
  );
  return snapshot.agents
    .filter(isRunnablePlatformAgent)
    .filter((agent) => !persistedIds.has(agentPlatformAgentId(agent.id)))
    .map((agent) => ({
      detail: agent.description?.trim() || "已同步的云智能体配置",
      kind: "agent" as const,
      label: `${agent.name} · 云智能体`,
      strategy: "single" as const,
      value: agentPlatformExecutionTargetValue(agent.id),
    }));
}

export function platformAgentForExecutionTarget(
  snapshot: AgentPlatformSnapshot,
  target: string,
): PlatformAgent | null {
  const id = platformAgentIdForExecutionTarget(target);
  return id === null
    ? null
    : (snapshot.agents.find((agent) => agent.id === id) ?? null);
}

export function agentPlatformExecutionTargetValue(agentId: number): string {
  return `${agentPlatformTargetPrefix}${agentId}`;
}

function platformAgentIdForExecutionTarget(target: string): number | null {
  if (!target.startsWith(agentPlatformTargetPrefix)) {
    return null;
  }
  const id = Number(target.slice(agentPlatformTargetPrefix.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function agentPlatformAgentId(agentId: number): string {
  return `agent-platform:${agentId}`;
}

function isRunnablePlatformAgent(agent: PlatformAgent): boolean {
  return agent.is_active !== false && agent.is_active !== 0;
}
