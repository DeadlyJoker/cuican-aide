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
    .filter((agent) => !isPersisted(persistedIds, agent.id))
    .map((agent) => ({
      detail: agent.description?.trim() || "已同步的云智能体配置",
      // A cloud agent still runs as one agent, so it shares the single-agent
      // section and carries no suffix of its own.
      group: "single" as const,
      kind: "agent" as const,
      label: agent.name,
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

/*
 * Two key shapes exist in the wild. The Agents page writes the resource id
 * `agent-platform:agents:<id>`, but older configs on disk carry a bare
 * `agent-platform:<id>`. Matching only one shape leaves the other half of the
 * saved agents undeduped, so the selector lists them twice: once from the
 * persisted config and once from the live snapshot.
 */
function isPersisted(persistedIds: Set<string>, agentId: number): boolean {
  return (
    persistedIds.has(`agent-platform:agents:${agentId}`) ||
    persistedIds.has(`agent-platform:${agentId}`)
  );
}

function isRunnablePlatformAgent(agent: PlatformAgent): boolean {
  return agent.is_active !== false && agent.is_active !== 0;
}
