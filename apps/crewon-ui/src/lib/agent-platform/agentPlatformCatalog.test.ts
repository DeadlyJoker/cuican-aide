import { afterEach, describe, expect, it, vi } from "vitest";

import { storeAgentPlatformSession } from "./agentPlatformClient";
import {
  invokeCatalogAgent,
  invokeCatalogMcpTool,
  invokeCatalogSkill,
  searchCatalogKnowledge,
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

  it("sends typed Agent, Skill, MCP, and knowledge operations", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("local-token");
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await invokeCatalogAgent(1, "hello");
    await invokeCatalogSkill(2, "scripts/run.py", ["--help"]);
    await invokeCatalogMcpTool(3, 4, { query: "risk" });
    await searchCatalogKnowledge(5, "policy", 6);

    expect(
      fetchMock.mock.calls.map(([url, init]) => ({
        body: JSON.parse(String(init?.body)),
        method: init?.method,
        url: String(url),
      })),
    ).toEqual([
      {
        body: { inputs: { query: "hello" }, channel: "crewon" },
        method: "POST",
        url: "/agent-platform-api/api/v1/crewon/catalog/resources/agents/1/run",
      },
      {
        body: { script: "scripts/run.py", args: ["--help"], timeout: 30 },
        method: "POST",
        url: "/agent-platform-api/api/v1/crewon/catalog/resources/skills/2/run",
      },
      {
        body: { arguments: { query: "risk" } },
        method: "POST",
        url: "/agent-platform-api/api/v1/crewon/catalog/resources/mcp_servers/3/tools/4/call",
      },
      {
        body: { query: "policy", top_k: 6, search_mode: "keyword" },
        method: "POST",
        url: "/agent-platform-api/api/v1/crewon/catalog/resources/knowledge_bases/5/search",
      },
    ]);
  });
});
