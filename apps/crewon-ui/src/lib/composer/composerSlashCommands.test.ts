import { describe, expect, it } from "vitest";

import type { AppsListResponse } from "@crewon/app-server-protocol/v2/AppsListResponse";
import type { ListMcpServerStatusResponse } from "@crewon/app-server-protocol/v2/ListMcpServerStatusResponse";
import type { SkillsListResponse } from "@crewon/app-server-protocol/v2/SkillsListResponse";

import {
  loadComposerSlashCommands,
  mcpMentionPath,
} from "./composerSlashCommands";

describe("composer slash commands", () => {
  it("loads app, MCP, and skill commands from backend capabilities", async () => {
    const commands = await loadComposerSlashCommands({
      client: {
        async listApps() {
          return {
            data: [
              {
                id: "browser",
                name: "Browser",
                description: "Browse pages",
                isAccessible: true,
                isEnabled: true,
                pluginDisplayNames: [],
              },
            ],
            nextCursor: null,
          } as unknown as AppsListResponse;
        },
        async listMcpServerStatus() {
          return {
            data: [
              {
                name: "github",
                serverInfo: { title: "GitHub", description: "Repo tools" },
                tools: {
                  search: {
                    name: "search",
                    title: "Search issues",
                    description: "Search repository issues",
                    inputSchema: {},
                  },
                },
                resources: [],
                resourceTemplates: [],
                authStatus: "authorized",
              },
            ],
            nextCursor: null,
          } as unknown as ListMcpServerStatusResponse;
        },
        async listSkills() {
          return {
            data: [
              {
                cwd: "/repo",
                errors: [],
                skills: [
                  {
                    name: "code-review",
                    description: "Review diffs",
                    path: "/repo/.crewon/skills/code-review/SKILL.md",
                    enabled: true,
                  },
                ],
              },
            ],
          } as unknown as SkillsListResponse;
        },
      },
      cwd: "/repo",
      isConnected: true,
      isDemoPreview: false,
      threadId: "thread-1",
    });

    expect(commands).toEqual([
      expect.objectContaining({
        kind: "app",
        label: "Browser",
        mention: { name: "Browser", path: "app://browser" },
        token: "$browser",
      }),
      expect.objectContaining({
        kind: "mcp",
        label: "Search issues",
        mention: { name: "github.search", path: "mcp://github" },
        execution: {
          kind: "localMcpTool",
          serverName: "github",
          toolName: "search",
        },
      }),
      expect.objectContaining({
        kind: "skill",
        label: "code-review",
        mention: {
          kind: "skill",
          name: "code-review",
          path: "/repo/.crewon/skills/code-review/SKILL.md",
        },
      }),
    ]);
  });

  it("uses mcp:// server paths for MCP mentions", () => {
    expect(mcpMentionPath("github")).toBe("mcp://github");
  });

  it("omits MCP servers without executable tools", async () => {
    const commands = await loadComposerSlashCommands({
      client: capabilityClient({
        name: "empty-server",
        tools: {},
        authStatus: "authorized",
      }),
      cwd: "/repo",
      isConnected: true,
      isDemoPreview: false,
      threadId: "thread-1",
    });

    expect(commands).toMatchInlineSnapshot(`[]`);
  });

  it("omits MCP servers that require login", async () => {
    const commands = await loadComposerSlashCommands({
      client: capabilityClient({
        name: "private-server",
        tools: {
          search: {
            name: "search",
            description: "Search private data",
            inputSchema: {},
          },
        },
        authStatus: "notLoggedIn",
      }),
      cwd: "/repo",
      isConnected: true,
      isDemoPreview: false,
      threadId: "thread-1",
    });

    expect(commands).toMatchInlineSnapshot(`[]`);
  });
});

function capabilityClient(
  server: Record<string, unknown>,
): Parameters<typeof loadComposerSlashCommands>[0]["client"] {
  return {
    async listApps() {
      return { data: [], nextCursor: null } as unknown as AppsListResponse;
    },
    async listMcpServerStatus() {
      return {
        data: [
          {
            serverInfo: null,
            resources: [],
            resourceTemplates: [],
            ...server,
          },
        ],
        nextCursor: null,
      } as unknown as ListMcpServerStatusResponse;
    },
    async listSkills() {
      return { data: [] } as unknown as SkillsListResponse;
    },
  };
}
