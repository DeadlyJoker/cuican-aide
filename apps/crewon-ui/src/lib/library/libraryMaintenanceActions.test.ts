import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { DomainConfigKind, LibraryKind, LibraryPanelAction } from "../domain/crewonDomain";
import { handleLibraryMaintenanceAction } from "./libraryMaintenanceActions";

type CapturedMaintenanceState = {
  deletedDomainConfigs: Array<{
    cwd: string;
    filePath: string;
    kind?: DomainConfigKind;
  }>;
  deletedMcpServers: string[];
  deletedToolRecords: Array<{ cwd: string; serverName: string }>;
  librariesOpened: LibraryKind[];
  mcpReloads: number;
  notice: NoticeState | null;
};

async function handleAction(
  action: LibraryPanelAction,
  options: {
    cwd?: string | null;
    fallbackLibraryKind?: LibraryKind;
    deletedToolRecord?: string | null;
  } = {},
): Promise<{ handled: boolean; state: CapturedMaintenanceState }> {
  const state: CapturedMaintenanceState = {
    deletedDomainConfigs: [],
    deletedMcpServers: [],
    deletedToolRecords: [],
    librariesOpened: [],
    mcpReloads: 0,
    notice: null,
  };

  const handled = await handleLibraryMaintenanceAction({
    action,
    deleteDomainConfigFile: async (cwd, filePath, kind) => {
      state.deletedDomainConfigs.push({ cwd, filePath, kind });
    },
    deleteMcpServerConfig: async (serverName) => {
      state.deletedMcpServers.push(serverName);
    },
    deleteMcpToolConfigRecord: async (cwd, serverName) => {
      state.deletedToolRecords.push({ cwd, serverName });
      return options.deletedToolRecord ?? "/repo/.crewon/tools/github.json";
    },
    fallbackLibraryKind: options.fallbackLibraryKind ?? "agents",
    locale: "en",
    openLibrary: async (kind) => {
      state.librariesOpened.push(kind);
    },
    reloadMcpServers: async () => {
      state.mcpReloads += 1;
    },
    resolveBackendCwd: async () =>
      Object.hasOwn(options, "cwd") ? (options.cwd ?? null) : "/repo",
    setNotice: (notice) => {
      state.notice = notice;
    },
  });

  return { handled, state };
}

describe("library maintenance actions", () => {
  it("reloads tools and plugins", async () => {
    expect(
      await handleAction({ id: "reload-tools", label: "Reload tools" }),
    ).toMatchObject({
      handled: true,
      state: { librariesOpened: ["tools"], mcpReloads: 1 },
    });

    expect(
      await handleAction({ id: "reload-plugins", label: "Reload plugins" }),
    ).toMatchObject({
      handled: true,
      state: { librariesOpened: ["plugins"], mcpReloads: 0 },
    });
  });

  it("deletes domain config files and refreshes the current library", async () => {
    const { handled, state } = await handleAction(
      {
        id: "delete-config-file",
        label: "Delete",
        pathToOpen: "/repo/.crewon/agents/a.json",
        domainConfigKind: "agent",
      },
      { fallbackLibraryKind: "agents" },
    );

    expect(handled).toBe(true);
    expect(state.deletedDomainConfigs).toEqual([
      {
        cwd: "/repo",
        filePath: "/repo/.crewon/agents/a.json",
        kind: "agent",
      },
    ]);
    expect(state.librariesOpened).toEqual(["agents"]);
    expect(state.notice).toEqual({
      text: "Deleted backend record: /repo/.crewon/agents/a.json",
      tone: "success",
    });
  });

  it("deletes MCP config and matching tool records", async () => {
    const { handled, state } = await handleAction({
      id: "delete-mcp-config",
      label: "Delete MCP",
      mcpServerName: "github",
    });

    expect(handled).toBe(true);
    expect(state.deletedMcpServers).toEqual(["github"]);
    expect(state.deletedToolRecords).toEqual([
      { cwd: "/repo", serverName: "github" },
    ]);
    expect(state.librariesOpened).toEqual(["tools"]);
    expect(state.notice).toEqual({
      text: "Deleted MCP config: github (tool-library record: /repo/.crewon/tools/github.json)",
      tone: "success",
    });
  });

  it("throws connected workspace errors for domain deletes without cwd", async () => {
    await expect(
      handleAction(
        {
          id: "delete-config-file",
          label: "Delete",
          pathToOpen: "/repo/.crewon/agents/a.json",
        },
        { cwd: null },
      ),
    ).rejects.toThrow("Local app-server is not connected");
  });

  it("leaves unrelated actions for the app handler", async () => {
    const { handled } = await handleAction({
      id: "open-thread",
      label: "Open",
      threadId: "thread-1",
    });

    expect(handled).toBe(false);
  });
});
