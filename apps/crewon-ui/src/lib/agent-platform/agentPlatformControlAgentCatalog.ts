import type { AgentVersionView } from "@crewon/contracts";

import type { ControlAgentCatalogAdapter } from "../office/controlAgentCatalog";
import type { PlatformAgent } from "./agentPlatformClient";

const PLATFORM_AGENT_VERSION_ID = /^agent-platform:(\d+)(?::[a-f0-9]{32})?$/u;

/** Presents active cloud Agent versions with their Agent Platform names. */
export function agentPlatformControlAgentCatalogAdapter(
  agents: readonly PlatformAgent[],
): ControlAgentCatalogAdapter {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  return {
    id: "agent-platform",
    matches: (version) => platformAgentId(version) !== null,
    presentation: (version, locale) => {
      const id = platformAgentId(version);
      const agent = id === null ? undefined : agentsById.get(id);
      return {
        accent: "violet",
        glyph: "A",
        name:
          agent?.name.trim() ||
          (locale === "zh" ? `云智能体 ${id}` : `Cloud Agent ${id}`),
        role:
          locale === "zh"
            ? `云端可用 · ${version.model.modelId}`
            : `Ready in cloud · ${version.model.modelId}`,
      };
    },
  };
}

function platformAgentId(version: AgentVersionView): number | null {
  const match = PLATFORM_AGENT_VERSION_ID.exec(version.agentVersionId);
  if (match?.[1] === undefined) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}
