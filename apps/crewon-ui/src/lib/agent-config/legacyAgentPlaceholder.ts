import type { AgentConfig } from "../domain/crewonDomain";

const LEGACY_AGENT_SIGNATURES = [
  {
    name: "新智能体",
    role: "后端能力智能体 · 可招募",
    systemPrompt:
      "你是办公室中的自定义智能体。你的模型、权限、MCP 和 Skill 来自当前 app-server。先理解目标，再列出计划，必要时调用已授权工具，并把结果沉淀为可复用交付物。",
  },
  {
    name: "New Agent",
    role: "Backend-capable agent · recruitable",
    systemPrompt:
      "You are a custom agent in an office. Your model, permission profile, MCP connectors, and skills come from the current app-server. Understand the goal, outline a plan, use authorized tools when needed, and turn results into reusable deliverables.",
  },
] as const;

/**
 * Recognizes records persisted by the removed Agent quick-create flow before
 * the user supplied an identity. Matching the full generated signature keeps
 * similarly named, intentionally configured agents visible.
 */
export function isLegacyGeneratedAgentPlaceholder(
  config: Pick<AgentConfig, "name" | "role" | "systemPrompt">,
): boolean {
  return LEGACY_AGENT_SIGNATURES.some(
    (signature) =>
      config.name === signature.name &&
      config.role === signature.role &&
      config.systemPrompt === signature.systemPrompt,
  );
}
