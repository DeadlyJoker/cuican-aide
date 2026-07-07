import { describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../../app-server/appServer";
import type { BackendWorkspace } from "../../backend/backendWorkspace";
import type { LibraryItemOpenHandlersParams } from "../../library/libraryItemOpenHandlers";

const factorySpy = vi.hoisted(() => ({
  lastParams: null as LibraryItemOpenHandlersParams | null,
  create: vi.fn((params: LibraryItemOpenHandlersParams) => {
    factorySpy.lastParams = params;
    return {} as ReturnType<
      typeof import("../../library/libraryItemOpenHandlers").createLibraryItemOpenHandlers
    >;
  }),
}));

vi.mock("../../library/libraryItemOpenHandlers", () => ({
  createLibraryItemOpenHandlers: factorySpy.create,
}));

const { createAppLibraryItemOpenHandlers } = await import(
  "./appLibraryItemOpenHandlers"
);

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function capturedParams(): LibraryItemOpenHandlersParams {
  const params = factorySpy.lastParams;
  if (!params) {
    throw new Error("factory was not called");
  }
  return params;
}

describe("app library item open handlers", () => {
  it("wires plugin, plugin skill, and skill file readers to the current client", async () => {
    const calls: unknown[] = [];
    createAppLibraryItemOpenHandlers({
      client: client({
        async readFile(path) {
          calls.push({ method: "readFile", path });
          return null as unknown as Awaited<
            ReturnType<AppServerClient["readFile"]>
          >;
        },
        async readPlugin(pluginName, marketplacePath, remoteMarketplaceName) {
          calls.push({
            marketplacePath,
            method: "readPlugin",
            pluginName,
            remoteMarketplaceName,
          });
          return null as unknown as Awaited<
            ReturnType<AppServerClient["readPlugin"]>
          >;
        },
        async readPluginSkill(remoteMarketplaceName, remotePluginId, skillName) {
          calls.push({
            method: "readPluginSkill",
            remoteMarketplaceName,
            remotePluginId,
            skillName,
          });
          return null as unknown as Awaited<
            ReturnType<AppServerClient["readPluginSkill"]>
          >;
        },
      }),
      createBackendAgentConfig: async () => {
        throw new Error("unexpected agent config");
      },
      ensureOfficeThread: async () => null,
      isConnected: true,
      isUnsupportedRpcError: () => false,
      locale: "en",
      openAgentsLibrary: async () => {},
      optionalBackendWorkspace: async () => null,
      readAutomationRunItems: async () => [],
      refreshToolActionFromBackend: async (action) => action,
      setLibraryPanel: () => {},
      setNotice: () => {},
      setThreadGoal: async () => {},
      setThreads: () => {},
      writeAgentConfig: async () => null,
    });

    const params = capturedParams();
    await params.plugin.readPlugin("docs", "/market.json", "remote");
    await params.pluginSkill.readPluginSkill("remote", "plugin-1", "skill");
    await params.skillFile.open.readFile("/repo/SKILL.md");

    expect(calls).toEqual([
      {
        marketplacePath: "/market.json",
        method: "readPlugin",
        pluginName: "docs",
        remoteMarketplaceName: "remote",
      },
      {
        method: "readPluginSkill",
        remoteMarketplaceName: "remote",
        remotePluginId: "plugin-1",
        skillName: "skill",
      },
      { method: "readFile", path: "/repo/SKILL.md" },
    ]);
  });

  it("wires backend config readers through the optional workspace provider", async () => {
    const calls: unknown[] = [];
    const backendClient = client({
      async listAutomationRuns(cwd, threadId) {
        calls.push({ cwd, method: "listAutomationRuns", threadId });
        return { data: [], nextCursor: null };
      },
      async readAgentConfig(cwd, params) {
        calls.push({ cwd, method: "readAgentConfig", params });
        return { record: null };
      },
      async readAutomationConfig(cwd, params) {
        calls.push({ cwd, method: "readAutomationConfig", params });
        return { record: null };
      },
      async readOfficeConfig(cwd, params) {
        calls.push({ cwd, method: "readOfficeConfig", params });
        return { record: null };
      },
    });
    const workspace = {
      client: backendClient,
      cwd: "/repo",
    } satisfies BackendWorkspace;

    createAppLibraryItemOpenHandlers({
      client: client(),
      createBackendAgentConfig: async () => {
        throw new Error("unexpected agent config");
      },
      ensureOfficeThread: async () => null,
      isConnected: true,
      isUnsupportedRpcError: () => false,
      locale: "en",
      openAgentsLibrary: async () => {},
      optionalBackendWorkspace: async () => workspace,
      readAutomationRunItems: async () => [],
      refreshToolActionFromBackend: async (action) => action,
      setLibraryPanel: () => {},
      setNotice: () => {},
      setThreadGoal: async () => {},
      setThreads: () => {},
      writeAgentConfig: async () => null,
    });

    const params = capturedParams();
    await params.agentConfig.readAgentConfig({ agentId: "agent-1" });
    await params.automationDetail.readAutomationConfig({
      filePath: "automation.json",
    });
    await params.automationDetail.listAutomationRuns("thread-1");
    await params.officeDetail.readOfficeConfig({ title: "Office" });

    expect(calls).toEqual([
      {
        cwd: "/repo",
        method: "readAgentConfig",
        params: { agentId: "agent-1" },
      },
      {
        cwd: "/repo",
        method: "readAutomationConfig",
        params: { filePath: "automation.json" },
      },
      {
        cwd: "/repo",
        method: "listAutomationRuns",
        threadId: "thread-1",
      },
      {
        cwd: "/repo",
        method: "readOfficeConfig",
        params: { title: "Office" },
      },
    ]);
  });

  it("wires external agent import thread helpers to the current client", async () => {
    const calls: unknown[] = [];
    createAppLibraryItemOpenHandlers({
      client: client({
        async renameThread(threadId, name) {
          calls.push({ method: "renameThread", name, threadId });
        },
        async setThreadGoal(threadId, goal, tokenBudget) {
          calls.push({ goal, method: "setThreadGoal", threadId, tokenBudget });
          return null as unknown as Awaited<
            ReturnType<AppServerClient["setThreadGoal"]>
          >;
        },
        async startThread(cwd, source) {
          calls.push({ cwd, method: "startThread", source });
          return null as unknown as Awaited<
            ReturnType<AppServerClient["startThread"]>
          >;
        },
        async startTurn(threadId, text) {
          calls.push({ method: "startTurn", text, threadId });
          return null as unknown as Awaited<
            ReturnType<AppServerClient["startTurn"]>
          >;
        },
      }),
      createBackendAgentConfig: async () => {
        throw new Error("unexpected agent config");
      },
      ensureOfficeThread: async () => null,
      isConnected: true,
      isUnsupportedRpcError: () => false,
      locale: "en",
      openAgentsLibrary: async () => {},
      optionalBackendWorkspace: async () => null,
      readAutomationRunItems: async () => [],
      refreshToolActionFromBackend: async (action) => action,
      setLibraryPanel: () => {},
      setNotice: () => {},
      setThreadGoal: async (threadId, goal, tokenBudget) => {
        calls.push({ goal, method: "factorySetThreadGoal", threadId, tokenBudget });
      },
      setThreads: () => {},
      writeAgentConfig: async () => null,
    });

    const params = capturedParams();
    await params.externalAgentImport.renameThread("thread-1", "Agent");
    await params.externalAgentImport.setThreadGoal("thread-1", "Goal", null);
    await params.externalAgentImport.startAgentThread("/repo", "agent");
    await params.externalAgentImport.startTurn("thread-1", "Hello");

    expect(calls).toEqual([
      { method: "renameThread", name: "Agent", threadId: "thread-1" },
      {
        goal: "Goal",
        method: "factorySetThreadGoal",
        threadId: "thread-1",
        tokenBudget: null,
      },
      { cwd: "/repo", method: "startThread", source: "agent" },
      { method: "startTurn", text: "Hello", threadId: "thread-1" },
    ]);
  });
});
