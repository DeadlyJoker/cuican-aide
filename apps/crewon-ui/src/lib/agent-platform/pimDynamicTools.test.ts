import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPimDynamicTools,
  executePimDynamicTool,
  isPimDynamicToolCall,
} from "./pimDynamicTools";
import {
  clearAgentPlatformSession,
  storeAgentPlatformSession,
} from "./agentPlatformClient";
import { emptyAgentPlatformSnapshot } from "../../components/app/commandWorkspaceState";

describe("PIM dynamic tools", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  afterEach(() => {
    clearAgentPlatformSession();
    vi.unstubAllGlobals();
  });

  it("maps remote MCP and knowledge resources without exporting local Skills", () => {
    const snapshot = {
      ...emptyAgentPlatformSnapshot,
      mcpTools: [
        {
          id: 22,
          server_id: 13,
          name: "echo",
          description: "Echo a message",
          input_schema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
    };

    expect(
      buildPimDynamicTools(
        [
          { execution: "local", id: 29, name: "Local", type: "skills" },
          {
            execution: "remote",
            id: 13,
            name: "test-mcp",
            type: "mcp_servers",
          },
          {
            execution: "remote",
            id: 3,
            name: "docs",
            type: "knowledge_bases",
          },
        ],
        snapshot,
      ),
    ).toEqual([
      expect.objectContaining({
        namespace: "pim",
        name: "mcp_tool_22",
        inputSchema: snapshot.mcpTools[0]?.input_schema,
      }),
      expect.objectContaining({
        namespace: "pim",
        name: "knowledge_search_3",
      }),
    ]);
  });

  it("calls the selected knowledge base and ignores model-supplied ids", async () => {
    storeAgentPlatformSession("user-token");
    const requests: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "null")),
          authorization: headers.get("Authorization"),
        });
        return new Response(JSON.stringify({ results: [{ text: "hit" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const result = await executePimDynamicTool({
      namespace: "pim",
      tool: "knowledge_search_3",
      arguments: { query: "CrewON", knowledge_base_id: 999 },
    });

    expect(requests).toEqual([
      {
        url: expect.stringContaining("/api/v1/knowledge/search"),
        authorization: "Bearer user-token",
        body: expect.objectContaining({
          query: "CrewON",
          knowledge_base_id: 3,
          kb_ids: [3],
        }),
      },
    ]);
    expect(result).toMatchObject({ success: true });
  });

  it("recognizes only the reserved PIM namespace", () => {
    expect(
      isPimDynamicToolCall({ namespace: "pim", tool: "mcp_tool_22" }),
    ).toBe(true);
    expect(
      isPimDynamicToolCall({ namespace: "browser", tool: "mcp_tool_22" }),
    ).toBe(false);
  });
});
