import type { FsGetMetadataResponse } from "@crewon-protocol/v2/FsGetMetadataResponse";
import type { PluginReadResponse } from "@crewon-protocol/v2/PluginReadResponse";
import { describe, expect, it, vi } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "./capabilityPanelTypes";
import {
  handleCapabilityPanelItemAction,
  type CapabilityPanelItemActionParams,
} from "./capabilityPanelItemActions";
import type { PendingComposerMention } from "../shared/composerMentions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

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

function pluginResponse(
  summaryOverrides: Partial<PluginReadResponse["plugin"]["summary"]> = {},
): PluginReadResponse {
  return {
    plugin: {
      marketplaceName: "local",
      marketplacePath: "/repo/.codex/plugins",
      summary: {
        id: "plugin-id",
        remotePluginId: null,
        localVersion: null,
        name: "demo-plugin",
        shareContext: null,
        source: { type: "remote" },
        installed: false,
        enabled: false,
        installPolicy: "AVAILABLE",
        authPolicy: "ON_USE",
        availability: "AVAILABLE",
        interface: null,
        keywords: [],
        ...summaryOverrides,
      },
      description: null,
      skills: [],
      hooks: [],
      apps: [],
      appTemplates: [],
      mcpServers: [],
    },
  };
}

function baseParams(
  overrides: Partial<CapabilityPanelItemActionParams> = {},
): CapabilityPanelItemActionParams {
  let panel: CapabilityPanel | null = {
    title: "Panel",
    body: "Ready",
  };
  let composer = "";
  let mentions: PendingComposerMention[] = [];
  let focusSignal = 0;
  let notice: NoticeState | null = null;
  return {
    busyToolId: null,
    client: {
      async cleanBackgroundTerminals() {},
      async getMetadata() {
        return metadata();
      },
      async listBackgroundTerminals() {
        return { data: [] };
      },
      async readDirectory() {
        return { entries: [{ fileName: "README.md", isDirectory: false }] };
      },
      async readFile() {
        return { dataBase64: "SGVsbG8gd29ybGQ=" };
      },
      async readPlugin() {
        return pluginResponse();
      },
      async terminateBackgroundTerminal() {
        return true;
      },
    },
    confirm: () => true,
    isConnected: true,
    isDemo: false,
    item: {
      label: "README.md",
      path: "/repo/README.md",
      kind: "file",
    },
    locale: "en",
    setBusyToolId: () => {},
    setCapabilityPanel: (panelOrUpdater) => {
      panel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(panel)
          : panelOrUpdater;
    },
    setComposerFocusSignal: (updater) => {
      focusSignal = updater(focusSignal);
    },
    setComposerValue: (updater) => {
      composer = updater(composer);
    },
    setNotice: (nextNotice) => {
      notice = nextNotice;
    },
    setPendingComposerMentions: (updater) => {
      mentions = updater(mentions);
    },
    setPendingContextFile: () => {},
    ...overrides,
  };
}

