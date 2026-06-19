import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../app-server/appServer";
import type { McpDetailAction, ToolConfig } from "./crewonDomain";
import {
  loadAppToolLibraryItems,
  refreshAppToolActionFromBackend,
} from "./domainToolPersistence";

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function mcpRecord(config: ToolConfig & { kind: "mcp" }) {
  return {
    filePath: ".crewon/tools/github.json",
    savedAt: "2026-01-02T03:04:05Z",
    kind: "mcp" as const,
    config,
  };
}

function mcpAction(
  overrides: Partial<McpDetailAction> = {},
): McpDetailAction {
  return {
    type: "mcp-detail",
    title: "GitHub",
    subtitle: "github",
    body: "Runtime MCP",
    configPath: ".crewon/tools/github.json",
    authStatus: "loggedIn",
    configName: "github",
    resource: {
      server: "github",
      uri: "repo://issues",
      label: "Issues",
    },
    tool: {
      server: "github",
      name: "search_issues",
      label: "Search issues",
      inputSchema: "{}",
    },
    ...overrides,
  };
}

describe("domain tool persistence", () => {
  it("returns no app tool library items when the backend client is missing", async () => {
    await expect(
      loadAppToolLibraryItems({
        client: null,
        cwd: "/repo",
        locale: "en",
      }),
    ).resolves.toEqual([]);
  });

  it("loads app tool library items from backend records", async () => {
    const items = await loadAppToolLibraryItems({
      client: client({
        async listToolConfigs(cwd, kind) {
          expect({ cwd, kind }).toEqual({ cwd: "/repo", kind: undefined });
          return {
            data: [
              mcpRecord({
                kind: "mcp",
                title: "GitHub Tools",
                name: "github",
                description: "Issue automation",
                command: "github-mcp",
                enabled: true,
              }),
            ],
            nextCursor: null,
          };
        },
      }),
      cwd: "/repo",
      locale: "en",
    });

    expect(items).toMatchObject([
      {
        title: "GitHub Tools",
        action: {
          type: "mcp-detail",
          title: "GitHub Tools",
          subtitle: "github",
          configPath: ".crewon/tools/github.json",
        },
      },
    ]);
  });

  it("keeps the current tool action when disconnected", async () => {
    const action = mcpAction();
    const refreshed = await refreshAppToolActionFromBackend({
      action,
      client: client(),
      isConnected: false,
      locale: "en",
      resolveBackendCwd: async () => {
        throw new Error("unexpected resolve");
      },
    });

    expect(refreshed).toBe(action);
  });

  it("keeps the current tool action when the backend workspace is unavailable", async () => {
    const action = mcpAction();
    const refreshed = await refreshAppToolActionFromBackend({
      action,
      client: client({
        async readToolConfig() {
          throw new Error("unexpected read");
        },
      }),
      isConnected: true,
      locale: "en",
      resolveBackendCwd: async () => null,
    });

    expect(refreshed).toBe(action);
  });

  it("refreshes an app tool action from backend records", async () => {
    const action = mcpAction({ title: "Runtime GitHub" });
    const refreshed = await refreshAppToolActionFromBackend({
      action,
      client: client({
        async readToolConfig(cwd, filePath) {
          expect({ cwd, filePath }).toEqual({
            cwd: "/repo",
            filePath: ".crewon/tools/github.json",
          });
          return {
            record: mcpRecord({
              kind: "mcp",
              title: "Saved GitHub",
              name: "github",
              description: "Saved workspace MCP",
              command: "github-mcp",
              enabled: false,
            }),
          };
        },
      }),
      isConnected: true,
      locale: "en",
      resolveBackendCwd: async () => "/repo",
    });

    expect(refreshed).toMatchObject({
      title: "Saved GitHub",
      subtitle: "github",
      authStatus: "loggedIn",
      configName: "github",
      resource: action.resource,
      tool: action.tool,
    });
  });
});
