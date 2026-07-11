import { afterEach, describe, expect, it, vi } from "vitest";

import {
  platformAgentsToLibraryItems,
  platformKnowledgeToData,
  platformToolsToLibraryItems,
  readAgentPlatformSnapshot,
  type AgentPlatformSnapshot,
} from "./agentPlatformClient";

function snapshot(): AgentPlatformSnapshot {
  return {
    agents: [
      {
        id: 101,
        name: "Risk Analyst",
        description: "Reviews credit risk",
        system_prompt: "Use bound resources.",
        model_info: { model_name: "qwen-plus" },
        knowledge_base_ids: [201],
        skill_ids: [301],
        mcp_servers: ["risk-mcp"],
        config: {},
        is_active: true,
      },
    ],
    knowledgeBases: [
      {
        id: 201,
        name: "Risk Knowledge",
        document_count: 5,
        embedding_model: "text-embedding-v2",
      },
    ],
    skills: [
      {
        id: 301,
        name: "Risk Skill",
        description: "Analyze borrower risk.",
      },
    ],
    mcpServers: [
      {
        id: 401,
        name: "risk-mcp",
        alias: "Risk MCP",
        description: "Risk tools",
        is_enabled: true,
        is_connected: false,
      },
    ],
    mcpTools: [
      {
        id: 501,
        name: "risk_lookup",
        alias: "Risk Lookup",
        description: "Look up risk signals.",
        server_name: "risk-mcp",
        schema: { type: "object" },
      },
    ],
    workflows: [
      {
        id: 601,
        name: "Risk Workflow",
        description: "Review, check, approve.",
        status: "active",
        is_active: true,
      },
    ],
  };
}

describe("agent-platform client mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("short-circuits concurrent snapshot reads when the local resource service is unavailable", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0]) => {
      return new Response(
        JSON.stringify({
          error: "agent-platform unavailable",
        }),
        {
          status: 503,
          statusText: "Service Unavailable",
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.allSettled([
      readAgentPlatformSnapshot(),
      readAgentPlatformSnapshot(),
    ]);

    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/mcp/tools");
  });

  it("maps platform agents with bound knowledge, skill, and MCP resources", () => {
    const items = platformAgentsToLibraryItems(snapshot());

    expect(items[0]).toMatchObject({
      title: "Risk Analyst",
      meta: "agent-platform local #101",
      action: {
        type: "agent-config",
        config: {
          agentId: "agent-platform:101",
          model: "qwen-plus",
          systemPrompt: "Use bound resources.",
          skills: [{ id: "301", enabled: true }],
          mcp: [{ id: "401", enabled: true }],
        },
      },
    });
  });

  it("maps MCP servers and skills into tool library cards", () => {
    const items = platformToolsToLibraryItems(snapshot());

    expect(items.map((item) => item.title)).toEqual(["Risk MCP", "Risk Skill"]);
    expect(items[0].action).toMatchObject({
      type: "mcp-detail",
      title: "Risk MCP",
      tool: {
        server: "risk-mcp",
        name: "risk_lookup",
      },
    });
    expect(items[1].action).toMatchObject({
      type: "skill-file",
      skillName: "Risk Skill",
      path: "agent-platform://skills/301",
    });
  });

  it("maps knowledge bases and agent bindings into knowledge data", () => {
    const data = platformKnowledgeToData(snapshot());

    expect(data.sources).toMatchObject([
      {
        name: "Risk Knowledge",
        meta: "5 documents · text-embedding-v2",
      },
    ]);
    expect(data.memories).toMatchObject([
      {
        title: "Risk Analyst",
        kind: "Agent binding",
        preview: "1 knowledge bases · 1 skills · 1 MCP servers",
      },
    ]);
  });
});
