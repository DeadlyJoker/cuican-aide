import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { storeAgentPlatformSession } from "./agentPlatformClient";
import {
  downloadCatalogResource,
  readCatalogResourceDetail,
  type CatalogDownloadState,
} from "./agentPlatformCatalog";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("agent-platform catalog operations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows only Skill catalog downloads at the type and runtime boundaries", async () => {
    expectTypeOf(downloadCatalogResource)
      .parameter(0)
      .toEqualTypeOf<"skills">();
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("online-token");
    const downloadState: CatalogDownloadState = {
      downloaded: true,
      downloaded_at: "2026-07-13T00:00:00Z",
      update_available: false,
    };
    const fetchMock = vi.fn(async () => Response.json(downloadState));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadCatalogResource("skills", 2)).resolves.toEqual(
      downloadState,
    );
    const unsafeDownload = downloadCatalogResource as unknown as (
      type: string,
      id: number,
    ) => Promise<CatalogDownloadState>;
    await expect(unsafeDownload("agents", 3)).rejects.toThrow(
      "只有 Skill 支持下载",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/agent-platform-api/api/v1/crewon/catalog/resources/skills/2/download",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reads online MCP details directly from the current account APIs", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("online-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/mcp/servers/3")) {
        return Response.json({ id: 3, name: "risk-mcp" });
      }
      if (url.includes("/api/v1/mcp/servers/3/tools")) {
        return Response.json({ items: [{ id: 4, name: "risk_lookup" }] });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readCatalogResourceDetail({
        id: 3,
        type: "mcp_servers",
        name: "Risk MCP",
        description: "",
        source: "online",
      }),
    ).resolves.toEqual({
      id: 3,
      name: "risk-mcp",
      tools: [{ id: 4, name: "risk_lookup" }],
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/agent-platform-api/api/v1/mcp/servers/3",
      "/agent-platform-api/api/v1/mcp/servers/3/tools?page=1&page_size=100",
    ]);
  });

  it("reads catalog Skill details without requiring a prior download", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("online-token");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          id: 8,
          name: "review-skill",
          skill_md_content: "# Review",
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readCatalogResourceDetail({
        id: 8,
        type: "skills",
        name: "review-skill",
        description: "",
        source: "catalog",
      }),
    ).resolves.toEqual({
      id: 8,
      name: "review-skill",
      skill_md_content: "# Review",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "/agent-platform-api/api/v1/crewon/catalog/resources/skills/8",
    );
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer online-token",
    );
  });

  it("does not request knowledge documents when detail access is denied", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("online-token");
    const fetchMock = vi.fn(async () =>
      Response.json({ detail: "forbidden" }, { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readCatalogResourceDetail({
        id: 9,
        type: "knowledge_bases",
        name: "private-kb",
        description: "",
        source: "online",
      }),
    ).rejects.toThrow("forbidden");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/agent-platform-api/api/v1/knowledge/9",
      expect.any(Object),
    );
  });
});
