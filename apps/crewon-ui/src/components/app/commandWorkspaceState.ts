import type {
  AgentPlatformResourceCategory,
  AgentPlatformResourceState,
  AgentPlatformResourceStates,
  AgentPlatformSnapshot,
} from "../../lib/agent-platform/agentPlatformClient";
import type { CommandScene } from "../../lib/scene/sceneCatalog";

export type { CommandScene } from "../../lib/scene/sceneCatalog";

export type CommandShellView =
  | "command"
  | "assist"
  | "projects"
  | "agents"
  | "knowledge"
  | "schedule"
  | "team";

export type CommandComposerMode = "plan" | "goal" | "agent";
export type CommandPaletteKind =
  | "agent"
  | "conversation"
  | "file"
  | "knowledge"
  | "mcp"
  | "project"
  | "skill"
  | "workflow"
  | "workspace";

export type AgentPlatformComposerResource = {
  execution: "local" | "remote";
  id: number;
  name: string;
  type: "skills" | "mcp_servers" | "knowledge_bases";
};

export type SlotItem = {
  label: string;
  title: string;
  detail: string;
  value: string;
};

export type CommandHomeSlots = {
  agent: SlotItem;
  workflow: SlotItem;
  knowledge: SlotItem;
  skills: [SlotItem, SlotItem];
  mcps: [SlotItem, SlotItem];
  model: string;
};

export type CommandPaletteItem = {
  detail: string;
  kind: CommandPaletteKind;
  label: string;
  platformResource?: AgentPlatformComposerResource;
  title: string;
  token?: string;
};

export const agentPlatformResourceCategories = [
  "agents",
  "skills",
  "mcp",
  "knowledge",
] as const satisfies readonly AgentPlatformResourceCategory[];

export function createAgentPlatformResourceStates(
  status: AgentPlatformResourceState["status"],
  error: string | null = null,
): AgentPlatformResourceStates {
  return {
    agents: { status, error },
    skills: { status, error },
    mcp: { status, error },
    knowledge: { status, error },
  };
}

export function agentPlatformResourceStates(
  snapshot: AgentPlatformSnapshot,
): AgentPlatformResourceStates {
  return snapshot.resourceStates ?? createAgentPlatformResourceStates("ready");
}

export const emptyAgentPlatformSnapshot: AgentPlatformSnapshot = {
  agents: [],
  knowledgeBases: [],
  skills: [],
  mcpServers: [],
  mcpTools: [],
  workflows: [],
  resourceStates: createAgentPlatformResourceStates("loading"),
};

export function setAgentPlatformResourceState(
  snapshot: AgentPlatformSnapshot,
  categories: readonly AgentPlatformResourceCategory[],
  state: AgentPlatformResourceState,
): AgentPlatformSnapshot {
  const nextStates = { ...agentPlatformResourceStates(snapshot) };
  for (const category of categories) {
    nextStates[category] = state;
  }
  return { ...snapshot, resourceStates: nextStates };
}

export function mergeAgentPlatformSnapshot(
  current: AgentPlatformSnapshot,
  incoming: AgentPlatformSnapshot,
  categories: readonly AgentPlatformResourceCategory[] = agentPlatformResourceCategories,
): AgentPlatformSnapshot {
  const selected = new Set(categories);
  const incomingStates = agentPlatformResourceStates(incoming);
  const nextStates = {
    ...agentPlatformResourceStates(current),
  };
  const next: AgentPlatformSnapshot = {
    ...current,
    resourceStates: nextStates,
  };

  for (const category of categories) {
    nextStates[category] = incomingStates[category];
    if (incomingStates[category].status !== "ready") {
      continue;
    }
    if (category === "agents") {
      next.agents = incoming.agents;
    } else if (category === "skills") {
      next.skills = incoming.skills;
    } else if (category === "mcp") {
      next.mcpServers = incoming.mcpServers;
      next.mcpTools = incoming.mcpTools;
    } else {
      next.knowledgeBases = incoming.knowledgeBases;
    }
  }

  if (selected.size === agentPlatformResourceCategories.length) {
    next.workflows = incoming.workflows;
  }
  return next;
}

export function insertTokenIntoComposerValue({
  prefix,
  token,
  value,
}: {
  prefix: "@" | "/";
  token: string;
  value: string;
}): string {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    return value;
  }

  const separator = value.trim() ? " " : "";
  const tokenText =
    prefix === "/" && trimmedToken.startsWith("$")
      ? trimmedToken
      : `${prefix}${trimmedToken}`;
  return `${value}${separator}${tokenText} `;
}

