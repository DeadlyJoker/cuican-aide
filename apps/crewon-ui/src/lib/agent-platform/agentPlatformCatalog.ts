import { agentPlatformAuthorizedFetch } from "./agentPlatformClient";

export type CatalogResourceType =
  | "agents"
  | "skills"
  | "mcp_servers"
  | "knowledge_bases";

export type CatalogResourceSummary = {
  id: number;
  type: CatalogResourceType;
  name: string;
  description: string;
  owner_username?: string | null;
  category?: string | null;
  tags?: string[];
  updated_at?: string | null;
  enabled?: boolean | number | null;
  download_available?: boolean;
  model?: string | null;
  api_enabled?: boolean;
  invocation_url?: string | null;
  version?: string | number | null;
  file_count?: number;
  has_scripts?: boolean;
  server_type?: string | null;
  openness?: string | null;
  tool_count?: number;
  connected?: boolean;
  document_count?: number;
  chunk_count?: number;
  embedding_model?: string | null;
  downloaded?: boolean;
  downloaded_at?: string | null;
  update_available?: boolean;
  source_updated_at?: string | null;
};

export type CatalogResourceDetail = Record<string, unknown> & {
  id: number;
  name?: string;
  description?: string | null;
  owner_username?: string | null;
  invocation?: Record<string, unknown>;
  documents?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
};

export type CatalogDownloadState = {
  downloaded: true;
  downloaded_at: string;
  source_updated_at?: string | null;
  update_available: false;
};

export type CatalogSkillFile = {
  path: string;
  type: "directory" | "file";
  content?: string;
  items?: Array<{ name: string; path: string; type: "directory" | "file" }>;
};

async function checkedResponse(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  let message = `请求失败 (${response.status})`;
  try {
    const body = (await response.json()) as { detail?: string };
    message = body.detail || message;
  } catch {
    // Preserve the status-based fallback.
  }
  throw new Error(message);
}

export async function readCatalogResourceDetail(
  type: CatalogResourceType,
  id: number,
): Promise<CatalogResourceDetail> {
  const response = await checkedResponse(
    await agentPlatformAuthorizedFetch(
      `/api/v1/crewon/catalog/resources/${type}/${id}/content`,
    ),
  );
  return (await response.json()) as CatalogResourceDetail;
}

export async function refreshAgentPlatformCatalog(): Promise<void> {
  await checkedResponse(
    await agentPlatformAuthorizedFetch("/api/v1/crewon/catalog/refresh", {
      method: "POST",
    }),
  );
}

export async function downloadCatalogResource(
  type: CatalogResourceType,
  id: number,
): Promise<CatalogDownloadState> {
  const response = await checkedResponse(
    await agentPlatformAuthorizedFetch(
      `/api/v1/crewon/catalog/resources/${type}/${id}/download`,
      { method: "POST" },
    ),
  );
  return (await response.json()) as CatalogDownloadState;
}

export async function readCatalogSkillFile(
  id: number,
  path = "",
): Promise<CatalogSkillFile> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const response = await checkedResponse(
    await agentPlatformAuthorizedFetch(
      `/api/v1/crewon/catalog/resources/skills/${id}/files${query}`,
    ),
  );
  return (await response.json()) as CatalogSkillFile;
}

export async function invokeCatalogAgent(
  id: number,
  query: string,
): Promise<Record<string, unknown>> {
  const response = await checkedResponse(
    await agentPlatformAuthorizedFetch(
      `/api/v1/crewon/catalog/resources/agents/${id}/run`,
      {
        method: "POST",
        body: JSON.stringify({ inputs: { query }, channel: "crewon" }),
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
  return (await response.json()) as Record<string, unknown>;
}

export async function invokeCatalogSkill(
  id: number,
  script: string,
  args: string[],
): Promise<unknown> {
  const response = await checkedResponse(
    await agentPlatformAuthorizedFetch(
      `/api/v1/crewon/catalog/resources/skills/${id}/run`,
      {
        method: "POST",
        body: JSON.stringify({ script, args, timeout: 30 }),
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
  return response.json();
}

export async function invokeCatalogMcpTool(
  serverId: number,
  toolId: number,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  const response = await checkedResponse(
    await agentPlatformAuthorizedFetch(
      `/api/v1/crewon/catalog/resources/mcp_servers/${serverId}/tools/${toolId}/call`,
      {
        method: "POST",
        body: JSON.stringify({ arguments: argumentsValue }),
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
  return response.json();
}

export async function searchCatalogKnowledge(
  id: number,
  query: string,
  topK: number,
): Promise<unknown> {
  const response = await checkedResponse(
    await agentPlatformAuthorizedFetch(
      `/api/v1/crewon/catalog/resources/knowledge_bases/${id}/search`,
      {
        method: "POST",
        body: JSON.stringify({ query, top_k: topK, search_mode: "keyword" }),
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
  return response.json();
}
