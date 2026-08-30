import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../../app-server/appServer";
import type { AppLibraryOpenHandlersParams } from "./appLibraryOpenHandlers";
import type { LibraryItem, LibraryPanel } from "../../domain/crewonDomain";
import type { OpenLibraryItemActionParams } from "../../library/libraryItemActionFlow";
import type { OpenLibraryActionParams } from "../../library/libraryOpenActions";

const libraryOpenSpy = vi.hoisted(() => ({
  lastParams: null as OpenLibraryActionParams | null,
  open: vi.fn(async (params: OpenLibraryActionParams) => {
    libraryOpenSpy.lastParams = params;
  }),
}));

const libraryItemFlowSpy = vi.hoisted(() => ({
  lastParams: null as OpenLibraryItemActionParams | null,
  open: vi.fn(async (params: OpenLibraryItemActionParams) => {
    libraryItemFlowSpy.lastParams = params;
    return true;
  }),
}));

const itemHandlerSpy = vi.hoisted(() => ({
  lastParams: null as
    | Parameters<
        typeof import("./appLibraryItemOpenHandlers").createAppLibraryItemOpenHandlers
      >[0]
    | null,
  create: vi.fn(
    (
      params: Parameters<
        typeof import("./appLibraryItemOpenHandlers").createAppLibraryItemOpenHandlers
      >[0],
    ) => {
      itemHandlerSpy.lastParams = params;
      return {
        agentConfig: vi.fn(),
        automationDetail: vi.fn(),
        externalAgentImport: vi.fn(),
        mcpDetail: vi.fn(),
        officeDetail: vi.fn(),
        plugin: vi.fn(),
        pluginSkill: vi.fn(),
        skillFile: vi.fn(),
      };
    },
  ),
}));

const mcpInventorySpy = vi.hoisted(() => ({
  load: vi.fn(async () => ({
    resources: [],
    servers: [],
    tools: [],
  })),
}));

vi.mock("../../library/libraryOpenActions", () => ({
  openLibraryAction: libraryOpenSpy.open,
}));

vi.mock("../../library/libraryItemActionFlow", () => ({
  openLibraryItemAction: libraryItemFlowSpy.open,
}));

vi.mock("./appLibraryItemOpenHandlers", () => ({
  createAppLibraryItemOpenHandlers: itemHandlerSpy.create,
}));

vi.mock("../../domain/domainCollaborationBackend", () => ({
  loadMcpInventory: mcpInventorySpy.load,
}));

const { createAppLibraryOpenHandlers } = await import(
  "./appLibraryOpenHandlers"
);

function client(overrides: Partial<AppServerClient> = {}): AppServerClient {
  return overrides as AppServerClient;
}

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    accent: "blue",
    description: "Item",
    glyph: "I",
    meta: "Meta",
    title: "Item",
    ...overrides,
  };
}

function createParams(
  overrides: Partial<AppLibraryOpenHandlersParams> = {},
): AppLibraryOpenHandlersParams {
  return {
    automationAuthority: "legacy",
    beginLibraryLoad: () => () => true,
    client: client(),
    connectionHint: "Connected",
    createBackendAgentConfig: async () => ({
      accent: "blue",
      glyph: "A",
      mcp: [],
      model: "gpt-5",
      models: [],
      name: "Agent",
      permission: "default",
      permissions: [],
      role: "Role",
      skills: [],
      systemPrompt: "",
    }),
    cwd: "/repo",
    ensureOfficeThread: async () => null,
    isConnected: true,
    isDemo: false,
    isDemoPreview: false,
    isUnsupportedRpcError: () => false,
    loadAgentLibraryItems: async () => ({ items: [] }),
    loadToolLibraryItems: async () => [],
    locale: "en",
    markLibraryLoad: () => {},
    optionalBackendWorkspace: async () => null,
    readAutomationRunItems: async () => [],
    readKnowledgeData: async () => ({ memories: [], sources: [] }),
    refreshToolActionFromBackend: async (action) => action,
    resolveBackendCwd: async () => "/repo",
    selectedThreadId: "thread-1",
    setAppView: () => {},
    setCapabilityDockOpen: () => {},
    setInspectorOpen: () => {},
    setLibraryPanel: () => {},
    setNotice: () => {},
    setThreadGoal: async () => {},
    setThreads: () => {},
    storedAutomationItems: async () => [],
    writeAgentConfig: async () => null,
    ...overrides,
  };
}