export function selectCommandHomeSlots(
  snapshot: AgentPlatformSnapshot,
): CommandHomeSlots {
  const accountAgents = snapshot.agents.filter(
    (item) => item.resource_source !== "catalog",
  );
  const accountKnowledge = snapshot.knowledgeBases.filter(
    (item) => item.resource_source !== "catalog",
  );
  const accountSkills = snapshot.skills.filter(
    (item) => item.resource_source !== "catalog",
  );
  const accountMcpServers = snapshot.mcpServers.filter(
    (item) => item.resource_source !== "catalog",
  );
  const agent =
    accountAgents.find(
      (item) =>
        item.is_active !== false &&
        item.is_active !== 0 &&
        ((item.skill_ids?.length ?? 0) > 0 ||
          (item.mcp_servers?.length ?? 0) > 0 ||
          (item.knowledge_base_ids?.length ?? 0) > 0),
    ) ??
    accountAgents.find(
      (item) => item.is_active !== false && item.is_active !== 0,
    ) ??
    accountAgents[0];
  const workflow =
    findByKeyword(snapshot.workflows, [
      "gate",
      "审批",
      "交付",
      "测试",
      "验收",
    ]) ?? snapshot.workflows[0];
  const knowledge = accountKnowledge[0];
  const skillA =
    findByKeyword(accountSkills, [
      "schema",
      "校验",
      "审阅",
      "交付",
      "检查",
    ]) ?? accountSkills[0];
  const skillB =
    accountSkills.find((item) => item.id !== skillA?.id) ?? accountSkills[1];
  const mcpA =
    findByKeyword(accountMcpServers, [
      "filesystem",
      "文件",
      "github",
      "screenshot",
      "browser",
    ]) ?? accountMcpServers[0];
  const mcpB =
    accountMcpServers.find((item) => item.id !== mcpA?.id) ??
    accountMcpServers[1];

  return {
    agent: {
      label: "Agent",
      title: cleanSlotTitle(agent?.name, "产品审阅智能体"),
      detail: agent?.description || "引用左侧智能体配置与权限边界",
      value: agent ? `agent-${agent.id}` : "agent-product-review",
    },
    workflow: {
      label: "Workflow",
      title: cleanSlotTitle(workflow?.name, "项目交付清单"),
      detail: workflow?.description || "验收点、负责人和风险记录",
      value: workflow ? `workflow-${workflow.id}` : "workflow-delivery",
    },
    knowledge: {
      label: "空间",
      title: cleanSlotTitle(knowledge?.name, "Agent 小队交付空间"),
      detail: knowledge
        ? `${knowledge.document_count ?? 0} 个文档 · ${
            knowledge.embedding_model ?? "embedding"
          }`
        : "默认创建新小队任务的位置",
      value: knowledge ? `knowledge-${knowledge.id}` : "knowledge-fallback",
    },
    skills: [
      {
        label: "Skill",
        title: cleanSlotTitle(skillA?.name, "页面审阅 Skill"),
        detail: skillA?.description || "检查层级、文案、交互和验收点",
        value: skillA ? `skill-${skillA.id}` : "skill-review",
      },
      {
        label: "Skill",
        title: cleanSlotTitle(skillB?.name, "交付检查 Skill"),
        detail: skillB?.description || "生成测试点、风险和上线清单",
        value: skillB ? `skill-${skillB.id}` : "skill-delivery",
      },
    ],
    mcps: [
      {
        label: "MCP",
        title: cleanSlotTitle(mcpA?.alias || mcpA?.name, "Filesystem MCP"),
        detail: mcpA?.description || mcpA?.endpoint || "读取和写入当前项目文件",
        value: mcpA ? `mcp-${mcpA.id}` : "mcp-filesystem",
      },
      {
        label: "MCP",
        title: cleanSlotTitle(mcpB?.alias || mcpB?.name, "Screenshot MCP"),
        detail: mcpB?.description || mcpB?.endpoint || "渲染页面并做视觉核验",
        value: mcpB ? `mcp-${mcpB.id}` : "mcp-screenshot",
      },
    ],
    model:
      agent?.model_info?.model_name ||
      agent?.model_info?.name ||
      "agent-platform local",
  };
}

export function cleanSlotTitle(
  value: string | null | undefined,
  fallback: string,
): string {
  const title = value?.trim();
  if (!title) {
    return fallback;
  }
  const normalized = title.replace(/\s+/g, "");
  const isNumeric = /^\d+$/.test(normalized);
  const lower = normalized.toLowerCase();
  const isTestLike =
    ["test", "demo", "样例", "示例"].includes(lower) ||
    normalized.startsWith("测试") ||
    lower.startsWith("test");
  if (isNumeric || isTestLike) {
    return fallback;
  }
  const technicalTitleMap: Record<string, string> = {
    "filesystem": "Filesystem MCP",
    "file-system": "Filesystem MCP",
    "http": "HTTP Tools",
    "http-tools": "HTTP Tools",
  };
  return technicalTitleMap[lower] ?? title;
}

