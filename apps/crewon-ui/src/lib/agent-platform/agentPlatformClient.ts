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

export type AgentPlatformResourceSource = "online" | "catalog" | "local";

type PlatformAgentMcpBinding =
  | string
  | number
  | {
      server_id: number;
      enabled?: boolean;
      included_tool_ids?: number[];
      excluded_tool_ids?: number[];
    };

type PlatformAgent = {
  id: number;
  name: string;
  description?: string | null;
  system_prompt?: string | null;
  model_info?: PlatformModelInfo | null;
  knowledge_base_ids?: number[] | null;
  skill_ids?: number[] | null;
  mcp_servers?: PlatformAgentMcpBinding[] | null;
  config?: Record<string, unknown> | null;
  is_active?: boolean | number | null;
  api_enabled?: boolean | number | null;
  owner_username?: string | null;
  invocation_url?: string | null;
  downloaded?: boolean;
  downloaded_at?: string | null;
  update_available?: boolean;
  source_updated_at?: string | null;
  resource_source?: AgentPlatformResourceSource;
  user_id?: number | null;
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
  resource_source?: AgentPlatformResourceSource;
  user_id?: number | null;
};

type PlatformSkill = {
  id: number;
  name: string;
  description?: string | null;
  enabled?: boolean | number | null;
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
  resource_source?: AgentPlatformResourceSource;
  user_id?: number | null;
  is_enabled?: boolean | number | null;
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
  resource_source?: AgentPlatformResourceSource;
  owner_user_id?: number | null;
  created_by?: number | null;
};

type PlatformMcpTool = {
  id: number;
  server_id: number;
  name: string;
  alias?: string | null;
  description?: string | null;
  intro?: string | null;
  category?: string | null;
  version?: string | null;
  input_schema?: unknown;
  tags?: string[] | null;
};

export type PlatformWorkflow = {
  id: number;
  name: string;
  description?: string | null;
  edges?: unknown[] | null;
  nodes?: unknown[] | null;
  status?: string | null;
  is_active?: boolean | number | null;
  created_at?: string | null;
  updated_at?: string | null;
  config?: Record<string, unknown> | null;
  user_id?: number | null;
  resource_source?: AgentPlatformResourceSource;
};

export type PlatformWorkflowExecution = {
  id: number;
  workflow_id: number;
  status: string;
  input_data?: Record<string, unknown> | null;
  output_data?: Record<string, unknown> | string | null;
  executed_nodes?: unknown[] | null;
  node_results?: Record<string, unknown> | null;
  error_message?: string | null;
};

export type AgentPlatformResourceCategory =
  | "agents"
  | "skills"
  | "mcp"
  | "knowledge";

export type AgentPlatformResourceState = {
  status: "loading" | "ready" | "error";
  error: string | null;
};

export type AgentPlatformResourceStates = Record<
  AgentPlatformResourceCategory,
  AgentPlatformResourceState
>;

export type AgentPlatformSnapshot = {
  agents: PlatformAgent[];
  knowledgeBases: PlatformKnowledgeBase[];
  skills: PlatformSkill[];
  mcpServers: PlatformMcpServer[];
  mcpTools: PlatformMcpTool[];
  workflows: PlatformWorkflow[];
  resourceStates?: AgentPlatformResourceStates;
};

type AgentPlatformUser = {
  id: number;
  username: string;
  role?: string | null;
};

type RequestOptions = {
  auth?: boolean;
  init?: RequestInit;
};

const DEFAULT_BASE_URL = "/agent-platform-api";
const PLATFORM_AVAILABILITY_PROBE_PATH = "/api/v1/health";
export const AGENT_PLATFORM_TOKEN_STORAGE_KEY = "crewon-agent-platform-token";
export const AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY =
  "crewon-agent-platform-refresh-token";
const UNAVAILABLE_RETRY_MS = 30_000;

let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;
let cachedTokenPromise: Promise<string | null> | null = null;
let cachedBffUser: Record<string, unknown> | null = null;
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

