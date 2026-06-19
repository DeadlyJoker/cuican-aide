import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";
import type { FsGetMetadataResponse } from "@crewon-protocol/v2/FsGetMetadataResponse";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "./capabilityPanelTypes";
import {
  attachWorkspaceContextAction,
  loadBrowserAppsAction,
  readWorkspaceFilesAction,
  runTerminalStatusAction,
  type RunTerminalStatusActionParams,
} from "./workspaceCapabilityActions";

type WorkspaceClient = NonNullable<RunTerminalStatusActionParams["client"]>;

function metadata(
  overrides: Partial<FsGetMetadataResponse> = {},
): FsGetMetadataResponse {
  return {
    createdAtMs: 0,
    isDirectory: false,
    isFile: true,
    isSymlink: false,
    modifiedAtMs: 0,
    ...overrides,
  };
}

function appListResponse(): AppsListResponse {
  return {
    data: [
      {
        appMetadata: null,
        branding: null,
        description: null,
        distributionChannel: null,
        id: "browser-tools",
        installUrl: null,
        isAccessible: true,
        isEnabled: true,
        labels: null,
        logoUrl: null,
        logoUrlDark: null,
        name: "Browser Tools",
        pluginDisplayNames: ["browser-plugin"],
      },
    ],
    nextCursor: null,
  };
}

function baseClient(
  overrides: Partial<WorkspaceClient> = {},
): WorkspaceClient {
  return {
    async fuzzyFileSearch() {
      return { files: [] };
    },
    async getMetadata() {
      return metadata();
    },
    async listApps() {
      return appListResponse();
    },
    async listHooks() {
      return { data: [] };
    },
    async listPlugins() {
      return { marketplaces: [] };
    },
    async readDirectory() {
      return { entries: [] };
    },
    async runCommand() {
      return { exitCode: 0, stdout: "ok\n", stderr: null };
    },
    ...overrides,
  };
}

function panelSink(initialPanel: CapabilityPanel | null = null) {
  let panel = initialPanel;
  return {
    get panel() {
      return panel;
    },
    setCapabilityPanel: (
      panelOrUpdater:
        | CapabilityPanel
        | null
        | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
    ) => {
      panel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(panel)
          : panelOrUpdater;
    },
  };
}

function baseParams(overrides: Partial<RunTerminalStatusActionParams> = {}) {
  const sink = panelSink();
  return {
    busyToolId: null,
    client: baseClient(),
    isConnected: true,
    isDemo: false,
    locale: "en",
    resolveBackendCwd: async () => "/repo",
    setBusyToolId: () => {},
    setCapabilityPanel: sink.setCapabilityPanel,
    ...overrides,
  } satisfies Partial<RunTerminalStatusActionParams>;
}

