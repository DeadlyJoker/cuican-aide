import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { CommandScene } from "../../lib/scene/sceneCatalog";
import type { PaletteItemWithCommand } from "./CommandWorkspaceChrome";
import type {
  AgentPlatformComposerResource,
  SlotItem,
} from "./commandWorkspaceState";

type PlatformAgent = AgentPlatformSnapshot["agents"][number];
type PlatformKnowledgeBase = AgentPlatformSnapshot["knowledgeBases"][number];
type PlatformMcpServer = AgentPlatformSnapshot["mcpServers"][number];
type PlatformSkill = AgentPlatformSnapshot["skills"][number];
type PlatformWorkflow = AgentPlatformSnapshot["workflows"][number];

function explicitlyEnabled(value: unknown): boolean {
  return value === true || value === 1;
}

function isLocalResource(resource: { resource_source?: string }): boolean {
  return resource.resource_source === "local";
}

function isUsableAgent(agent: PlatformAgent): boolean {
  return (
    explicitlyEnabled(agent.is_active) && explicitlyEnabled(agent.api_enabled)
  );
}

function isUsableSkill(skill: PlatformSkill): boolean {
  return explicitlyEnabled(skill.is_enabled ?? skill.enabled);
}

function isUsableMcpServer(
  server: PlatformMcpServer,
  snapshot: AgentPlatformSnapshot,
): boolean {
  return (
    explicitlyEnabled(server.is_enabled) &&
    explicitlyEnabled(server.is_connected) &&
    resourceHasOnlineAgent(snapshot, platformMcpResource(server))
  );
}

function isUsableKnowledgeBase(knowledgeBase: PlatformKnowledgeBase): boolean {
  return (
    typeof knowledgeBase.document_count === "number" &&
    knowledgeBase.document_count > 0
  );
}

function isUsableWorkflow(workflow: PlatformWorkflow): boolean {
  return isLocalResource(workflow) && explicitlyEnabled(workflow.is_active);
}

function platformSkillResource(
  skill: PlatformSkill,
): AgentPlatformComposerResource {
  return {
    execution: "remote",
    id: skill.id,
    name: skill.name,
    type: "skills",
  };
}

function platformMcpResource(
  server: PlatformMcpServer,
): AgentPlatformComposerResource {
  return {
    execution: "remote",
    id: server.id,
    name: server.name,
    type: "mcp_servers",
  };
}

function platformKnowledgeResource(
  knowledgeBase: PlatformKnowledgeBase,
): AgentPlatformComposerResource {
  return {
    execution: "remote",
    id: knowledgeBase.id,
    name: knowledgeBase.name,
    type: "knowledge_bases",
  };
}

function hasNumericBinding(
  ids: readonly number[] | null | undefined,
  resourceId: number,
): boolean {
  return (
    ids?.some((id) => typeof id === "number" && id === resourceId) ?? false
  );
}

function mcpBindingMatches(
  binding: NonNullable<PlatformAgent["mcp_servers"]>[number],
  resource: AgentPlatformComposerResource,
): boolean {
  if (typeof binding === "number") {
    return binding === resource.id;
  }
  if (typeof binding === "string") {
    const value = binding.trim();
    const numericId = Number(value);
    return (
      value === resource.name ||
      (Number.isInteger(numericId) && numericId === resource.id)
    );
  }
  return binding.enabled !== false && binding.server_id === resource.id;
}

function agentSupportsResource(
  agent: PlatformAgent,
  resource: AgentPlatformComposerResource,
): boolean {
  switch (resource.type) {
    case "skills":
      return hasNumericBinding(agent.skill_ids, resource.id);
    case "knowledge_bases":
      return hasNumericBinding(agent.knowledge_base_ids, resource.id);
    case "mcp_servers":
      return (
        agent.mcp_servers?.some((binding) =>
          mcpBindingMatches(binding, resource),
        ) ?? false
      );
  }
}

function currentAgentNumericId(
  currentAgentId: number | null | undefined,
): number | null {
  return typeof currentAgentId === "number" && Number.isInteger(currentAgentId)
    ? currentAgentId
    : null;
}

export function findCompatibleOnlineAgent(
  snapshot: AgentPlatformSnapshot,
  selectedResources: readonly AgentPlatformComposerResource[],
  currentAgentId?: number | null,
): PlatformAgent | null {
  const supportsAll = (agent: PlatformAgent) =>
    selectedResources.every((resource) =>
      agentSupportsResource(agent, resource),
    );
  const usableAgents = snapshot.agents.filter(isUsableAgent);
  const preferredId = currentAgentNumericId(currentAgentId);
  const preferred = usableAgents.find(
    (agent) => agent.id === preferredId && supportsAll(agent),
  );
  return preferred ?? usableAgents.find(supportsAll) ?? null;
}

function resourceHasOnlineAgent(
  snapshot: AgentPlatformSnapshot,
  resource: AgentPlatformComposerResource,
): boolean {
  return findCompatibleOnlineAgent(snapshot, [resource]) !== null;
}

function workspaceName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