export function crewonUnifiedSsoEnabled(): boolean {
  return envValue("VITE_CREWON_UNIFIED_SSO_ENABLED") === "true";
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
  const headers = new Headers(options.init?.headers);
  if (options.auth) {
    const token = await getAgentPlatformToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const response = await fetch(`${agentPlatformBaseUrl()}${path}`, {
    ...options.init,
    headers,
    credentials: options.init?.credentials ?? "same-origin",
  });
  if (!response.ok) {
    throw new Error(
      `agent-platform ${path} failed: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as T;
}

export async function createAgentPlatformWorkflow(input: {
  description: string;
  lead: string;
  name: string;
}): Promise<PlatformWorkflow> {
  const workflow = await request<PlatformWorkflow>("/api/v1/workflows", {
    auth: true,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        nodes: [],
        edges: [],
        config: {
          crewon: {
            collaboration_mode: "workflow",
            lead: input.lead,
          },
        },
      }),
    },
  });
  return { ...workflow, resource_source: "online" };
}

async function getAgentPlatformToken(): Promise<string | null> {
  if (
    cachedToken &&
    tokenMatchesCurrentSessionRequirements(cachedToken) &&
    Date.now() + 30_000 < cachedTokenExpiresAt
  ) {
    return cachedToken;
  }

  if (crewonUnifiedSsoEnabled()) {
    cachedToken = null;
    cachedTokenExpiresAt = 0;
    localStorage.removeItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
    localStorage.removeItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY);
    if (cachedTokenPromise) {
      return cachedTokenPromise;
    }
    cachedTokenPromise = obtainBffAccessToken().finally(() => {
      cachedTokenPromise = null;
    });
    return cachedTokenPromise;
  }

  cachedToken = localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
  if (cachedToken) {
    cachedTokenExpiresAt = jwtExpiryMilliseconds(cachedToken);
    if (tokenMatchesCurrentSessionRequirements(cachedToken)) {
      if (
        cachedTokenExpiresAt === 0 ||
        Date.now() + 30_000 < cachedTokenExpiresAt
      ) {
        return cachedToken;
      }
    } else {
      clearAgentPlatformSession();
    }
  }

  if (cachedTokenPromise) {
    return cachedTokenPromise;
  }

  cachedTokenPromise = restoreAgentPlatformToken().finally(() => {
    cachedTokenPromise = null;
  });
  return cachedTokenPromise;
}

export async function getAgentPlatformAccessToken(): Promise<string | null> {
  return getAgentPlatformToken();
}

export function getAgentPlatformBffUserSnapshot(): Record<
  string,
  unknown
> | null {
  return crewonUnifiedSsoEnabled() ? cachedBffUser : null;
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
  cachedTokenExpiresAt = jwtExpiryMilliseconds(cachedToken);
  localStorage.setItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY, cachedToken);
  return cachedToken;
}

async function restoreAgentPlatformToken(): Promise<string | null> {
  const refreshed = await refreshStoredAgentPlatformSession();
  return refreshed ?? loginWithConfiguredDevAccount();
}

async function refreshStoredAgentPlatformSession(): Promise<string | null> {
  const refreshToken = localStorage.getItem(
    AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
  );
  if (!refreshToken) {
    if (
      cachedTokenExpiresAt > 0 &&
      cachedTokenExpiresAt <= Date.now() + 30_000
    ) {
      clearAgentPlatformSession();
    }
    return null;
  }
  const form = new URLSearchParams({ refresh_token: refreshToken });
  const response = await fetch(
    `${agentPlatformBaseUrl()}/api/v1/auth/refresh`,
    {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      credentials: "same-origin",
      cache: "no-store",
    },
  );
  if (!response.ok) {
    clearAgentPlatformSession();
    return null;
  }
  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (
    !body.access_token ||
    !tokenMatchesCurrentSessionRequirements(body.access_token)
  ) {
    clearAgentPlatformSession();
    return null;
  }
  storeAgentPlatformSession(body.access_token, body.refresh_token);
  return body.access_token;
}

async function obtainBffAccessToken(): Promise<string | null> {
  const response = await fetch(
    `${agentPlatformBaseUrl()}/sso/client/crewon/token`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    },
  );
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new AgentPlatformUnavailableError(
      `SSO session token failed: ${response.status}`,
    );
  }
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    user?: Record<string, unknown>;
  };
  if (!body.access_token) {
    return null;
  }
  cachedToken = body.access_token;
  cachedTokenExpiresAt =
    Date.now() + Math.max(0, Number(body.expires_in ?? 0)) * 1000;
  cachedBffUser = body.user ?? null;
  return cachedToken;
}

export function storeAgentPlatformSession(
  accessToken: string,
  refreshToken?: string | null,
): void {
  cachedToken = accessToken;
  cachedTokenExpiresAt = jwtExpiryMilliseconds(accessToken);
  if (crewonUnifiedSsoEnabled()) {
    localStorage.removeItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
    localStorage.removeItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY);
    return;
  }
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
  cachedTokenExpiresAt = 0;
  cachedBffUser = null;
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.removeItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
  localStorage.removeItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY);
}

export async function clearAgentPlatformBffSession(
  options: { global?: boolean } = {},
): Promise<void> {
  clearAgentPlatformSession();
  if (!crewonUnifiedSsoEnabled()) {
    return;
  }
  const endpoint = options.global === false ? "logout" : "global-logout";
  await fetch(`${agentPlatformBaseUrl()}/sso/client/crewon/${endpoint}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
}

export async function agentPlatformAuthorizedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAgentPlatformToken();
  const requestWithToken = (accessToken: string | null) => {
    const headers = new Headers(init.headers);
    headers.set("Accept", headers.get("Accept") ?? "application/json");
    if (accessToken) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
    return fetch(`${agentPlatformBaseUrl()}${path}`, {
      ...init,
      headers,
      credentials: init.credentials ?? "same-origin",
    });
  };
  const response = await requestWithToken(token);
  if (
    response.status !== 401 ||
    crewonUnifiedSsoEnabled() ||
    !localStorage.getItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)
  ) {
    return response;
  }
  cachedToken = null;
  cachedTokenExpiresAt = 0;
  localStorage.removeItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
  const refreshedToken = await getAgentPlatformToken();
  return refreshedToken ? requestWithToken(refreshedToken) : response;
}

function jwtExpiryMilliseconds(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return 0;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    ) as { exp?: number };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function tokenMatchesCurrentSessionRequirements(token: string): boolean {
  if (envValue("VITE_CREWON_PRINCIPAL_SESSION_ENABLED") !== "true") {
    return true;
  }
  const payload = jwtPayload(token);
  return Boolean(
    payload &&
      isPositiveInteger(payload.tenant_id) &&
      isPositiveInteger(payload.space_id) &&
      typeof payload.crewon_auth_session_id === "string" &&
      payload.crewon_auth_session_id.length > 0 &&
      isPositiveInteger(payload.crewon_auth_epoch),
  );
}

function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    );
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listPage<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T[]> {
  const response = await request<PageResponse<T>>(path, options);
  return Array.isArray(response.items) ? response.items : [];
}

