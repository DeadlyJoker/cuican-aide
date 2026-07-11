import {
  MCP_GLYPHS,
  SKILL_GLYPHS,
  capabilityAccents,
} from "../agent-config/agentConfigDefaults";
import type {
  AgentCapabilityOption,
  AgentConfig,
  KnowledgeData,
  LibraryAccent,
  LibraryItem,
} from "../domain/crewonDomain";
import { promptPreview } from "../shared/text";

type PageResponse<T> = {
  items?: T[];
  total?: number;
};

type PlatformModelInfo = {
  model_name?: string | null;
  name?: string | null;
  provider?: string | null;
};

type PlatformAgent = {
  id: number;
  name: string;
  description?: string | null;
  system_prompt?: string | null;
  model_info?: PlatformModelInfo | null;
  knowledge_base_ids?: number[] | null;
  skill_ids?: number[] | null;
  mcp_servers?: string[] | null;
  config?: Record<string, unknown> | null;
  is_active?: boolean | number | null;
  api_enabled?: boolean | number | null;
  owner_username?: string | null;
  invocation_url?: string | null;
  downloaded?: boolean;
  downloaded_at?: string | null;
  update_available?: boolean;
  source_updated_at?: string | null;
};

type PlatformKnowledgeBase = {
  id: number;
  name: string;
  description?: string | null;
  document_count?: number | null;
  embedding_model?: string | null;
  chunk_size?: number | null;
  chunk_count?: number | null;
  owner_username?: string | null;
  downloaded?: boolean;
  downloaded_at?: string | null;
  update_available?: boolean;
  source_updated_at?: string | null;
};

type PlatformSkill = {
  id: number;
  name: string;
  description?: string | null;
  category?: string | null;
  version?: string | null;
  tags?: string[] | null;
  skill_md_content?: string | null;
  storage_path?: string | null;
  file_count?: number | null;
  has_scripts?: boolean | null;
  owner_username?: string | null;
  downloaded?: boolean;
  downloaded_at?: string | null;
  update_available?: boolean;
  source_updated_at?: string | null;
};

type PlatformMcpServer = {
  id: number;
  name: string;
  alias?: string | null;
  description?: string | null;
  endpoint?: string | null;
  category?: string | null;
  is_enabled?: boolean | null;
  is_connected?: boolean | null;
  call_count?: number | null;
  tool_count?: number | null;
  owner_username?: string | null;
  downloaded?: boolean;
  downloaded_at?: string | null;
  update_available?: boolean;
  source_updated_at?: string | null;
};

type PlatformMcpTool = {
  id: number;
  name: string;
  alias?: string | null;
  description?: string | null;
  intro?: string | null;
  category?: string | null;
  version?: string | null;
  server_name?: string | null;
  schema?: unknown;
  tags?: string[] | null;
};

export type PlatformWorkflow = {
  id: number;
  name: string;
  description?: string | null;
  status?: string | null;
  is_active?: boolean | number | null;
  created_at?: string | null;
  updated_at?: string | null;
  config?: Record<string, unknown> | null;
};

export type AgentPlatformSnapshot = {
  agents: PlatformAgent[];
  knowledgeBases: PlatformKnowledgeBase[];
  skills: PlatformSkill[];
  mcpServers: PlatformMcpServer[];
  mcpTools: PlatformMcpTool[];
  workflows: PlatformWorkflow[];
};

type RequestOptions = {
  auth?: boolean;
  init?: RequestInit;
};

const DEFAULT_BASE_URL = "/agent-platform-api";
const PLATFORM_AVAILABILITY_PROBE_PATH = "/api/v1/mcp/tools?page=1&page_size=1";
export const AGENT_PLATFORM_TOKEN_STORAGE_KEY = "crewon-agent-platform-token";
export const AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY =
  "crewon-agent-platform-refresh-token";
const UNAVAILABLE_RETRY_MS = 30_000;

let cachedToken: string | null = null;
let cachedTokenPromise: Promise<string | null> | null = null;
let availabilityProbePromise: Promise<void> | null = null;
let unavailableRetryAt = 0;

class AgentPlatformUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentPlatformUnavailableError";
  }
}