describe("capability panel item actions", () => {
  it("opens demo items without backend calls", async () => {
    let panel: CapabilityPanel | null = null;

    await handleCapabilityPanelItemAction(
      baseParams({
        isDemo: true,
        item: {
          label: "/repo",
          path: "/repo",
          kind: "directory",
        },
        setCapabilityPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
      }),
    );

    expect(panel).toMatchObject({
      body: "directory · demo data",
      subtitle: "/repo",
    });
  });

  it("adds app mentions to the composer", async () => {
    let panel: CapabilityPanel | null = {
      title: "Apps",
      body: "Ready",
    };
    let composer = "open settings";
    let mentions: PendingComposerMention[] = [];
    let focusSignal = 0;

    await handleCapabilityPanelItemAction(
      baseParams({
        item: {
          label: "Browser",
          action: {
            type: "app",
            appId: "browser",
            appName: "Browser Tools",
          },
        },
        setCapabilityPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
        setComposerFocusSignal: (updater) => {
          focusSignal = updater(focusSignal);
        },
        setComposerValue: (updater) => {
          composer = updater(composer);
        },
        setPendingComposerMentions: (updater) => {
          mentions = updater(mentions);
        },
      }),
    );

    expect(composer).toBe("$browser-tools open settings");
    expect(mentions).toEqual([
      {
        name: "Browser Tools",
        path: "app://browser",
        token: "$browser-tools",
      },
    ]);
    expect(focusSignal).toBe(1);
    expect(panel).toMatchObject({
      body: expect.stringContaining("$browser-tools added to the composer."),
    });
  });

  it("opens plugin details", async () => {
    let panel: CapabilityPanel | null = {
      title: "Plugin",
      body: "Ready",
    };
    const readPlugins: string[] = [];

    const action = handleCapabilityPanelItemAction(
      baseParams({
        client: {
          async cleanBackgroundTerminals() {},
          async getMetadata() {
            return metadata();
          },
          async listBackgroundTerminals() {
            return { data: [] };
          },
          async readDirectory() {
            return { entries: [] };
          },
          async readFile() {
            return { dataBase64: "" };
          },
          async readPlugin(pluginName) {
            readPlugins.push(pluginName);
            return pluginResponse();
          },
          async terminateBackgroundTerminal() {
            return true;
          },
        },
        item: {
          label: "demo-plugin",
          action: {
            type: "plugin",
            pluginName: "demo-plugin",
            marketplacePath: "/repo/.codex/plugins",
            remoteMarketplaceName: null,
          },
        },
        setCapabilityPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
      }),
    );

    expect(panel).toMatchObject({
      body: "Reading...",
      subtitle: "Plugin details",
    });
    await action;

    expect(readPlugins).toEqual(["demo-plugin"]);
    expect(panel).toMatchObject({
      title: "demo-plugin",
      subtitle: "Plugin details",
    });
  });

  it("opens directories", async () => {
    let panel: CapabilityPanel | null = {
      title: "Files",
      body: "Ready",
    };
    const busyStates: Array<"files" | "terminal" | "web" | null> = [];

    await handleCapabilityPanelItemAction(
      baseParams({
        item: {
          label: "src",
          path: "/repo/src",
          kind: "directory",
        },
        setBusyToolId: (toolId) => busyStates.push(toolId),
        setCapabilityPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
      }),
    );
    await flushAsyncAction();

    expect(busyStates).toEqual(["files", null]);
    expect(panel).toMatchObject({
      subtitle: "/repo/src",
      title: "Files",
    });
    expect(panel?.items?.[0]).toMatchObject({
      label: "  README.md",
      path: "/repo/src/README.md",
    });
  });

  it("reads files and attaches context", async () => {
    vi.stubGlobal("window", { atob: globalThis.atob });
    let composer = "Current prompt";
    let pendingContextFile: { path: string; text: string } | null = null;
    let panel: CapabilityPanel | null = null;

    await handleCapabilityPanelItemAction(
      baseParams({
        item: {
          label: "README.md",
          path: "/repo/README.md",
          kind: "file",
          intent: "attach-context",
        },
        setCapabilityPanel: (panelOrUpdater) => {
          panel =
            typeof panelOrUpdater === "function"
              ? panelOrUpdater(panel)
              : panelOrUpdater;
        },
        setComposerValue: (updater) => {
          composer = updater(composer);
        },
        setPendingContextFile: (contextFile) => {
          pendingContextFile = contextFile;
        },
      }),
    );
    await flushAsyncAction();

    expect(composer).toContain("Current prompt");
    expect(composer).toContain("Hello world");
    expect(pendingContextFile).toEqual({
      path: "/repo/README.md",
      text: "Hello world",
    });
    expect(panel).toMatchObject({
      body: expect.stringContaining("Hello world"),
      subtitle: "/repo/README.md",
    });
  });

  it("confirms and terminates background terminals", async () => {
    let notice: NoticeState | null = null;
    const terminated: Array<{ processId: string; threadId: string }> = [];

    await handleCapabilityPanelItemAction(
      baseParams({
        client: {
          async cleanBackgroundTerminals() {},
          async getMetadata() {
            return metadata();
          },
          async listBackgroundTerminals() {
            return { data: [] };
          },
          async readDirectory() {
            return { entries: [] };
          },
          async readFile() {
            return { dataBase64: "" };
          },
          async readPlugin() {
            return pluginResponse();
          },
          async terminateBackgroundTerminal(threadId, processId) {
            terminated.push({ processId, threadId });
            return true;
          },
        },
        item: {
          label: "npm test",
          action: {
            type: "background-terminal",
            threadId: "thread-1",
            processId: "proc-1",
          },
        },
        setNotice: (nextNotice) => {
          notice = nextNotice;
        },
      }),
    );
    await flushAsyncAction();

    expect(terminated).toEqual([{ processId: "proc-1", threadId: "thread-1" }]);
    expect(notice).toEqual({
      text: "Background process terminated",
      tone: "success",
    });
  });
});