function capturedOpenParams(): OpenLibraryActionParams {
  const params = libraryOpenSpy.lastParams;
  if (!params) {
    throw new Error("openLibraryAction was not called");
  }
  return params;
}

describe("app library open handlers", () => {
  beforeEach(() => {
    libraryOpenSpy.lastParams = null;
    libraryItemFlowSpy.lastParams = null;
    itemHandlerSpy.lastParams = null;
    vi.clearAllMocks();
  });

  it("keeps Control-configured Automation list and detail off every legacy loader", async () => {
    const panels: LibraryPanel[] = [];
    const markLibraryLoad = vi.fn();
    const setAppView = vi.fn();
    const setCapabilityDockOpen = vi.fn();
    const setInspectorOpen = vi.fn();
    const handlers = createAppLibraryOpenHandlers(
      createParams({
        automationAuthority: "control",
        client: client({
          listAutomationConfigs: vi.fn(),
        }),
        isConnected: false,
        markLibraryLoad,
        setAppView,
        setCapabilityDockOpen,
        setInspectorOpen,
        setLibraryPanel: (panelOrUpdater) => {
          if (typeof panelOrUpdater === "function") {
            const next = panelOrUpdater(panels.at(-1) ?? null);
            if (next) panels.push(next);
            return;
          }
          if (panelOrUpdater) panels.push(panelOrUpdater);
        },
        storedAutomationItems: vi.fn(),
      }),
    );

    await handlers.openLibrary("automation");
    await handlers.openLibraryItem(
      item({
        action: {
          body: "legacy body",
          prompt: "legacy prompt",
          subtitle: "legacy subtitle",
          title: "legacy title",
          type: "automation-detail",
        },
      }),
    );

    expect(libraryOpenSpy.open).not.toHaveBeenCalled();
    expect(libraryItemFlowSpy.open).not.toHaveBeenCalled();
    expect(markLibraryLoad).toHaveBeenCalledTimes(1);
    expect(setAppView).toHaveBeenCalledTimes(2);
    expect(setCapabilityDockOpen).toHaveBeenCalledTimes(2);
    expect(setInspectorOpen).toHaveBeenCalledTimes(2);
    expect(panels.at(-1)).toEqual(
      expect.objectContaining({
        actions: [],
        kind: "automation",
        subtitle: "Scheduling moved to the new scheduler",
      }),
    );
    expect(panels.at(-1)?.body).toContain("legacy import tool");
  });

  it("wires openLibrary through current client and domain loaders", async () => {
    const calls: unknown[] = [];
    const currentClient = client({
      async detectExternalAgentConfig(cwd) {
        calls.push({ cwd, method: "detectExternalAgentConfig" });
        return {
          items: [],
        };
      },
      async listAutomationConfigs(cwd) {
        calls.push({ cwd, method: "listAutomationConfigs" });
        return { data: [], nextCursor: null };
      },
      async listOfficeConfigs(cwd) {
        calls.push({ cwd, method: "listOfficeConfigs" });
        return { data: [], nextCursor: null };
      },
      async listPlugins(cwd) {
        calls.push({ cwd, method: "listPlugins" });
        return {
          featuredPluginIds: [],
          marketplaceLoadErrors: [],
          marketplaces: [],
        };
      },
      async listSkills(cwd) {
        calls.push({ cwd, method: "listSkills" });
        return { data: [], nextCursor: null };
      },
    });
    const loadAgentLibraryItems = vi.fn(async () => ({ items: [item()] }));
    const loadToolLibraryItems = vi.fn(async () => [item()]);
    const readKnowledgeData = vi.fn(async () => ({
      memories: [],
      sources: [],
    }));
    const storedAutomationItems = vi.fn(async () => [item()]);
    const handlers = createAppLibraryOpenHandlers(
      createParams({
        client: currentClient,
        loadAgentLibraryItems,
        loadToolLibraryItems,
        readKnowledgeData,
        storedAutomationItems,
      }),
    );

    await handlers.openLibrary("tools");
    const params = capturedOpenParams();
    await params.detectExternalAgentConfig("/repo");
    await params.listAutomationConfigs("/repo");
    await params.listOfficeConfigs("/repo");
    await params.listPlugins("/repo");
    await params.listSkills("/repo");
    await params.loadAgentLibraryItems("/repo");
    await params.loadToolLibraryItems("/repo");
    await params.loadMcpInventory("thread-1", "/repo");
    await params.readKnowledgeData();
    await params.storedAutomationItems([]);
    params.storedOfficeItems([]);

    expect(params.kind).toBe("tools");
    expect(params.cwd).toBe("/repo");
    expect(params.selectedThreadId).toBe("thread-1");
    expect(calls).toEqual([
      { cwd: "/repo", method: "detectExternalAgentConfig" },
      { cwd: "/repo", method: "listAutomationConfigs" },
      { cwd: "/repo", method: "listOfficeConfigs" },
      { cwd: "/repo", method: "listPlugins" },
      { cwd: "/repo", method: "listSkills" },
    ]);
    expect(loadAgentLibraryItems).toHaveBeenCalledWith("/repo");
    expect(loadToolLibraryItems).toHaveBeenCalledWith("/repo");
    expect(mcpInventorySpy.load).toHaveBeenCalledWith(
      currentClient,
      "thread-1",
      "/repo",
    );
    expect(readKnowledgeData).toHaveBeenCalledOnce();
    expect(storedAutomationItems).toHaveBeenCalledWith([]);
  });

  it("wires openLibraryItem through app item handlers and marks library loads", async () => {
    const markLibraryLoad = vi.fn();
    const setThreadGoal = vi.fn(async () => {});
    const handlers = createAppLibraryOpenHandlers(
      createParams({ markLibraryLoad, setThreadGoal }),
    );
    const targetItem = item();

    await handlers.openLibraryItem(targetItem);
    const itemParams = libraryItemFlowSpy.lastParams;
    const handlerParams = itemHandlerSpy.lastParams;
    if (!itemParams || !handlerParams) {
      throw new Error("library item flow was not wired");
    }
    itemParams.markLibraryLoad();
    await handlerParams.openAgentsLibrary();
    await handlerParams.setThreadGoal("thread-1", "Goal", undefined);

    expect(itemParams.item).toBe(targetItem);
    expect(itemParams.isConnected).toBe(true);
    expect(itemParams.isDemo).toBe(false);
    expect(markLibraryLoad).toHaveBeenCalledOnce();
    expect(handlerParams.locale).toBe("en");
    expect(setThreadGoal).toHaveBeenCalledWith("thread-1", "Goal", undefined);
    expect(libraryOpenSpy.open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agents" }),
    );
  });

  it("forwards panel setters without changing their direct/update shape", async () => {
    const panels: Array<LibraryPanel | null> = [];
    const setLibraryPanel = vi.fn((panelOrUpdater) => {
      panels.push(
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(null)
          : panelOrUpdater,
      );
    });
    const handlers = createAppLibraryOpenHandlers(
      createParams({ setLibraryPanel }),
    );

    await handlers.openLibrary("agents");
    const params = capturedOpenParams();
    params.setLibraryPanel({
      kind: "agents",
      items: [],
      subtitle: "Library",
      title: "Agents",
    });

    expect(setLibraryPanel).toHaveBeenCalledOnce();
    expect(panels).toEqual([
      { kind: "agents", items: [], subtitle: "Library", title: "Agents" },
    ]);
  });
});
