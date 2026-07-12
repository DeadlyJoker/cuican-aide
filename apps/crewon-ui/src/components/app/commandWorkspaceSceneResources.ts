import type { AgentPlatformSnapshot } from "../../lib/agent-platform/agentPlatformClient";
import type { ComposerSlashCommand } from "../../lib/composer/composerSlashCommands";
import type { CommandScene } from "../../lib/scene/sceneCatalog";
import type { PaletteItemWithCommand } from "./CommandWorkspaceChrome";
import type { SlotItem } from "./commandWorkspaceState";

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
  const knowledgeItems = snapshot.knowledgeBases.slice(0, 3).map((item) => ({
    detail: `${item.document_count ?? 0} 个文档 · ${item.description || "可引用知识"}`,
    kind: "knowledge" as const,
    label: scene === "design" ? "品牌 / Brief" : "知识库",
    title: item.name,
  }));
  const workflowItems = snapshot.workflows.slice(0, 2).map((item) => ({
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
    ...snapshot.skills.map((item) => ({
      detail: item.description || "本地 Skill",
      kind: "skill" as const,
      label: "Skill",
      title: item.name,
      token: item.name,
    })),
    ...snapshot.mcpServers
      .filter(
        (item) => item.is_enabled !== false && item.is_connected !== false,
      )
      .map((item) => ({
        detail: item.description || item.endpoint || "本地 MCP 服务",
        kind: "mcp" as const,
        label: "MCP",
        title: item.alias || item.name,
        token: item.alias || item.name,
      })),
  ];
  return [...commandItems, ...platformItems].slice(0, 12);
}

export function commandSceneResourceDockItems(
  snapshot: AgentPlatformSnapshot,
): SlotItem[] {
  const agent = snapshot.agents.find(
    (item) => item.is_active !== false && item.is_active !== 0,
  );
  const skill = snapshot.skills[0];
  const mcp = snapshot.mcpServers.find(
    (item) => item.is_enabled !== false && item.is_connected !== false,
  );
  const knowledge = snapshot.knowledgeBases[0];
  const workflow = snapshot.workflows.find(
    (item) => item.is_active !== false && item.is_active !== 0,
  );
  return [
    agent && {
      detail: agent.description || "已同步的单 Agent 定义",
      label: "Agent",
      title: agent.name,
      value: `agent-${agent.id}`,
    },
    skill && {
      detail: skill.description || "已同步的本地 Skill",
      label: "Skill",
      title: skill.name,
      value: `skill-${skill.id}`,
    },
    mcp && {
      detail: mcp.description || mcp.endpoint || "已同步的 MCP 服务",
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
