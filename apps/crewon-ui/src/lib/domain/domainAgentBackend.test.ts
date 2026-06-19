import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import { createDefaultAgentConfig } from "../agent-config/agentConfigDefaults";
import {
  createAppBackendAgentConfig,
  loadAppAgentLibraryItems,
  writeAppAgentConfig,
} from "./domainAgentBackend";

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function backendAgentClient(captures: {
  configCwds: Array<string | null | undefined>;
  permissionCwds: Array<string | undefined>;
  skillCwds: Array<string | undefined>;
  statusThreadIds: Array<string | undefined>;
}): AppServerClient {
  return client({
    async listMcpServerConfigs(params) {
      captures.configCwds.push(params?.cwd);
      return {
        data: [
          {
            name: "github",
            config: { enabled: true, command: "github-mcp" },
          },
        ],
        nextCursor: null,
      } as unknown as Awaited<
        ReturnType<AppServerClient["listMcpServerConfigs"]>
      >;
    },
    async listMcpServerStatus(threadId) {
      captures.statusThreadIds.push(threadId);
      return {
        data: [
          {
            name: "github",
            authStatus: "loggedIn",
            resources: [],
            resourceTemplates: [],
            serverInfo: { name: "github", title: "GitHub" },
            tools: {
              search_issues: {
                description: "Search issues",
                inputSchema: {},
                name: "search_issues",
              },
            },
          },
        ],
        nextCursor: null,
      } as unknown as Awaited<
        ReturnType<AppServerClient["listMcpServerStatus"]>
      >;
    },
    async listModels() {
      return {
        data: [
          { model: "gpt-5", isDefault: true },
          { model: "o4-mini", isDefault: false },
        ],
        nextCursor: null,
      } as Awaited<ReturnType<AppServerClient["listModels"]>>;
    },
    async listPermissionProfiles(cwd) {
      captures.permissionCwds.push(cwd);
      return {
        data: [
          {
            id: "workspace-write",
            description: "Write files",
          },
        ],
        nextCursor: null,
      } as unknown as Awaited<
        ReturnType<AppServerClient["listPermissionProfiles"]>
      >;
    },
    async listSkills(cwd) {
      captures.skillCwds.push(cwd);
      return {
        data: [
          {
            skills: [
              {
                enabled: true,
                name: "review",
                path: "review",
                scope: "repo",
                shortDescription: "Review code",
                description: "Review code",
              },
            ],
          },
        ],
      } as unknown as Awaited<ReturnType<AppServerClient["listSkills"]>>;
    },
  });
}

