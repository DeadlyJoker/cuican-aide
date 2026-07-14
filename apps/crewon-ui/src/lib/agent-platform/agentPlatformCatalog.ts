import { agentPlatformAuthorizedFetch } from "./agentPlatformClient";

export type CatalogResourceType =
  | "agents"
  | "skills"
  | "mcp_servers"
  | "knowledge_bases";

export type CatalogDownloadableResourceType = "skills";

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
  source?: "online" | "catalog" | "local";
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
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") {
      message = body.detail;
    } else if (body.detail) {
      message = JSON.stringify(body.detail);
    }
  } catch {
    // Preserve the status-based fallback.
  }
  throw new Error(message);
}

export async function readCatalogResourceDetail(
  resource: CatalogResourceSummary,
): Promise<CatalogResourceDetail> {
  if (resource.source !== "catalog") {
    if (resource.type === "mcp_servers") {
      const [detailResponse, toolsResponse] = await Promise.all([
        checkedResponse(
          await agentPlatformAuthorizedFetch(
            `/api/v1/mcp/servers/${resource.id}`,
          ),
        ),
        checkedResponse(
          await agentPlatformAuthorizedFetch(
            `/api/v1/mcp/servers/${resource.id}/tools?page=1&page_size=100`,
          ),
        ),
      ]);
      const detail = (await detailResponse.json()) as CatalogResourceDetail;
      const toolsPage = (await toolsResponse.json()) as {
        items?: Array<Record<string, unknown>>;
      };
      return { ...detail, tools: toolsPage.items ?? [] };
    }
    if (resource.type === "knowledge_bases") {
      const detailResponse = await checkedResponse(
        await agentPlatformAuthorizedFetch(`/api/v1/knowledge/${resource.id}`),
      );
      const detail = (await detailResponse.json()) as CatalogResourceDetail;
      const documentsResponse = await checkedResponse(
        await agentPlatformAuthorizedFetch(
          `/api/v1/knowledge/${resource.id}/documents?page=1&page_size=100`,
        ),
      );
      const documentsPage = (await documentsResponse.json()) as {
        items?: Array<Record<string, unknown>>;
      };
      return { ...detail, documents: documentsPage.items ?? [] };
    }
    const path =
      resource.type === "skills"
        ? `/api/v1/skills/${resource.id}`
        : `/api/v1/agents/${resource.id}`;
    const response = await checkedResponse(
      await agentPlatformAuthorizedFetch(path),
    );
    return (await response.json()) as CatalogResourceDetail;
  }
  const response = await checkedResponse(
    await agentPlatformAuthorizedFetch(
      `/api/v1/crewon/catalog/resources/${resource.type}/${resource.id}`,
    ),
  );
  return (await response.json()) as CatalogResourceDetail;
}

export async function downloadCatalogResource(
  type: CatalogDownloadableResourceType,
  id: number,
): Promise<CatalogDownloadState> {
  if (type !== "skills") {
    throw new Error("只有 Skill 支持下载");
  }
  const response = await checkedResponse(
    await agentPlatformAuthorizedFetch(
      `/api/v1/crewon/catalog/resources/skills/${id}/download`,
      { method: "POST" },
    ),
  );
  return (await response.json()) as CatalogDownloadState;
}

export async function readCatalogSkillFile(
  resource: CatalogResourceSummary,
  path = "",
): Promise<CatalogSkillFile> {
  if (resource.source !== "catalog") {
    const listingResponse = await checkedResponse(
      await agentPlatformAuthorizedFetch(`/api/v1/skills/${resource.id}/files`),
    );
    const listing = (await listingResponse.json()) as { file_tree?: unknown[] };
    const tree = (listing.file_tree ?? []).filter(
      (item): item is string => typeof item === "string",
    );
    const normalizedPath = path.replace(/^\/+|\/+$/g, "");
    if (normalizedPath && tree.includes(normalizedPath)) {
      const encodedPath = normalizedPath
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const fileResponse = await checkedResponse(
        await agentPlatformAuthorizedFetch(
          `/api/v1/skills/${resource.id}/files/${encodedPath}`,
        ),
      );
      const file = (await fileResponse.json()) as { content?: string };
      return {
        path: normalizedPath,
        type: "file",
        content: file.content ?? "",
      };
    }
    const prefix = normalizedPath ? `${normalizedPath}/` : "";
    const children = new Map<string, "directory" | "file">();
    tree
      .filter((item) => item.startsWith(prefix))
      .forEach((item) => {
        const remainder = item.slice(prefix.length);
        const [name, ...rest] = remainder.split("/");
        if (name) children.set(name, rest.length ? "directory" : "file");
      });
    return {
      path: normalizedPath,
      type: "directory",
      items: [...children].map(([name, type]) => ({
        name,
        type,
        path: prefix + name,
      })),
    };
  }
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const response = await checkedResponse(
    await agentPlatformAuthorizedFetch(
      `/api/v1/crewon/catalog/resources/skills/${resource.id}/files${query}`,
    ),
  );
  return (await response.json()) as CatalogSkillFile;
}
