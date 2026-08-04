import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
  agentPlatformAuthorizedFetch,
  buildAgentPlatformWorkflowGraph,
  clearAgentPlatformSession,
  createAgentPlatformWorkflow,
  getAgentPlatformAccessToken,
  platformAgentsToLibraryItems,
  platformKnowledgeToData,
  platformToolsToLibraryItems,
  readAgentPlatformSnapshot,
  storeAgentPlatformSession,
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
        mcp_servers: [
          {
            server_id: 401,
            enabled: true,
            included_tool_ids: [501],
            excluded_tool_ids: [],
          },
        ],
        config: {},
        is_active: true,
      },
    ],
    knowledgeBases: [
      {
        id: 201,
        user_id: 1,
        name: "Risk Knowledge",
        document_count: 5,
        embedding_model: "text-embedding-v2",
      },
    ],
    skills: [
      {
        id: 301,
        user_id: 1,
        name: "Risk Skill",
        description: "Analyze borrower risk.",
      },
    ],
    mcpServers: [
      {
        id: 401,
        owner_user_id: 1,
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
        server_id: 401,
        name: "risk_lookup",
        alias: "Risk Lookup",
        description: "Look up risk signals.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
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
    clearAgentPlatformSession();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("drops stale auth-session tokens when Principal Session is enabled", async () => {
    // A token from a server that does emit session claims, but whose scoping no
    // longer satisfies the requirements, is genuinely stale.
    vi.stubEnv("VITE_CREWON_PRINCIPAL_SESSION_ENABLED", "true");
    const staleToken = jwt({
      exp: 4_102_444_800,
      tenant_id: null,
      space_id: null,
      crewon_auth_session_id: "",
      crewon_auth_epoch: 0,
    });
    const values = new Map<string, string>([
      [AGENT_PLATFORM_TOKEN_STORAGE_KEY, staleToken],
      [AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY, "legacy-refresh"],
    ]);
    vi.stubGlobal("localStorage", storage(values));

    await expect(getAgentPlatformAccessToken()).resolves.toBeNull();
    expect(values.has(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(false);
    expect(values.has(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(false);
  });

  it("keeps tokens from a server that does not issue auth-session claims", async () => {
    // The deployment predates the scheme, so clearing the token would log the
    // user out immediately after a successful login with no way to recover.
    vi.stubEnv("VITE_CREWON_PRINCIPAL_SESSION_ENABLED", "true");
    const token = jwt({
      exp: 4_102_444_800,
      tenant_id: null,
      space_id: null,
      username: "admin",
    });
    const values = new Map<string, string>([
      [AGENT_PLATFORM_TOKEN_STORAGE_KEY, token],
    ]);
    vi.stubGlobal("localStorage", storage(values));

    await expect(getAgentPlatformAccessToken()).resolves.toBe(token);
    expect(values.get(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(token);
  });

  it("keeps a scoped auth-session token for Principal Session", async () => {
    vi.stubEnv("VITE_CREWON_PRINCIPAL_SESSION_ENABLED", "true");
    const token = jwt({
      exp: 4_102_444_800,
      tenant_id: 1,
      space_id: 1,
      crewon_auth_session_id: "auth-session-1",
      crewon_auth_epoch: 1,
    });
    const values = new Map<string, string>([
      [AGENT_PLATFORM_TOKEN_STORAGE_KEY, token],
    ]);
    vi.stubGlobal("localStorage", storage(values));

    await expect(getAgentPlatformAccessToken()).resolves.toBe(token);
  });

  it("refreshes an expiring scoped session before cloud resource calls", async () => {
    vi.stubEnv("VITE_CREWON_PRINCIPAL_SESSION_ENABLED", "true");
    const expiringToken = jwt({
      exp: Math.floor(Date.now() / 1000) + 5,
      tenant_id: 1,
      space_id: 1,
      crewon_auth_session_id: "auth-session-1",
      crewon_auth_epoch: 1,
    });
    const refreshedToken = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      tenant_id: 1,
      space_id: 1,
      crewon_auth_session_id: "auth-session-1",
      crewon_auth_epoch: 1,
    });
    const values = new Map<string, string>([
      [AGENT_PLATFORM_TOKEN_STORAGE_KEY, expiringToken],
      [AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY, "refresh-one"],
    ]);
    vi.stubGlobal("localStorage", storage(values));
    const fetchMock = vi.fn(async () =>
      Response.json({
        access_token: refreshedToken,
        refresh_token: "refresh-two",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAgentPlatformAccessToken()).resolves.toBe(refreshedToken);
    expect(fetchMock).toHaveBeenCalledWith(
      "/agent-platform-api/api/v1/auth/refresh",
      expect.objectContaining({
        body: new URLSearchParams({ refresh_token: "refresh-one" }),
        method: "POST",
      }),
    );
    expect(values.get(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(refreshedToken);
    expect(values.get(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)).toBe(
      "refresh-two",
    );
  });

  it("refreshes and retries a cloud request rejected with 401", async () => {
    vi.stubEnv("VITE_CREWON_PRINCIPAL_SESSION_ENABLED", "true");
    const accessToken = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      tenant_id: 1,
      space_id: 1,
      crewon_auth_session_id: "auth-session-1",
      crewon_auth_epoch: 1,
    });
    const refreshedToken = jwt({
      exp: Math.floor(Date.now() / 1000) + 7200,
      tenant_id: 1,
      space_id: 1,
      crewon_auth_session_id: "auth-session-1",
      crewon_auth_epoch: 1,
    });
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", storage(values));
    storeAgentPlatformSession(accessToken, "refresh-one");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          access_token: refreshedToken,
          refresh_token: "refresh-two",
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await agentPlatformAuthorizedFetch("/api/v1/mcp/tools");

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/agent-platform-api/api/v1/mcp/tools",
      "/agent-platform-api/api/v1/auth/refresh",
      "/agent-platform-api/api/v1/mcp/tools",
    ]);
    expect(
      new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("Authorization"),
    ).toBe(`Bearer ${refreshedToken}`);
  });

  it("creates a real cloud Workflow without sending the local workspace", async () => {
    const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", storage(values));
    storeAgentPlatformSession(token);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          id: 77,
          name: "交付协作流",
          description: "完成审阅和验收",
          is_active: 1,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const graph = buildAgentPlatformWorkflowGraph([
      {
        agentId: 101,
        instruction: "审阅需求并列出风险",
        title: "需求审阅",
      },
      {
        agentId: 102,
        instruction: "根据审阅结果完成交付检查",
        title: "交付检查",
      },
    ]);

    await expect(
      createAgentPlatformWorkflow({
        description: "完成审阅和验收",
        edges: graph.edges,
        lead: "交付负责人",
        name: "交付协作流",
        nodes: graph.nodes,
      }),
    ).resolves.toMatchObject({
      id: 77,
      name: "交付协作流",
      resource_source: "online",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("/agent-platform-api/api/v1/workflows");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "交付协作流",
      description: "完成审阅和验收",
      nodes: graph.nodes,
      edges: graph.edges,
      config: {
        crewon: {
          collaboration_mode: "workflow",
          lead: "交付负责人",
        },
      },
    });
    expect(String(init?.body)).not.toContain("/Users/");
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "start", type: "input" }),
        expect.objectContaining({
          id: "agent-1",
          type: "agent",
          data: expect.objectContaining({
            agentId: 101,
            title: "需求审阅",
          }),
        }),
        expect.objectContaining({ id: "end", type: "output" }),
      ]),
    );
    expect(graph.edges).toHaveLength(3);
  });

  it("keeps healthy resource categories when Agent and Workflow fail", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/me")) {
        return Response.json({ id: 1, username: "tester", role: "user" });
      }
      if (url.includes("/crewon/catalog")) {
        return Response.json({
          resources: {
            agents: [],
            knowledge_bases: [],
            skills: [
              {
                id: 302,
                name: "Catalog Skill",
                owner_username: "tester",
              },
            ],
            mcp_servers: [],
          },
        });
      }
      if (url.includes("/agents/") || url.includes("/workflows")) {
        return new Response("failed", { status: 500 });
      }
      if (url.includes("/knowledge/")) {
        return Response.json({ items: snapshot().knowledgeBases });
      }
      if (url.includes("/skills")) {
        return Response.json({ items: snapshot().skills });
      }
      if (url.includes("/mcp/servers")) {
        return Response.json({ items: snapshot().mcpServers });
      }
      if (url.includes("page_size=100")) {
        return Response.json({ items: snapshot().mcpTools });
      }
      return Response.json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readAgentPlatformSnapshot();

    expect(result).toMatchObject({
      agents: [],
      knowledgeBases: snapshot().knowledgeBases.map((item) => ({
        ...item,
        resource_source: "online",
      })),
      skills: [
        ...snapshot().skills.map((item) => ({
          ...item,
          resource_source: "online" as const,
        })),
        {
          id: 302,
          name: "Catalog Skill",
          owner_username: "tester",
          resource_source: "catalog",
        },
      ],
      mcpServers: snapshot().mcpServers.map((item) => ({
        ...item,
        resource_source: "online",
      })),
      mcpTools: snapshot().mcpTools,
      workflows: [],
      resourceStates: {
        agents: {
          status: "error",
          error: expect.stringContaining("/api/v1/agents/"),
        },
        knowledge: { status: "ready", error: null },
        skills: { status: "ready", error: null },
        mcp: { status: "ready", error: null },
      },
    });
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/api/v1/crewon/catalog"),
      ),
    ).toHaveLength(1);
  });

  it("keeps valid online empty results and exposes owned catalog resources", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/me")) {
        return Response.json({ id: 7, username: "tester", role: "user" });
      }
      if (url.includes("/api/v1/crewon/catalog")) {
        return Response.json({
          resources: {
            agents: [
              { id: 1, name: "Catalog Agent", owner_username: "tester" },
            ],
            knowledge_bases: [
              { id: 2, name: "Catalog KB", owner_username: "tester" },
            ],
            mcp_servers: [
              { id: 3, name: "Catalog MCP", owner_username: "tester" },
            ],
            skills: [
              { id: 4, name: "Catalog Skill", owner_username: "tester" },
              { id: 5, name: "Other Skill", owner_username: "other" },
            ],
          },
        });
      }
      return Response.json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readAgentPlatformSnapshot();

    expect({
      agents: result.agents,
      knowledgeBases: result.knowledgeBases,
      mcpServers: result.mcpServers,
      mcpTools: result.mcpTools,
      skills: result.skills,
    }).toEqual({
      agents: [
        {
          id: 1,
          name: "Catalog Agent",
          owner_username: "tester",
          resource_source: "catalog",
        },
      ],
      knowledgeBases: [
        {
          id: 2,
          name: "Catalog KB",
          owner_username: "tester",
          resource_source: "catalog",
        },
      ],
      mcpServers: [
        {
          id: 3,
          name: "Catalog MCP",
          owner_username: "tester",
          resource_source: "catalog",
        },
      ],
      mcpTools: [],
      skills: [
        {
          id: 4,
          name: "Catalog Skill",
          owner_username: "tester",
          resource_source: "catalog",
        },
      ],
    });
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/api/v1/crewon/catalog"),
      ),
    ).toHaveLength(1);
  });

  it("merges online and downloadable Skills without duplicate cards", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/me")) {
        return Response.json({ id: 7, username: "tester", role: "user" });
      }
      if (url.includes("/api/v1/crewon/catalog")) {
        return Response.json({
          resources: {
            skills: [
              {
                id: 4,
                name: "Shared Skill",
                owner_username: "tester",
                downloaded: true,
                update_available: true,
              },
              {
                id: 5,
                name: "Downloadable Skill",
                owner_username: "tester",
              },
              {
                id: 6,
                name: "Other User Skill",
                owner_username: "other",
              },
            ],
          },
        });
      }
      if (url.includes("/api/v1/skills")) {
        return Response.json({
          items: [
            {
              id: 4,
              name: "Shared Skill",
              user_id: 7,
              description: "Online description",
            },
          ],
        });
      }
      return Response.json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readAgentPlatformSnapshot();

    expect(result.skills).toEqual([
      {
        id: 4,
        name: "Shared Skill",
        user_id: 7,
        description: "Online description",
        owner_username: "tester",
        downloaded: true,
        update_available: true,
        resource_source: "catalog",
      },
      {
        id: 5,
        name: "Downloadable Skill",
        owner_username: "tester",
        resource_source: "catalog",
      },
    ]);
  });

  it("reports an MCP category error when its Tool list fails", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/me")) {
        return Response.json({ id: 1, username: "tester", role: "user" });
      }
      if (url.includes("/mcp/tools")) {
        return new Response("failed", { status: 500 });
      }
      if (url.includes("/agents/")) {
        return Response.json({
          items: snapshot().agents.map((item) => ({
            ...item,
            user_id: 1,
          })),
        });
      }
      if (url.includes("/knowledge/")) {
        return Response.json({ items: snapshot().knowledgeBases });
      }
      if (url.includes("/skills")) {
        return Response.json({ items: snapshot().skills });
      }
      if (url.includes("/mcp/servers")) {
        return Response.json({ items: snapshot().mcpServers });
      }
      return Response.json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readAgentPlatformSnapshot();

    expect(result.mcpServers).toHaveLength(1);
    expect(result.resourceStates?.mcp).toEqual({
      status: "error",
      error: expect.stringContaining("/api/v1/mcp/tools"),
    });
  });

  it("initializes cards only from the authenticated admin's resources", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "admin-token",
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/me")) {
        return Response.json({ id: 3, username: "admin", role: "admin" });
      }
      if (url.endsWith("/api/v1/crewon/catalog")) {
        return Response.json({
          resources: {
            mcp_servers: [
              { id: 31, name: "Admin MCP", owner_username: "admin" },
              { id: 32, name: "Other MCP", owner_username: "other" },
            ],
          },
        });
      }
      if (/[?&]page_size=1(?:&|$)/.test(url)) {
        return Response.json({ items: [] });
      }
      if (url.includes("/agents/")) {
        return Response.json({
          items: [
            {
              id: 1,
              name: "Admin Agent",
              user_id: 3,
              downloaded: true,
              resource_source: "local",
            },
            { id: 2, name: "Other Agent", user_id: 9 },
          ],
        });
      }
      if (url.includes("/knowledge/")) {
        return Response.json({
          items: [
            {
              id: 11,
              name: "Admin KB",
              user_id: 3,
              downloaded: true,
              resource_source: "local",
            },
            { id: 12, name: "Other KB", user_id: 9 },
          ],
        });
      }
      if (url.includes("/skills")) {
        return Response.json({
          items: [
            {
              id: 21,
              name: "Admin Skill",
              user_id: 3,
              downloaded: true,
              resource_source: "local",
            },
            { id: 22, name: "Other Skill", user_id: 9 },
          ],
        });
      }
      if (url.includes("/mcp/servers")) {
        return Response.json({
          items: [
            {
              id: 31,
              name: "Admin MCP",
              downloaded: true,
              resource_source: "local",
            },
            { id: 32, name: "Other MCP" },
          ],
        });
      }
      if (url.includes("/mcp/tools")) {
        return Response.json({
          items: [
            { id: 41, name: "admin_tool", server_id: 31 },
            { id: 42, name: "other_tool", server_id: 32 },
          ],
        });
      }
      if (url.includes("/workflows")) {
        return Response.json({
          items: [
            { id: 51, name: "Admin Workflow", user_id: 3 },
            { id: 52, name: "Other Workflow", user_id: 9 },
          ],
        });
      }
      return Response.json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readAgentPlatformSnapshot();

    expect({
      agents: result.agents.map((item) => item.name),
      knowledgeBases: result.knowledgeBases.map((item) => item.name),
      skills: result.skills.map((item) => item.name),
      mcpServers: result.mcpServers.map((item) => item.name),
      mcpTools: result.mcpTools.map((item) => item.name),
      workflows: result.workflows.map((item) => item.name),
    }).toEqual({
      agents: ["Admin Agent"],
      knowledgeBases: ["Admin KB"],
      skills: ["Admin Skill"],
      mcpServers: ["Admin MCP"],
      mcpTools: ["admin_tool"],
      workflows: ["Admin Workflow"],
    });
    expect(
      [
        result.agents[0],
        result.knowledgeBases[0],
        result.skills[0],
        result.mcpServers[0],
      ].map((item) => ({
        source: item?.resource_source,
        hasDownloadedFlag: Object.hasOwn(item ?? {}, "downloaded"),
      })),
    ).toEqual([
      { source: "online", hasDownloadedFlag: false },
      { source: "online", hasDownloadedFlag: false },
      { source: "online", hasDownloadedFlag: false },
      { source: "catalog", hasDownloadedFlag: false },
    ]);
  });

  it("treats live database catalog resources as online resources", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "admin-token",
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/me")) {
        return Response.json({ id: 3, username: "admin", role: "admin" });
      }
      if (url.endsWith("/api/v1/crewon/catalog")) {
        return Response.json({
          source: { type: "live_database" },
          resources: {
            skills: [
              {
                id: 75,
                name: "Dgg-数据概览诊断",
                owner_username: "admin",
                downloaded: true,
              },
            ],
          },
        });
      }
      if (/[?&]page_size=1(?:&|$)/.test(url)) {
        return Response.json({ items: [] });
      }
      if (url.includes("/skills")) {
        return Response.json({
          items: [{ id: 75, name: "Dgg-数据概览诊断", user_id: 3 }],
        });
      }
      return Response.json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readAgentPlatformSnapshot();

    expect(result.skills).toEqual([
      expect.objectContaining({
        id: 75,
        name: "Dgg-数据概览诊断",
        resource_source: "online",
      }),
    ]);
    expect(Object.hasOwn(result.skills[0] ?? {}, "downloaded")).toBe(false);
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
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/health");
  });

  it("maps platform agents with bound knowledge, skill, and MCP resources", () => {
    const items = platformAgentsToLibraryItems(snapshot());

    expect(items[0]).toMatchObject({
      title: "Risk Analyst",
      meta: "agent-platform online #101",
      action: {
        type: "agent-config",
        config: {
          model: "qwen-plus",
          systemPrompt: "Use bound resources.",
          skills: [{ id: "301", enabled: true }],
          mcp: [{ id: "401", enabled: true }],
        },
      },
    });
    expect(
      items[0]?.action?.type === "agent-config"
        ? items[0].action.config.agentId
        : null,
    ).toBe("agent-platform:101");
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
        inputSchema: JSON.stringify(
          {
            type: "object",
            properties: { query: { type: "string" } },
          },
          null,
          2,
        ),
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

function storage(values: Map<string, string>): Storage {
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

function jwt(payload: Record<string, unknown>): string {
  return ["header", btoa(JSON.stringify(payload)), "signature"].join(".");
}