function envValue(key: string): string | undefined {
  const value = import.meta.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function agentPlatformBaseUrl(): string {
  return (
    envValue("VITE_AGENT_PLATFORM_BASE_URL") ??
    envValue("VITE_AGENT_PLATFORM_API_BASE_URL") ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function isUnavailableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function markAgentPlatformUnavailable(
  cause?: unknown,
): AgentPlatformUnavailableError {
  unavailableRetryAt = Date.now() + UNAVAILABLE_RETRY_MS;
  return new AgentPlatformUnavailableError("agent-platform unavailable", cause);
}

async function ensureAgentPlatformAvailable(): Promise<void> {
  if (Date.now() < unavailableRetryAt) {
    throw new AgentPlatformUnavailableError("agent-platform unavailable");
  }

  if (availabilityProbePromise) {
    return availabilityProbePromise;
  }

  availabilityProbePromise = probeAgentPlatformAvailability().finally(() => {
    availabilityProbePromise = null;
  });
  return availabilityProbePromise;
}

async function probeAgentPlatformAvailability(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `${agentPlatformBaseUrl()}${PLATFORM_AVAILABILITY_PROBE_PATH}`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );
  } catch (error) {
    throw markAgentPlatformUnavailable(error);
  }

  if (isUnavailableStatus(response.status)) {
    throw markAgentPlatformUnavailable(response.status);
  }
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: HeadersInit = {};
  if (options.auth) {
    const token = await getAgentPlatformToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const response = await fetch(`${agentPlatformBaseUrl()}${path}`, {
    ...options.init,
    headers,
  });
  if (!response.ok) {
    throw new Error(
      `agent-platform ${path} failed: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as T;
}

async function getAgentPlatformToken(): Promise<string | null> {
  if (cachedToken) {
    return cachedToken;
  }

  cachedToken = localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
  if (cachedToken) {
    return cachedToken;
  }

  if (cachedTokenPromise) {
    return cachedTokenPromise;
  }

  cachedTokenPromise = loginWithConfiguredDevAccount().finally(() => {
    cachedTokenPromise = null;
  });
  return cachedTokenPromise;
}

async function loginWithConfiguredDevAccount(): Promise<string | null> {
  const username = envValue("VITE_AGENT_PLATFORM_DEV_USERNAME");
  const password = envValue("VITE_AGENT_PLATFORM_DEV_PASSWORD");
  if (!username || !password) {
    return null;
  }
  const form = new URLSearchParams();
  form.set("username", username);
  form.set("password", password);

  const response = await fetch(`${agentPlatformBaseUrl()}/api/v1/auth/login`, {
    method: "POST",
    body: form,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    return null;
  }
  cachedToken = body.access_token;
  localStorage.setItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY, cachedToken);
  return cachedToken;
}

export function storeAgentPlatformSession(
  accessToken: string,
  refreshToken?: string | null,
): void {
  cachedToken = accessToken;
  localStorage.setItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY, accessToken);
  if (refreshToken) {
    localStorage.setItem(
      AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
      refreshToken,
    );
  }
}

export function clearAgentPlatformSession(): void {
  cachedToken = null;
  localStorage.removeItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
  localStorage.removeItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY);
}

export async function agentPlatformAuthorizedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAgentPlatformToken();
  const headers = new Headers(init.headers);
  headers.set("Accept", headers.get("Accept") ?? "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(`${agentPlatformBaseUrl()}${path}`, { ...init, headers });
}

async function listPage<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T[]> {
  const response = await request<PageResponse<T>>(path, options);
  return Array.isArray(response.items) ? response.items : [];
}

export async function readAgentPlatformSnapshot(): Promise<AgentPlatformSnapshot> {
  await ensureAgentPlatformAvailable();

  try {
    const catalog = await request<{
      resources?: {
        agents?: Array<PlatformAgent & { model?: string | null }>;
        knowledge_bases?: PlatformKnowledgeBase[];
        skills?: PlatformSkill[];
        mcp_servers?: PlatformMcpServer[];
      };
    }>("/api/v1/crewon/catalog", { auth: true });
    const resources = catalog.resources ?? {};
    const workflows = await listPage<PlatformWorkflow>(
      "/api/v1/workflows?page=1&page_size=100",
      { auth: true },
    ).catch(() => []);
    return {
      agents: (resources.agents ?? []).map((agent) => ({
        ...agent,
        model_info: agent.model_info ?? {
          model_name: agent.model ?? null,
          name: agent.model ?? null,
        },
      })),
      knowledgeBases: resources.knowledge_bases ?? [],
      skills: resources.skills ?? [],
      mcpServers: resources.mcp_servers ?? [],
      mcpTools: [],
      workflows,
    };
  } catch {
    // Older agent-platform instances do not expose the CrewON catalog yet.
  }

  const [agents, knowledgeBases, skills, mcpServers, mcpTools, workflows] =
    await Promise.all([
      listPage<PlatformAgent>("/api/v1/agents/?page=1&page_size=100", {
        auth: true,
      }),
      listPage<PlatformKnowledgeBase>(
        "/api/v1/knowledge/?page=1&page_size=100",
        {
          auth: true,
        },
      ),
      listPage<PlatformSkill>("/api/v1/skills?page=1&page_size=100", {
        auth: true,
      }),
      listPage<PlatformMcpServer>("/api/v1/mcp/servers?page=1&page_size=100", {
        auth: true,
      }),
      listPage<PlatformMcpTool>("/api/v1/mcp/tools?page=1&page_size=100"),
      listPage<PlatformWorkflow>("/api/v1/workflows?page=1&page_size=100", {
        auth: true,
      }),
    ]);

  return {
    agents,
    knowledgeBases,
    skills,
    mcpServers,
    mcpTools,
    workflows,
  };
}

export async function readAgentPlatformAgentItems(): Promise<LibraryItem[]> {
  const snapshot = await readAgentPlatformSnapshot();
  return platformAgentsToLibraryItems(snapshot);
}

export async function readAgentPlatformToolItems(): Promise<LibraryItem[]> {
  const snapshot = await readAgentPlatformSnapshot();
  return platformToolsToLibraryItems(snapshot);
}

export async function readAgentPlatformKnowledgeData(): Promise<KnowledgeData> {
  const snapshot = await readAgentPlatformSnapshot();
  return platformKnowledgeToData(snapshot);
}

export function platformAgentsToLibraryItems(
  snapshot: AgentPlatformSnapshot,
): LibraryItem[] {
  const accents = capabilityAccents();
  return snapshot.agents.map((agent, index) => {
    const model =
      agent.model_info?.model_name ?? agent.model_info?.name ?? "model";
    const config = platformAgentToConfig(agent, snapshot, index);
    return {
      title: agent.name,
      meta: `agent-platform local #${agent.id}`,
      description:
        agent.description ||
        `${model} · ${agent.knowledge_base_ids?.length ?? 0} KB · ${agent.skill_ids?.length ?? 0} Skills · ${agent.mcp_servers?.length ?? 0} MCP`,
      glyph: "A",
      accent: accents[index % accents.length],
      badge: {
        label:
          agent.is_active === false || agent.is_active === 0
            ? "disabled"
            : "local",
        tone:
          agent.is_active === false || agent.is_active === 0
            ? "warning"
            : "running",
      },
      tags: [
        model,
        `${agent.knowledge_base_ids?.length ?? 0} KB`,
        `${agent.skill_ids?.length ?? 0} Skills`,
        `${agent.mcp_servers?.length ?? 0} MCP`,
      ],
      action: {
        type: "agent-config",
        config,
        configPath: `agent-platform://agents/${agent.id}`,
      },
    };
  });
}

export function platformToolsToLibraryItems(
  snapshot: AgentPlatformSnapshot,
): LibraryItem[] {
  const serverItems = snapshot.mcpServers.map((server, index): LibraryItem => {
    const accent = capabilityAccents()[index % capabilityAccents().length];
    const title = server.alias || server.name;
    const tools = snapshot.mcpTools.filter(
      (tool) => tool.server_name === server.name,
    );
    return {
      title,
      meta: `MCP · agent-platform local #${server.id}`,
      description:
        server.description ||
        server.endpoint ||
        `${tools.length} tools from ${server.name}`,
      glyph: MCP_GLYPHS[index % MCP_GLYPHS.length],
      accent,
      badge: {
        label: server.is_connected ? "connected" : "synced",
        tone: server.is_connected ? "running" : "planning",
      },
      tags: [
        `${tools.length} tools`,
        server.category ?? "MCP",
        server.is_enabled === false ? "disabled" : "enabled",
      ].filter((tag): tag is string => Boolean(tag)),
      action: {
        type: "mcp-detail",
        title,
        subtitle: server.name,
        body: [
          `Source: local agent-platform MCP server #${server.id}`,
          server.description,
          server.endpoint ? `Endpoint: ${server.endpoint}` : null,
          `Enabled: ${server.is_enabled !== false}`,
          `Connected: ${Boolean(server.is_connected)}`,
          `Call count: ${server.call_count ?? 0}`,
          "",
          `Tools (${tools.length})`,
          tools
            .slice(0, 12)
            .map(
              (tool) =>
                `- ${tool.alias || tool.name}: ${tool.description || tool.intro || ""}`,
            )
            .join("\n") || "No tools found for this server.",
        ]
          .filter((line) => line !== null)
          .join("\n"),
        tool: tools[0]
          ? {
              server: server.name,
              name: tools[0].name,
              label: tools[0].alias || tools[0].name,
              inputSchema: JSON.stringify(tools[0].schema ?? {}, null, 2),
            }
          : undefined,
        configPath: `agent-platform://mcp/servers/${server.id}`,
      },
    };
  });

  const skillItems = snapshot.skills.map(
    (skill, index): LibraryItem => ({
      title: skill.name,
      meta: `Skill · agent-platform local #${skill.id}`,
      description:
        promptPreview(skill.description || skill.skill_md_content || "") ||
        "Skill synced from local agent-platform.",
      glyph: SKILL_GLYPHS[index % SKILL_GLYPHS.length],
      accent: capabilityAccents()[(index + 2) % capabilityAccents().length],
      badge: { label: "synced", tone: "running" },
      tags: [
        skill.category ?? "Skill",
        skill.version ? `v${skill.version}` : null,
        ...(skill.tags ?? []).slice(0, 2),
      ].filter((tag): tag is string => Boolean(tag)),
      action: {
        type: "skill-file",
        skillName: skill.name,
        path: skill.storage_path ?? `agent-platform://skills/${skill.id}`,
        enabled: true,
        configPath: `agent-platform://skills/${skill.id}`,
      },
    }),
  );

  return [...serverItems, ...skillItems];
}

export function platformKnowledgeToData(
  snapshot: AgentPlatformSnapshot,
): KnowledgeData {
  return {
    memories: snapshot.agents
      .filter(
        (agent) =>
          (agent.knowledge_base_ids?.length ?? 0) > 0 ||
          (agent.skill_ids?.length ?? 0) > 0 ||
          (agent.mcp_servers?.length ?? 0) > 0,
      )
      .slice(0, 12)
      .map((agent, index) => ({
        title: agent.name,
        glyph: "A",
        accent: capabilityAccents()[index % capabilityAccents().length],
        kind: "Agent binding",
        preview: [
          `${agent.knowledge_base_ids?.length ?? 0} knowledge bases`,
          `${agent.skill_ids?.length ?? 0} skills`,
          `${agent.mcp_servers?.length ?? 0} MCP servers`,
        ].join(" · "),
        meta: `agent-platform://agents/${agent.id}`,
        pinned: index < 3,
      })),
    sources: snapshot.knowledgeBases.map((knowledgeBase, index) => ({
      name: knowledgeBase.name,
      glyph: "K",
      accent: capabilityAccents()[(index + 1) % capabilityAccents().length],
      status: "indexed",
      meta: `${knowledgeBase.document_count ?? 0} documents · ${knowledgeBase.embedding_model ?? "embedding"}`,
      path: `agent-platform://knowledge/${knowledgeBase.id}`,
      isDirectory: true,
    })),
  };
}

function platformAgentToConfig(
  agent: PlatformAgent,
  snapshot: AgentPlatformSnapshot,
  index: number,
): AgentConfig {
  const accents = capabilityAccents();
  const model =
    agent.model_info?.model_name ?? agent.model_info?.name ?? "qwen-plus";
  const linkedSkillIds = new Set(agent.skill_ids ?? []);
  const linkedMcpNames = new Set(agent.mcp_servers ?? []);
  const mcp = snapshot.mcpServers.map(
    (server, serverIndex): AgentCapabilityOption => ({
      id: String(server.id),
      name: server.alias || server.name,
      glyph: MCP_GLYPHS[serverIndex % MCP_GLYPHS.length],
      accent: accents[serverIndex % accents.length],
      description:
        server.description ||
        server.endpoint ||
        "MCP server synced from local agent-platform.",
      enabled: linkedMcpNames.has(server.name),
    }),
  );
  const skills = snapshot.skills.map(
    (skill, skillIndex): AgentCapabilityOption => ({
      id: String(skill.id),
      name: skill.name,
      glyph: SKILL_GLYPHS[skillIndex % SKILL_GLYPHS.length],
      accent: accents[(skillIndex + 2) % accents.length],
      description:
        promptPreview(skill.description || skill.skill_md_content || "") ||
        "Skill synced from local agent-platform.",
      enabled: linkedSkillIds.has(skill.id),
    }),
  );

  return {
    agentId: `agent-platform:${agent.id}`,
    name: agent.name,
    glyph: "A",
    accent: accents[index % accents.length],
    role: agent.description || "Local agent-platform agent",
    model,
    models: [model],
    permission: "agent-platform-local",
    permissions: ["agent-platform-local"],
    systemPrompt: agent.system_prompt || "",
    mcp,
    skills,
  };
}