describe("workspace capability actions", () => {
  it("runs terminal status and releases the active process id", async () => {
    const sink = panelSink({ title: "Terminal", body: "previous" });
    const busyStates: Array<string | null> = [];
    const processIds: Array<string | null> = [];
    let currentProcessId: string | null = null;
    const commands: Array<{ command: string; cwd: string; processId: string }> =
      [];

    await runTerminalStatusAction({
      ...baseParams(),
      client: baseClient({
        async runCommand(cwd, command, processId) {
          commands.push({ command, cwd, processId });
          return { exitCode: 0, stdout: "clean\n", stderr: null };
        },
      }),
      processIdFactory: () => "proc-1",
      setBusyToolId: (toolId) => {
        busyStates.push(toolId);
      },
      setCapabilityPanel: sink.setCapabilityPanel,
      setTerminalProcessId: (processId) => {
        currentProcessId = processId;
        processIds.push(processId);
      },
      terminalCommand: "  git status --short  ",
      terminalProcessId: () => currentProcessId,
    });

    expect(commands).toEqual([
      { command: "git status --short", cwd: "/repo", processId: "proc-1" },
    ]);
    expect(processIds).toEqual(["proc-1", null]);
    expect(busyStates).toEqual(["terminal", null]);
    expect(sink.panel).toEqual({
      actions: [
        { id: "send-terminal-to-thread", label: "Send to session" },
        { id: "refresh-background-terminals", label: "Background tasks" },
      ],
      body: "clean",
      commandInput: true,
      subtitle: "git status --short  exit 0",
      title: "Terminal",
    });
  });

  it("reads the workspace file panel from the backend cwd", async () => {
    const sink = panelSink();
    const busyStates: Array<string | null> = [];

    await readWorkspaceFilesAction({
      ...baseParams(),
      client: baseClient({
        async getMetadata(path) {
          expect(path).toBe("/repo");
          return metadata({ isDirectory: true, isFile: false });
        },
        async readDirectory(path) {
          expect(path).toBe("/repo");
          return {
            entries: [
              { fileName: "src", isDirectory: true },
              { fileName: "README.md", isDirectory: false },
            ],
          };
        },
      }),
      setBusyToolId: (toolId) => {
        busyStates.push(toolId);
      },
      setCapabilityPanel: sink.setCapabilityPanel,
    });

    expect(busyStates).toEqual(["files", null]);
    expect(sink.panel).toMatchObject({
      title: "Files",
      subtitle: "/repo",
      items: [
        { label: "> src", path: "/repo/src", kind: "directory" },
        { label: "  README.md", path: "/repo/README.md", kind: "file" },
      ],
    });
  });

  it("opens attach-context results and dock from workspace search", async () => {
    const sink = panelSink();
    const dockStates: boolean[] = [];

    await attachWorkspaceContextAction({
      ...baseParams(),
      client: baseClient({
        async fuzzyFileSearch(query, roots) {
          expect(roots).toEqual(["/repo"]);
          return query === "README.md"
            ? {
                files: [
                  {
                    match_type: "file",
                    path: "README.md",
                    root: "/repo",
                  },
                ],
              }
            : { files: [] };
        },
        async getMetadata() {
          return metadata();
        },
      }),
      setCapabilityDockOpen: (open) => {
        dockStates.push(open);
      },
      setCapabilityPanel: sink.setCapabilityPanel,
    });

    expect(dockStates).toEqual([true]);
    expect(sink.panel?.title).toBe("Attach context");
    expect(sink.panel?.subtitle).toBe("/repo");
    expect(sink.panel?.items).toEqual(
      expect.arrayContaining([
        {
          intent: "attach-context",
          kind: "file",
          label: "  README.md",
          path: "/repo/README.md",
        },
      ]),
    );
  });

  it("loads browser capability data for the selected thread", async () => {
    const sink = panelSink();
    const appThreadIds: Array<string | undefined> = [];

    await loadBrowserAppsAction({
      ...baseParams(),
      client: baseClient({
        async listApps(threadId) {
          appThreadIds.push(threadId);
          return appListResponse();
        },
        async listHooks(cwd) {
          expect(cwd).toBe("/repo");
          return {
            data: [
              {
                hooks: [
                  {
                    enabled: true,
                    eventName: "conversation.start",
                    handlerType: "command",
                  },
                ],
              },
            ],
          };
        },
        async listPlugins(cwd) {
          expect(cwd).toBe("/repo");
          return {
            marketplaces: [
              {
                name: "local",
                path: "/repo/plugins",
                plugins: [
                  {
                    enabled: true,
                    installed: true,
                    name: "browser-plugin",
                    source: { type: "remote" },
                  },
                ],
              },
            ],
          };
        },
      }),
      isDemoPreview: false,
      selectedThreadId: "thread-1",
      setCapabilityPanel: sink.setCapabilityPanel,
    });

    expect(appThreadIds).toEqual(["thread-1"]);
    expect(sink.panel).toMatchObject({
      title: "Browser",
      subtitle: "1 apps · 1 plugins · 1 hooks",
      items: [
        {
          label: "App · Browser Tools · accessible · enabled · browser-plugin",
        },
        {
          label: "Plugin · browser-plugin · remote · enabled",
        },
        {
          label: "Hook · conversation.start · command · enabled",
        },
      ],
    });
  });

  it("opens the attach-context demo panel without backend calls", async () => {
    const sink = panelSink();
    const dockStates: boolean[] = [];

    await attachWorkspaceContextAction({
      ...baseParams({ isDemo: true }),
      client: null,
      setCapabilityDockOpen: (open) => {
        dockStates.push(open);
      },
      setCapabilityPanel: sink.setCapabilityPanel,
    });

    expect(dockStates).toEqual([true]);
    expect(sink.panel).toMatchObject({
      body:
        "Demo mode does not read real files. With app-server connected, this searches README, AGENTS, and knowledge files.",
      subtitle: "Demo mode",
      title: "Attach context",
    });
  });
});