export function commandSceneContextItems(
  scene: CommandScene,
  snapshot: AgentPlatformSnapshot,
  cwd: string,
): PaletteItemWithCommand[] {
  const workspaceItem: PaletteItemWithCommand = {
    kind: scene === "code" ? "file" : "workspace",
    label: scene === "code" ? "代码工作区" : "工作空间",
    title: workspaceName(cwd || "workspace"),
    detail: cwd || "当前没有绑定工作空间",
  };
  const knowledgeItems = snapshot.knowledgeBases
    .filter(
      (item) =>
        isUsableKnowledgeBase(item) &&
        resourceHasOnlineAgent(snapshot, platformKnowledgeResource(item)),
    )
    .slice(0, 3)
    .map((item) => ({
      detail: `${item.document_count} 个文档 · ${item.description || "可引用知识"}`,
      kind: "knowledge" as const,
      label: scene === "design" ? "品牌 / Brief" : "知识库",
      platformResource: platformKnowledgeResource(item),
      title: item.name,
    }));
  const workflowItems = snapshot.workflows
    .filter(isUsableWorkflow)
    .slice(0, 2)
    .map((item) => ({
      detail: item.description || "可引用的项目流程与验收上下文",
      kind: "workflow" as const,
      label: scene === "office" ? "协作流程" : "项目上下文",
      title: item.name,
    }));

  switch (scene) {
    case "office":
      return [...knowledgeItems, ...workflowItems, workspaceItem].slice(0, 6);
    case "code":
      return [workspaceItem, ...workflowItems, ...knowledgeItems].slice(0, 6);
    case "design":
      return [...knowledgeItems, workspaceItem, ...workflowItems].slice(0, 6);
  }
}

export function commandSceneSlashItems(
  snapshot: AgentPlatformSnapshot,
  slashCommands: ComposerSlashCommand[],
): PaletteItemWithCommand[] {
  const commandItems: PaletteItemWithCommand[] = slashCommands.map(
    (command) => ({
      command,
      detail: command.description,
      kind:
        command.kind === "mcp"
          ? "mcp"
          : command.kind === "skill"
            ? "skill"
            : "agent",
      label: command.meta,
      title: command.label,
      token: command.token,
    }),
  );
  const platformItems: PaletteItemWithCommand[] = [
    ...snapshot.skills
      .filter(
        (item) =>
          isUsableSkill(item) &&
          resourceHasOnlineAgent(snapshot, platformSkillResource(item)),
      )
      .map((item) => ({
        detail: item.description || "在线 Agent 已绑定 Skill",
        kind: "skill" as const,
        label: "Skill",
        platformResource: platformSkillResource(item),
        title: item.name,
        token: item.name,
      })),
    ...snapshot.mcpServers
      .filter((item) => isUsableMcpServer(item, snapshot))
      .map((item) => ({
        detail:
          item.description || item.endpoint || "在线 Agent 已绑定 MCP 服务",
        kind: "mcp" as const,
        label: "MCP",
        platformResource: platformMcpResource(item),
        title: item.alias || item.name,
        token: item.alias || item.name,
      })),
  ];
  const maxItems = 12;
  const requiredPlatformItems = [
    platformItems.find((item) => item.kind === "skill"),
    platformItems.find((item) => item.kind === "mcp"),
  ].filter((item): item is PaletteItemWithCommand => item !== undefined);
  const visibleCommandItems = commandItems.slice(
    0,
    maxItems - requiredPlatformItems.length,
  );
  const visiblePlatformItems = platformItems.slice(
    0,
    maxItems - visibleCommandItems.length,
  );
  for (const requiredItem of requiredPlatformItems) {
    if (visiblePlatformItems.includes(requiredItem)) continue;
    for (let index = visiblePlatformItems.length - 1; index >= 0; index -= 1) {
      if (!requiredPlatformItems.includes(visiblePlatformItems[index])) {
        visiblePlatformItems[index] = requiredItem;
        break;
      }
    }
  }
  return [...visibleCommandItems, ...visiblePlatformItems];
}

export function commandSceneResourceDockItems(
  snapshot: AgentPlatformSnapshot,
): SlotItem[] {
  const agent = snapshot.agents.find(isUsableAgent);
  const skill = snapshot.skills.find(
    (item) =>
      isUsableSkill(item) &&
      resourceHasOnlineAgent(snapshot, platformSkillResource(item)),
  );
  const mcp = snapshot.mcpServers.find((item) =>
    isUsableMcpServer(item, snapshot),
  );
  const knowledge = snapshot.knowledgeBases.find(
    (item) =>
      isUsableKnowledgeBase(item) &&
      resourceHasOnlineAgent(snapshot, platformKnowledgeResource(item)),
  );
  const workflow = snapshot.workflows.find(isUsableWorkflow);
  return [
    agent && {
      detail: agent.description || "已开放 Open API 的在线 Agent",
      label: "Agent",
      title: agent.name,
      value: `agent-${agent.id}`,
    },
    skill && {
      detail: skill.description || "在线 Agent 已绑定 Skill",
      label: "Skill",
      title: skill.name,
      value: `skill-${skill.id}`,
    },
    mcp && {
      detail: mcp.description || mcp.endpoint || "在线 Agent 已绑定 MCP 服务",
      label: "MCP",
      title: mcp.alias || mcp.name,
      value: `mcp-${mcp.id}`,
    },
    knowledge && {
      detail: `${knowledge.document_count ?? 0} 个文档`,
      label: "Knowledge",
      title: knowledge.name,
      value: `knowledge-${knowledge.id}`,
    },
    workflow && {
      detail: workflow.description || "已同步的工作流定义",
      label: "Workflow",
      title: workflow.name,
      value: `workflow-${workflow.id}`,
    },
  ].filter((item): item is SlotItem => Boolean(item));
}
