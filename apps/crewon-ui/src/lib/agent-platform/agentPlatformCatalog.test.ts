import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { storeAgentPlatformSession } from "./agentPlatformClient";
import {
  callCatalogMcpTool,
  downloadCatalogResource,
  installCatalogSkill,
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

  it("downloads installable Skill and MCP catalog resources", async () => {
    expectTypeOf(downloadCatalogResource)
      .parameter(0)
      .toEqualTypeOf<"skills" | "mcp_servers">();
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
    await expect(
      downloadCatalogResource("mcp_servers", 3),
    ).resolves.toEqual(downloadState);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/agent-platform-api/api/v1/crewon/catalog/resources/skills/2/download",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/agent-platform-api/api/v1/crewon/catalog/resources/mcp_servers/3/download",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("calls online MCP tools with their argument object", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("online-token");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ tool_name: "echo", result: { content: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callCatalogMcpTool(
        {
          id: 3,
          type: "mcp_servers",
          name: "Echo MCP",
          description: "",
          source: "online",
        },
        9,
        { message: "hello" },
      ),
    ).resolves.toEqual({ tool_name: "echo", result: { content: [] } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/agent-platform-api/api/v1/mcp/tools/9/call");
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
      }),
    );
  });

  it("bridges a downloaded cloud Skill into the local CrewON save flow", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("online-token");
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        return url.endsWith("/download")
          ? Response.json({
              downloaded: true,
              downloaded_at: "2026-07-28T00:00:00Z",
              update_available: false,
            })
          : Response.json({
              path: "SKILL.md",
              type: "file",
              content:
                "---\nname: cloud-review\ndescription: Review delivery\n---\n# Workflow\n\n- Inspect evidence.",
            });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const saveCapability = vi.fn(async () => {});

    await installCatalogSkill(
      {
        id: 8,
        type: "skills",
        name: "Cloud Review",
        description: "Review delivery",
        source: "catalog",
      },
      saveCapability,
    );

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/agent-platform-api/api/v1/crewon/catalog/resources/skills/8/download",
      "/agent-platform-api/api/v1/crewon/catalog/resources/skills/8/files?path=SKILL.md",
    ]);
    expect(saveCapability).toHaveBeenCalledWith({
      kind: "skill",
      name: "Cloud Review",
      description: "Review delivery",
      workflow: "# Workflow\n\n- Inspect evidence.",
    });
  });

  it("installs an online cloud Skill without a catalog download", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("online-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.endsWith("/files")
        ? Response.json({ file_tree: ["SKILL.md"] })
        : Response.json({ content: "# Online workflow\n\n- Run it." });
    });
    vi.stubGlobal("fetch", fetchMock);
    const saveCapability = vi.fn(async () => {});

    await installCatalogSkill(
      {
        id: 9,
        type: "skills",
        name: "Online Skill",
        description: "Online instructions",
        source: "online",
      },
      saveCapability,
    );

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/agent-platform-api/api/v1/skills/9/files",
      "/agent-platform-api/api/v1/skills/9/files/SKILL.md",
    ]);
    expect(saveCapability).toHaveBeenCalledWith({
      kind: "skill",
      name: "Online Skill",
      description: "Online instructions",
      workflow: "# Online workflow\n\n- Run it.",
    });
  });

  it("installs a catalog MCP service before its first tool call", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("online-token");
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        return url.endsWith("/download")
          ? Response.json({
              downloaded: true,
              downloaded_at: "2026-07-28T00:00:00Z",
              update_available: false,
            })
          : Response.json({ tool_name: "search", result: { content: [] } });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await callCatalogMcpTool(
      {
        id: 4,
        type: "mcp_servers",
        name: "Search MCP",
        description: "",
        source: "catalog",
        downloaded: false,
      },
      10,
      { q: "hello" },
    );

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/agent-platform-api/api/v1/crewon/catalog/resources/mcp_servers/4/download",
      "/agent-platform-api/api/v1/crewon/catalog/resources/mcp_servers/4/tools/10/call",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ arguments: { q: "hello" } }),
      }),
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