describe("domain agent backend", () => {
  it("returns no app agent library items when the backend client is missing", async () => {
    await expect(
      loadAppAgentLibraryItems({
        client: null,
        cwd: "/repo",
        locale: "en",
      }),
    ).resolves.toEqual({ items: [] });
  });

  it("loads app agent library items from backend records", async () => {
    const items = await loadAppAgentLibraryItems({
      client: client({
        async listAgentConfigs(cwd) {
          expect(cwd).toBe("/repo");
          return {
            data: [
              {
                filePath: ".crewon/agents/reviewer.json",
                savedAt: "2026-01-02T03:04:05Z",
                config: {
                  ...createDefaultAgentConfig("en"),
                  name: "Reviewer",
                  role: "Reviews code",
                },
              },
            ],
            nextCursor: null,
          };
        },
      }),
      cwd: "/repo",
      locale: "en",
    });

    expect(items).toMatchObject({
      items: [
        {
          title: "Reviewer",
          action: {
            configPath: ".crewon/agents/reviewer.json",
            type: "agent-config",
          },
        },
      ],
    });
  });

  it("writes an app agent config through the resolved backend workspace", async () => {
    const config = createDefaultAgentConfig("en");
    const captures: unknown[] = [];
    const result = await writeAppAgentConfig({
      client: client({
        async readAgentConfig(cwd, params) {
          captures.push({ cwd, params });
          return { record: null };
        },
        async createAgentConfig(cwd, agentConfig) {
          captures.push({ cwd, agentConfig });
          return {
            agentId: "agent-1",
            filePath: ".crewon/agents/agent.json",
          };
        },
      }),
      config,
      resolveBackendCwd: async () => "/repo",
    });

    expect(captures).toEqual([
      {
        cwd: "/repo",
        params: {
          agentId: config.agentId ?? null,
          name: config.name,
          threadId: config.threadId ?? null,
        },
      },
      {
        agentConfig: config,
        cwd: "/repo",
      },
    ]);
    expect(result).toEqual({
      agentId: "agent-1",
      filePath: ".crewon/agents/agent.json",
    });
  });

  it("skips app agent config writes when the backend workspace is unavailable", async () => {
    await expect(
      writeAppAgentConfig({
        client: client({
          async readAgentConfig() {
            throw new Error("unexpected read");
          },
        }),
        config: createDefaultAgentConfig("en"),
        resolveBackendCwd: async () => "",
      }),
    ).resolves.toBeNull();
  });

  it("returns a default config when disconnected or missing a client", async () => {
    await expect(
      createAppBackendAgentConfig({
        client: backendAgentClient({
          configCwds: [],
          permissionCwds: [],
          skillCwds: [],
          statusThreadIds: [],
        }),
        currentCwd: "/repo",
        isConnected: false,
        isDemoPreview: false,
        locale: "en",
        resolveBackendCwd: async () => {
          throw new Error("unexpected resolve");
        },
        selectedThreadId: "thread-1",
      }),
    ).resolves.toEqual(createDefaultAgentConfig("en"));

    await expect(
      createAppBackendAgentConfig({
        client: null,
        currentCwd: "/repo",
        isConnected: true,
        isDemoPreview: false,
        locale: "zh",
        resolveBackendCwd: async () => {
          throw new Error("unexpected resolve");
        },
        selectedThreadId: "thread-1",
      }),
    ).resolves.toEqual(createDefaultAgentConfig("zh"));
  });

  it("creates a backend agent config from the current backend thread", async () => {
    const captures = {
      configCwds: [] as Array<string | null | undefined>,
      permissionCwds: [] as Array<string | undefined>,
      skillCwds: [] as Array<string | undefined>,
      statusThreadIds: [] as Array<string | undefined>,
    };

    const config = await createAppBackendAgentConfig({
      client: backendAgentClient(captures),
      currentCwd: "/repo/current",
      isConnected: true,
      isDemoPreview: false,
      locale: "en",
      resolveBackendCwd: async () => {
        throw new Error("unexpected resolve");
      },
      selectedThreadId: "thread-1",
    });

    expect(captures).toEqual({
      configCwds: ["/repo/current"],
      permissionCwds: ["/repo/current"],
      skillCwds: ["/repo/current"],
      statusThreadIds: ["thread-1"],
    });
    expect(config).toMatchObject({
      model: "gpt-5",
      models: ["gpt-5", "o4-mini"],
      permission: "workspace-write",
      permissions: ["workspace-write"],
      role: "Backend-capable agent · recruitable",
    });
    expect(config.mcp[0]).toMatchObject({ id: "github", enabled: true });
    expect(config.skills[0]).toMatchObject({ id: "review", enabled: true });
  });

  it("uses resolved workspace and no thread id in demo preview", async () => {
    const captures = {
      configCwds: [] as Array<string | null | undefined>,
      permissionCwds: [] as Array<string | undefined>,
      skillCwds: [] as Array<string | undefined>,
      statusThreadIds: [] as Array<string | undefined>,
    };

    await createAppBackendAgentConfig({
      client: backendAgentClient(captures),
      currentCwd: "/demo/current",
      isConnected: true,
      isDemoPreview: true,
      locale: "en",
      resolveBackendCwd: async () => "/repo/resolved",
      selectedThreadId: "demo-1",
    });

    expect(captures).toEqual({
      configCwds: ["/repo/resolved"],
      permissionCwds: ["/repo/resolved"],
      skillCwds: ["/repo/resolved"],
      statusThreadIds: [undefined],
    });
  });
});