function findByKeyword<T extends { name: string; description?: string | null }>(
  items: T[],
  keywords: string[],
): T | undefined {
  return items.find((item) => {
    const text = `${item.name} ${item.description ?? ""}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
  });
}

function activeFilters(scope: HTMLElement) {
  return Array.from(
    scope.querySelectorAll<HTMLElement>(".filter-chip[data-filter].active"),
  )
    .map((chip) => chip.dataset.filter)
    .filter((filter): filter is string => Boolean(filter) && filter !== "all");
}

export function applyDesignCardVisibility(scope: HTMLElement) {
  const filters = activeFilters(scope);
  const search = scope.querySelector<HTMLInputElement>(".catalog-search input");
  const query = (search?.value ?? "").trim().toLowerCase();
  const cards = Array.from(
    scope.querySelectorAll<HTMLElement>("[data-card-filter]"),
  );
  let visibleCount = 0;

  for (const card of cards) {
    const values = (card.dataset.cardFilter ?? "").split(/\s+/).filter(Boolean);
    const matchesFilter = filters.every((filter) => values.includes(filter));
    const matchesSearch =
      !query ||
      (card.innerText || card.textContent || "").toLowerCase().includes(query);
    const visible = matchesFilter && matchesSearch;
    card.classList.toggle("hidden", !visible);
    card.hidden = !visible;
    if (visible) {
      visibleCount += 1;
    }
  }

  const empty = scope.querySelector<HTMLElement>("[data-filter-empty]");
  if (empty && cards.length > 0) {
    empty.hidden = visibleCount > 0;
    empty.classList.toggle("visible", visibleCount === 0);
  }
}

export function syncDesignFilterState(scope: HTMLElement) {
  scope
    .querySelectorAll<HTMLElement>(".filter-chip[data-filter]")
    .forEach((chip) => {
      chip.setAttribute(
        "aria-pressed",
        chip.classList.contains("active") ? "true" : "false",
      );
    });
  scope
    .querySelectorAll<HTMLElement>("[data-team-action]")
    .forEach((button) => {
      const mode =
        scope.querySelector<HTMLElement>(
          '.filter-chip.active[data-filter-group="team-mode"]',
        )?.dataset.filter ?? "office";
      button.hidden = button.dataset.teamAction !== mode;
    });
  applyDesignCardVisibility(scope);
}

function filterScopeFor(target: Element) {
  return (
    target.closest<HTMLElement>("[data-filter-scope]") ??
    target.closest<HTMLElement>("[data-shell-view]") ??
    target.closest<HTMLElement>(".page-stack")
  );
}

export function setActiveFilter(
  scope: HTMLElement,
  group: string,
  filter: string,
) {
  const selector =
    group === "default"
      ? ".filter-chip[data-filter]:not([data-filter-group])"
      : `.filter-chip[data-filter][data-filter-group="${group}"]`;
  const chips = Array.from(scope.querySelectorAll<HTMLElement>(selector));
  for (const chip of chips) {
    chip.classList.toggle("active", chip.dataset.filter === filter);
  }
  syncDesignFilterState(scope);
}

function closeTeamInlineRooms(view: HTMLElement) {
  const officeRoom = view.querySelector<HTMLElement>("[data-office-room]");
  const officeList = view.querySelector<HTMLElement>("[data-office-list]");
  const officeShell = view.querySelector<HTMLElement>("[data-office-shell]");
  const workflowRoom = view.querySelector<HTMLElement>("[data-workflow-room]");
  const workflowList = view.querySelector<HTMLElement>("[data-workflow-list]");
  const workflowShell = view.querySelector<HTMLElement>(
    "[data-workflow-shell]",
  );
  if (officeRoom) {
    officeRoom.hidden = true;
  }
  if (officeList) {
    officeList.hidden = false;
  }
  if (workflowRoom) {
    workflowRoom.hidden = true;
  }
  if (workflowList) {
    workflowList.hidden = false;
  }
  officeShell?.classList.remove("is-room-open");
  workflowShell?.classList.remove("is-room-open");
  view.classList.remove("office-room-active", "workflow-room-active");
  view
    .querySelectorAll<HTMLElement>(
      "[data-office-drawer], [data-workflow-drawer]",
    )
    .forEach((drawer) => {
      drawer.hidden = true;
    });
  view
    .querySelectorAll<HTMLElement>(
      "[data-office-drawer-open], [data-workflow-drawer-open]",
    )
    .forEach((button) => {
      button.setAttribute("aria-expanded", "false");
    });
}

export function setDefaultTeamOfficePreview(view: HTMLElement) {
  const scope = filterScopeFor(view) ?? view;
  setActiveFilter(scope, "team-mode", "office");
  closeTeamInlineRooms(view);
}

export function activateDesignPanelTab(
  panelTab: HTMLElement,
  root: HTMLElement,
) {
  const target = panelTab.dataset.tabTarget;
  if (!target) {
    return;
  }
  const scope = panelTab.closest<HTMLElement>("[data-tab-scope]") ?? root;
  scope.querySelectorAll<HTMLElement>("[data-tab-target]").forEach((item) => {
    const active = item === panelTab;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", active ? "true" : "false");
    item.setAttribute("aria-selected", active ? "true" : "false");
  });
  scope.querySelectorAll<HTMLElement>("[data-tab-panel]").forEach((panel) => {
    panel.hidden = `#${panel.id}` !== target;
  });
}