function settledError(result: PromiseSettledResult<unknown>): string {
  if (result.status === "rejected" && result.reason instanceof Error) {
    return result.reason.message;
  }
  return "agent-platform request failed";
}

export async function readAgentPlatformSnapshot(): Promise<AgentPlatformSnapshot> {
  await ensureAgentPlatformAvailable();

  const currentUser = await request<AgentPlatformUser>("/api/v1/auth/me", {
    auth: true,
  });

  const results = await Promise.allSettled([
    listPage<PlatformAgent>("/api/v1/agents/?page=1&page_size=100", {
      auth: true,
    }),
    listPage<PlatformKnowledgeBase>("/api/v1/knowledge/?page=1&page_size=100", {
      auth: true,
    }),
    listPage<PlatformSkill>("/api/v1/skills?page=1&page_size=100", {
      auth: true,
    }),
    listPage<PlatformMcpServer>("/api/v1/mcp/servers?page=1&page_size=100", {
      auth: true,
    }),
    listPage<PlatformMcpTool>("/api/v1/mcp/tools?page=1&page_size=100", {
      auth: true,
    }),
    listPage<PlatformWorkflow>("/api/v1/workflows?page=1&page_size=100", {
      auth: true,
    }),
    request<{
      source?: {
        type?: string;
      };
      resources?: {
        agents?: PlatformAgent[];
        knowledge_bases?: PlatformKnowledgeBase[];
        skills?: PlatformSkill[];
        mcp_servers?: PlatformMcpServer[];
      };
    }>("/api/v1/crewon/catalog", { auth: true }),
  ] as const);

  const settledItems = <T>(result: PromiseSettledResult<T[]>): T[] | null =>
    result.status === "fulfilled" ? result.value : null;
  const markOnline = <
    T extends {
      downloaded?: boolean;
      downloaded_at?: string | null;
      update_available?: boolean;
      resource_source?: AgentPlatformResourceSource;
    },
  >(
    items: T[],
  ): T[] =>
    items.map((item) => {
      const onlineItem = { ...item, resource_source: "online" as const };
      delete onlineItem.downloaded;
      delete onlineItem.downloaded_at;
      delete onlineItem.update_available;
      return onlineItem;
    });
  const markCatalog = <
    T extends { resource_source?: AgentPlatformResourceSource },
  >(
    items: T[],
  ): T[] => items.map((item) => ({ ...item, resource_source: "catalog" }));

  const ownedByCurrentUser = <
    T extends {
      owner_username?: string | null;
      user_id?: number | null;
      owner_user_id?: number | null;
      created_by?: number | null;
    },
  >(
    item: T,
  ): boolean => {
    if (item.owner_username) {
      return item.owner_username === currentUser.username;
    }
    const ownerId = item.user_id ?? item.owner_user_id ?? item.created_by;
    return ownerId != null && ownerId === currentUser.id;
  };
  const ownedCatalog = <T extends { owner_username?: string | null }>(
    items: T[],
  ): T[] =>
    items.filter((item) => item.owner_username === currentUser.username);
  const ownedOnline = <
    T extends {
      owner_username?: string | null;
      user_id?: number | null;
      owner_user_id?: number | null;
      created_by?: number | null;
    },
  >(
    items: T[],
  ): T[] => items.filter(ownedByCurrentUser);

  const onlineAgents = markOnline(ownedOnline(settledItems(results[0]) ?? []));
  const onlineKnowledgeBases = markOnline(
    ownedOnline(settledItems(results[1]) ?? []),
  );
  const onlineSkills = markOnline(ownedOnline(settledItems(results[2]) ?? []));
  const onlineMcpServers = markOnline(
    ownedOnline(settledItems(results[3]) ?? []),
  );
  const catalogResources =
    results[6].status === "fulfilled" ? results[6].value.resources : undefined;
  const catalogIsLiveDatabase =
    results[6].status === "fulfilled" &&
    results[6].value.source?.type === "live_database";
  const markCatalogResource = <
    T extends {
      downloaded?: boolean;
      downloaded_at?: string | null;
      update_available?: boolean;
      resource_source?: AgentPlatformResourceSource;
    },
  >(
    items: T[],
  ): T[] => (catalogIsLiveDatabase ? markOnline(items) : markCatalog(items));
  const catalogResourceSource: AgentPlatformResourceSource =
    catalogIsLiveDatabase ? "online" : "catalog";
  const catalogAgents = markCatalogResource(
    ownedCatalog(catalogResources?.agents ?? []),
  );
  const agentsById = new Map(
    onlineAgents.map((agent) => [agent.id, agent] as const),
  );
  catalogAgents.forEach((catalogAgent) => {
    const onlineAgent = agentsById.get(catalogAgent.id);
    agentsById.set(
      catalogAgent.id,
      onlineAgent
        ? {
            ...onlineAgent,
            ...catalogAgent,
            resource_source: catalogResourceSource,
          }
        : catalogAgent,
    );
  });
  const agents = [...agentsById.values()];
  const catalogKnowledgeBases = markCatalogResource(
    ownedCatalog(catalogResources?.knowledge_bases ?? []),
  );
  const knowledgeBasesById = new Map(
    onlineKnowledgeBases.map(
      (knowledgeBase) => [knowledgeBase.id, knowledgeBase] as const,
    ),
  );
  catalogKnowledgeBases.forEach((catalogKnowledgeBase) => {
    const onlineKnowledgeBase = knowledgeBasesById.get(catalogKnowledgeBase.id);
    knowledgeBasesById.set(
      catalogKnowledgeBase.id,
      onlineKnowledgeBase
        ? {
            ...onlineKnowledgeBase,
            ...catalogKnowledgeBase,
            resource_source: catalogResourceSource,
          }
        : catalogKnowledgeBase,
    );
  });
  const knowledgeBases = [...knowledgeBasesById.values()];
  const catalogSkills =
    results[6].status === "fulfilled"
      ? markCatalogResource(ownedCatalog(catalogResources?.skills ?? []))
      : [];
  const skillsById = new Map(
    onlineSkills.map((skill) => [skill.id, skill] as const),
  );
  catalogSkills.forEach((catalogSkill) => {
    const onlineSkill = skillsById.get(catalogSkill.id);
    skillsById.set(
      catalogSkill.id,
      onlineSkill
        ? {
            ...onlineSkill,
            ...catalogSkill,
            resource_source: catalogResourceSource,
          }
        : catalogSkill,
    );
  });
  const skills = [...skillsById.values()];
  const catalogMcpServers =
    results[6].status === "fulfilled"
      ? markCatalogResource(ownedCatalog(catalogResources?.mcp_servers ?? []))
      : [];
  const mcpServersById = new Map(
    onlineMcpServers.map((server) => [server.id, server] as const),
  );
  catalogMcpServers.forEach((catalogServer) => {
    const onlineServer = mcpServersById.get(catalogServer.id);
    mcpServersById.set(
      catalogServer.id,
      onlineServer
        ? {
            ...onlineServer,
            ...catalogServer,
            resource_source: catalogResourceSource,
          }
        : catalogServer,
    );
  });
  const mcpServers = [...mcpServersById.values()];
  const visibleMcpServerIds = new Set(mcpServers.map((server) => server.id));
  const mcpTools = (settledItems(results[4]) ?? []).filter((tool) => {
    const serverId = tool.server_id;
    return visibleMcpServerIds.has(serverId);
  });
  const workflows = markOnline(ownedOnline(settledItems(results[5]) ?? []));

  const categoryState = (
    result: PromiseSettledResult<unknown>,
    fallbackItems: readonly unknown[],
  ): AgentPlatformResourceState =>
    result.status === "fulfilled" || fallbackItems.length > 0
      ? { status: "ready", error: null }
      : { status: "error", error: settledError(result) };
  const mcpServerState = categoryState(results[3], mcpServers);
  const mcpState =
    mcpServerState.status === "ready" &&
    mcpServers.length > 0 &&
    results[4].status === "rejected"
      ? {
          status: "error" as const,
          error: settledError(results[4]),
        }
      : mcpServerState;
  const resourceStates: AgentPlatformResourceStates = {
    agents: categoryState(results[0], agents),
    knowledge: categoryState(results[1], knowledgeBases),
    skills: categoryState(results[2], skills),
    mcp: mcpState,
  };

  return {
    agents,
    knowledgeBases,
    skills,
    mcpServers,
    mcpTools,
    workflows,
    resourceStates,
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
    const sourceLabel =
      agent.resource_source === "catalog" ? "catalog" : "online";
    const config = platformAgentToConfig(agent, snapshot, index);
    return {
      title: agent.name,
      meta: `agent-platform ${sourceLabel} #${agent.id}`,
      description:
        agent.description ||
        `${model} · ${agent.knowledge_base_ids?.length ?? 0} KB · ${agent.skill_ids?.length ?? 0} Skills · ${agent.mcp_servers?.length ?? 0} MCP`,
      glyph: "A",
      accent: accents[index % accents.length],
      badge: {
        label:
          agent.is_active === false || agent.is_active === 0
            ? "disabled"
            : sourceLabel,
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
      (tool) => tool.server_id === server.id,
    );
    return {
      title,
      meta: `MCP · agent-platform online #${server.id}`,
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
          `Source: online agent-platform MCP server #${server.id}`,
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
              inputSchema: JSON.stringify(tools[0].input_schema ?? {}, null, 2),
            }
          : undefined,
        configPath: `agent-platform://mcp/servers/${server.id}`,
      },
    };
  });

  const skillItems = snapshot.skills.map(
    (skill, index): LibraryItem => ({
      title: skill.name,
      meta: `Skill · agent-platform ${skill.resource_source === "catalog" ? "catalog" : "online"} #${skill.id}`,
      description:
        promptPreview(skill.description || skill.skill_md_content || "") ||
        "Skill available from agent-platform.",
      glyph: SKILL_GLYPHS[index % SKILL_GLYPHS.length],
      accent: capabilityAccents()[(index + 2) % capabilityAccents().length],
      badge: {
        label: skill.resource_source === "catalog" ? "catalog" : "online",
        tone: "running",
      },
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
  const linkedMcpServerIds = new Set<number>();
  const linkedMcpNames = new Set<string>();
  for (const binding of agent.mcp_servers ?? []) {
    if (typeof binding === "number") {
      linkedMcpServerIds.add(binding);
    } else if (typeof binding === "string") {
      linkedMcpNames.add(binding);
      const legacyId = Number(binding);
      if (Number.isInteger(legacyId)) {
        linkedMcpServerIds.add(legacyId);
      }
    } else if (binding.enabled !== false) {
      linkedMcpServerIds.add(binding.server_id);
    }
  }
  const mcp = snapshot.mcpServers.map(
    (server, serverIndex): AgentCapabilityOption => ({
      id: String(server.id),
      name: server.alias || server.name,
      glyph: MCP_GLYPHS[serverIndex % MCP_GLYPHS.length],
      accent: accents[serverIndex % accents.length],
      description:
        server.description ||
        server.endpoint ||
        "MCP server available from agent-platform.",
      enabled:
        linkedMcpServerIds.has(server.id) || linkedMcpNames.has(server.name),
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
        "Skill available from agent-platform.",
      enabled: linkedSkillIds.has(skill.id),
    }),
  );

  return {
    name: agent.name,
    glyph: "A",
    accent: accents[index % accents.length],
    role: agent.description || "Online agent-platform agent",
    model,
    models: [model],
    permission: "agent-platform-local",
    permissions: ["agent-platform-local"],
    systemPrompt: agent.system_prompt || "",
    mcp,
    skills,
  };
}
