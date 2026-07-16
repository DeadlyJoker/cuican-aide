import { describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../../app-server/appServer";
import type { BackendWorkspace } from "../../backend/backendWorkspace";
import type {
  AgentConfig,
  AutomationConfig,
  LibraryPanelAction,
  OfficeConfig,
  ToolConfig,
} from "../../domain/crewonDomain";
import type { AutomationRunRecord } from "../../library/libraryAutomationRunActions";
import type { LibraryPanelActionHandlersParams } from "../../library/libraryPanelActionHandlers";

const factorySpy = vi.hoisted(() => ({
  lastParams: null as LibraryPanelActionHandlersParams | null,
  create: vi.fn((params: LibraryPanelActionHandlersParams) => {
    factorySpy.lastParams = params;
    return {
      connectedHandlers: [],
      deferredHandlers: [],
      immediateHandlers: [],
    };
  }),
}));

vi.mock("../../library/libraryPanelActionHandlers", () => ({
  createLibraryPanelActionHandlers: factorySpy.create,
}));

const { createAppLibraryPanelActionHandlers } = await import(
  "./appLibraryPanelActionHandlers"
);

type AppLibraryPanelActionHandlersParams = Parameters<
  typeof createAppLibraryPanelActionHandlers
>[0];

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function capturedParams(): LibraryPanelActionHandlersParams {
  const params = factorySpy.lastParams;
  if (!params) {
    throw new Error("factory was not called");
  }
  return params;
}

function createHandlers(
  overrides: Partial<AppLibraryPanelActionHandlersParams> = {},
) {
  const action = {
    id: "reload-tools",
    label: "Reload",
  } satisfies LibraryPanelAction;

  createAppLibraryPanelActionHandlers({
    action,
    client: client(),
    confirm: () => true,
    createBackendAgentConfig: async () => ({} as AgentConfig),
    ensureBackendToolThread: async () => null,
    ensureOfficeThread: async () => null,
    handleCapabilityPanelItem: () => {},
    isConnected: true,
    isDemo: false,
    isDemoPreview: false,
    isMissingThreadError: () => false,
    isUnsupportedRpcError: () => false,
    libraryPanel: null,
    locale: "en",
    openLibrary: async () => {},
    optionalBackendWorkspace: async () => null,
    persistOfficeMember: async () => null,
    readAutomationRunItems: async () => [],
    readLatestOfficeConfig: async () => null,
    readRecruitableAgentConfig: async () => null,
    recordAutomationRunForTurn: () => {},
    recordOfficeRunTurn: () => {},
    recordBackendToolEvent: async () => {},
    requireBackendWorkspace: async () => {
      throw new Error("unexpected backend workspace requirement");
    },
    resolveBackendCwd: async () => "/repo",
    runAutomationConfig: async () => ({ record: null, warning: null }),
    selectedThreadId: null,
    setAppView: () => {},
    setCapabilityDockOpen: () => {},
    setCapabilityPanel: () => {},
    setLibraryPanel: () => {},
    setNotice: () => {},
    setSelectedThreadId: () => {},
    setThreads: () => {},
    startBackendDomainThread: async () => null,
    updateAutomationRun: async () => {},
    writeAgentConfigFile: async () => null,
    writeAutomationConfigFile: async () => null,
    writeKnowledgeMemory: async () => null,
    writeOfficeConfigFile: async () => null,
    ...overrides,
  });
}

describe("app library panel action handlers", () => {
  it("uses the selected thread as MCP resource context outside demo preview", () => {
    createHandlers({ selectedThreadId: "thread-1" });

    expect(capturedParams().mcp.resourceContextThreadId).toBe("thread-1");

    createHandlers({ isDemoPreview: true, selectedThreadId: "thread-1" });

    expect(capturedParams().mcp.resourceContextThreadId).toBeUndefined();
  });

  it("scopes Office record deletion to the Office group-chat workspace", async () => {
    const setLibraryPanel = vi.fn();
    createHandlers({
      libraryPanel: {
        actions: [],
        items: [],
        kind: "office",
        subtitle: "Office",
        title: "Office",
        workspaceCwd: "/repo/team",
      },
      resolveBackendCwd: async () => "/repo/single-chat",
      setLibraryPanel,
    });

    const maintenance = capturedParams().maintenance;
    expect(maintenance.domainConfigCwd).toBe("/repo/team");
    await maintenance.onDomainConfigDeleted?.();
    expect(setLibraryPanel).toHaveBeenCalledWith(null);
  });

  it("wires MCP draft and maintenance mutations to the current client", async () => {
    const calls: unknown[] = [];
    createHandlers({
      client: client({
        async deleteMcpServerConfig(params) {
          calls.push({ method: "deleteMcpServerConfig", params });
          return null as unknown as Awaited<
            ReturnType<AppServerClient["deleteMcpServerConfig"]>
          >;
        },
        async saveMcpServerConfig(params) {
          calls.push({ method: "saveMcpServerConfig", params });
          return null as unknown as Awaited<
            ReturnType<AppServerClient["saveMcpServerConfig"]>
          >;
        },
      }),
    });

    const params = capturedParams();
    await params.draft.reloadMcpServerConfig({
      config: {
        args: ["--stdio"],
        command: "node",
        enabled: false,
        env: {},
      },
      name: "docs",
    });
    await params.maintenance.deleteMcpServerConfig("docs");

    expect(calls).toEqual([
      {
        method: "saveMcpServerConfig",
        params: {
          config: {
            args: ["--stdio"],
            command: "node",
            enabled: false,
            env: {},
          },
          name: "docs",
          reload: true,
        },
      },
      {
        method: "deleteMcpServerConfig",
        params: { name: "docs", reload: true },
      },
    ]);
  });

  it("keeps automation config access behind the backend workspace guard", async () => {
    const calls: unknown[] = [];
    const workspace = {
      client: client({
        async listAgentConfigs(cwd) {
          calls.push({ cwd, method: "listAgentConfigs" });
          return { data: [], nextCursor: null };
        },
      }),
      cwd: "/repo",
    } satisfies BackendWorkspace;

    createHandlers({
      requireBackendWorkspace: async (message) => {
        calls.push({ message, method: "requireBackendWorkspace" });
        return workspace;
      },
    });

    await capturedParams().automationCreate.listAgentConfigs();

    expect(calls).toEqual([
      {
        message: "Creating an automation requires an available backend workspace.",
        method: "requireBackendWorkspace",
      },
      { cwd: "/repo", method: "listAgentConfigs" },
    ]);
  });

  it("passes automation run records back to App state wiring", () => {
    const recordAutomationRunForTurn = vi.fn();
    createHandlers({ recordAutomationRunForTurn });

    const record = {
      filePath: "automation.json",
      runId: "run-1",
      threadId: "thread-1",
    } satisfies AutomationRunRecord & { threadId: string };
    capturedParams().automationRun.recordAutomationRunForTurn("turn-1", record);

    expect(recordAutomationRunForTurn).toHaveBeenCalledWith("turn-1", record);
  });

  it("passes office run records back to App state wiring", () => {
    const recordOfficeRunTurn = vi.fn();
    createHandlers({ recordOfficeRunTurn });

    const record = {
      cwd: "/repo",
      runId: "office-run-1",
      threadId: "office-thread",
      config: {
        title: "Office",
        subtitle: "Workspace",
        workspace: { goal: "", members: [], messages: [], tasks: [] },
      },
    };
    capturedParams().automationRun.recordOfficeRunTurn?.("turn-1", record);

    expect(recordOfficeRunTurn).toHaveBeenCalledWith("turn-1", record);
  });

  it("runs automation actions through the bound target office", async () => {
    const calls: unknown[] = [];
    const canonicalOffice: OfficeConfig = {
      title: "Canonical Office",
      subtitle: "Current workspace",
      workspace: {
        goal: "Canonical goal",
        members: [],
        messages: [],
        recordId: "office-record-1",
        recordRevision: "revision-2",
        tasks: [],
        threadId: "office-thread",
      },
    };
    createHandlers({
      client: client({
        async readOfficeConfig(cwd, params) {
          calls.push({ cwd, method: "readOfficeConfig", params });
          return {
            record: {
              config: canonicalOffice,
              filePath: "/repo/.crewon/offices/office.json",
              savedAt: "2026-07-13T00:00:00Z",
            },
          };
        },
        async runOfficeConfig(cwd, config, message, text, locale, threadId) {
          calls.push({
            config,
            cwd,
            locale,
            message,
            method: "runOfficeConfig",
            text,
            threadId,
          });
          return {
            filePath: "/repo/.crewon/offices/office.json",
            config,
            runId: "office-run-1",
            threadId: threadId ?? "",
            turn: {
              id: "turn-office",
              items: [],
              itemsView: "full",
              status: "inProgress",
              error: null,
              startedAt: 1,
              completedAt: null,
              durationMs: null,
            },
          };
        },
      }),
    });

    const targetOffice: OfficeConfig = {
      title: "Office",
      subtitle: "Workspace",
      workspace: {
        goal: "Stale goal",
        members: [],
        messages: [],
        recordId: "office-record-1",
        recordRevision: "revision-1",
        tasks: [],
        threadId: "office-thread",
      },
    };
    const automationConfig: AutomationConfig = {
      title: "Nightly",
      subtitle: "Manual",
      body: "Body",
      prompt: "Prompt",
      targetOffice,
      executionAgent: null,
    };

    const result = await capturedParams().automationRun.runOfficeAutomation?.(
      automationConfig,
      "Run office",
    );

    expect(result?.cwd).toBe("/repo");
    expect(result?.response?.runId).toBe("office-run-1");
    expect(calls).toEqual([
      {
        cwd: "/repo",
        method: "readOfficeConfig",
        params: { threadId: "office-thread", title: null },
      },
      expect.objectContaining({
        config: canonicalOffice,
        cwd: "/repo",
        locale: "en",
        method: "runOfficeConfig",
        text: "Run office",
        threadId: "office-thread",
      }),
    ]);
    expect(calls[1]).toMatchObject({
      message: {
        author: "Nightly",
        glyph: "A",
        accent: "violet",
        text: "Run office",
        kind: "task",
      },
    });
  });

  it("does not run an office automation when the canonical record identity changed", async () => {
    const runOfficeConfig = vi.fn();
    createHandlers({
      client: client({
        async readOfficeConfig() {
          return {
            record: {
              config: {
                title: "Replacement Office",
                subtitle: "Workspace",
                workspace: {
                  goal: "Different record",
                  members: [],
                  messages: [],
                  recordId: "office-record-2",
                  recordRevision: "revision-1",
                  tasks: [],
                  threadId: "office-thread",
                },
              },
              filePath: "/repo/.crewon/offices/replacement.json",
              savedAt: "2026-07-13T00:00:00Z",
            },
          };
        },
        runOfficeConfig,
      }),
    });

    const automationConfig: AutomationConfig = {
      title: "Nightly",
      subtitle: "Manual",
      body: "Body",
      prompt: "Prompt",
      targetOffice: {
        title: "Office",
        subtitle: "Workspace",
        workspace: {
          goal: "Stale goal",
          members: [],
          messages: [],
          recordId: "office-record-1",
          recordRevision: "revision-1",
          tasks: [],
          threadId: "office-thread",
        },
      },
      executionAgent: null,
    };

    await expect(
      capturedParams().automationRun.runOfficeAutomation?.(
        automationConfig,
        "Run office",
      ),
    ).rejects.toThrow("Canonical Office recordId does not match the target");
    expect(runOfficeConfig).not.toHaveBeenCalled();
  });

  it("passes tool records through draft persistence without changing shape", async () => {
    const toolRecord = {
      command: "node server.js",
      kind: "skill",
      name: "docs-search",
      title: "Docs Search",
    } as ToolConfig;
    const calls: unknown[] = [];

    createHandlers({
      client: client({
        async listToolConfigs(cwd, kind) {
          calls.push({ cwd, kind, method: "listToolConfigs" });
          return { data: [], nextCursor: null };
        },
        async saveToolConfig(cwd, record) {
          calls.push({ cwd, method: "saveToolConfig", record });
          return {
            filePath: "tools/docs-search.json",
            operation: "created",
          };
        },
      }),
    });

    await capturedParams().draft.saveOrUpdateToolConfig("/repo", toolRecord);

    expect(calls).toEqual([
      {
        cwd: "/repo",
        kind: "skill",
        method: "listToolConfigs",
      },
      {
        cwd: "/repo",
        method: "saveToolConfig",
        record: toolRecord,
      },
    ]);
  });
});
