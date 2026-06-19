import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginListResponse } from "@crewon-protocol/v2/PluginListResponse";

import type {
  KnowledgeEntry,
  LibraryItem,
  LibraryPanel,
} from "../domain/crewonDomain";
import type { OpenLibraryActionParams } from "./libraryOpenActions";
import { openLibraryAction } from "./libraryOpenActions";

function item(title: string): LibraryItem {
  return {
    title,
    meta: "record",
    description: "Saved record",
  };
}

function knowledgeEntry(title: string): KnowledgeEntry {
  return {
    title,
    glyph: "M",
    accent: "blue",
    kind: "memory",
    preview: "Remember this",
    meta: "thread",
  };
}

function emptyPluginResponse(): PluginListResponse {
  return {
    marketplaces: [],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function createPanelHarness() {
  let currentPanel: LibraryPanel | null = null;
  return {
    panel: () => currentPanel,
    setLibraryPanel: (
      next:
        | LibraryPanel
        | null
        | ((currentPanel: LibraryPanel | null) => LibraryPanel | null),
    ) => {
      currentPanel =
        typeof next === "function" ? next(currentPanel) : next;
    },
  };
}

function baseParams(
  overrides: Partial<OpenLibraryActionParams> = {},
): OpenLibraryActionParams {
  const { setLibraryPanel } = createPanelHarness();
  return {
    beginLibraryLoad: () => () => true,
    connectionHint: "Disconnected",
    cwd: "/repo",
    demoLibraryPanel: (kind, locale) => ({
      kind,
      title: locale === "zh" ? "演示" : "Demo",
      subtitle: "demo",
      items: [item("Demo item")],
    }),
    detectExternalAgentConfig: async () => ({ items: [] }),
    isConnected: true,
    isDemo: false,
    isDemoPreview: false,
    isUnsupportedRpcError: () => false,
    kind: "plugins",
    listAutomationConfigs: async () => ({ data: [] }) as never,
    listOfficeConfigs: async () => ({ data: [] }) as never,
    listPlugins: async () => emptyPluginResponse(),
    listSkills: async () => ({ data: [] }),
    loadAgentLibraryItems: async () => [],
    loadMcpInventory: async () => ({ configs: [], servers: [], statuses: [] }),
    loadToolLibraryItems: async () => [],
    locale: "en",
    readKnowledgeData: async () => ({ memories: [], sources: [] }),
    resolveBackendCwd: async () => "/resolved",
    selectedThreadId: "thread-1",
    setAppView: () => {},
    setCapabilityDockOpen: () => {},
    setInspectorOpen: () => {},
    setLibraryPanel,
    storedAutomationItems: async () => [],
    storedOfficeItems: () => [],
    ...overrides,
  };
}

describe("openLibraryAction", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a disconnected panel when the backend is unavailable", async () => {
    const harness = createPanelHarness();

    await openLibraryAction(
      baseParams({
        isConnected: false,
        kind: "plugins",
        setLibraryPanel: harness.setLibraryPanel,
      }),
    );

    expect(harness.panel()).toMatchObject({
      kind: "plugins",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
  });

  it("uses demo library content while disconnected in demo mode", async () => {
    const harness = createPanelHarness();

    await openLibraryAction(
      baseParams({
        isConnected: false,
        isDemo: true,
        kind: "agents",
        setLibraryPanel: harness.setLibraryPanel,
      }),
    );

    expect(harness.panel()).toMatchObject({
      kind: "agents",
      subtitle: "demo",
      items: [item("Demo item")],
    });
  });

  it("loads tool content with the resolved demo-preview cwd", async () => {
    const harness = createPanelHarness();
    const loadMcpInventory = vi.fn(async () => ({
      configs: [],
      servers: [],
      statuses: [],
    }));
    const listSkills = vi.fn(async () => ({ data: [] }));
    const listPlugins = vi.fn(async () => emptyPluginResponse());
    const loadToolLibraryItems = vi.fn(async () => [item("Workspace tool")]);

    await openLibraryAction(
      baseParams({
        isDemoPreview: true,
        kind: "tools",
        listPlugins,
        listSkills,
        loadMcpInventory,
        loadToolLibraryItems,
        resolveBackendCwd: async () => "/resolved",
        setLibraryPanel: harness.setLibraryPanel,
      }),
    );

    expect(loadMcpInventory).toHaveBeenCalledWith(undefined, "/resolved");
    expect(listSkills).toHaveBeenCalledWith("/resolved");
    expect(listPlugins).toHaveBeenCalledWith("/resolved");
    expect(loadToolLibraryItems).toHaveBeenCalledWith("/resolved");
    expect(harness.panel()).toMatchObject({
      kind: "tools",
      items: expect.arrayContaining([item("Workspace tool")]),
    });
  });

  it("marks office list as unsupported without failing the whole load", async () => {
    const harness = createPanelHarness();
    const unsupported = new Error("unsupported");

    await openLibraryAction(
      baseParams({
        isUnsupportedRpcError: (error) => error === unsupported,
        kind: "office",
        listOfficeConfigs: async () => {
          throw unsupported;
        },
        setLibraryPanel: harness.setLibraryPanel,
      }),
    );

    expect(harness.panel()).toMatchObject({
      kind: "office",
      error: "The current app-server does not support office/list.",
    });
  });

  it("loads knowledge content through the provided reader", async () => {
    const harness = createPanelHarness();

    await openLibraryAction(
      baseParams({
        kind: "knowledge",
        readKnowledgeData: async () => ({
          memories: [knowledgeEntry("Remember")],
          sources: [],
        }),
        setLibraryPanel: harness.setLibraryPanel,
      }),
    );

    expect(harness.panel()).toMatchObject({
      kind: "knowledge",
      subtitle: "1 memories · 0 sources",
      knowledge: {
        memories: [knowledgeEntry("Remember")],
        sources: [],
      },
    });
  });

  it("does not overwrite the current panel when a stale load completes", async () => {
    const harness = createPanelHarness();

    await openLibraryAction(
      baseParams({
        beginLibraryLoad: () => () => false,
        kind: "plugins",
        setLibraryPanel: harness.setLibraryPanel,
      }),
    );

    expect(harness.panel()).toMatchObject({
      kind: "plugins",
      subtitle: "Reading from local app-server...",
      items: [],
    });
  });
});
