import type { FsGetMetadataResponse } from "@crewon-ui-model/v2/FsGetMetadataResponse";
import type { FsReadFileResponse } from "@crewon-ui-model/v2/FsReadFileResponse";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapabilityPanelItem } from "../capability/capabilityPanelTypes";
import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import { handleLibraryFileAction } from "./libraryFileActions";

type CapturedFileActionState = {
  dockOpen: boolean;
  openedItems: CapabilityPanelItem[];
  panel: LibraryPanel | null;
  readPaths: string[];
};

beforeEach(() => {
  vi.stubGlobal("window", { atob });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function panel(): LibraryPanel {
  return {
    kind: "knowledge",
    title: "Knowledge",
    subtitle: "Memory",
    body: "Existing",
    items: [],
    knowledge: { memories: [], sources: [] },
  };
}

async function handleAction(
  action: LibraryPanelAction,
  options: {
    file?: FsReadFileResponse | null;
    metadata?: FsGetMetadataResponse | null;
  } = {},
): Promise<{ handled: boolean; state: CapturedFileActionState }> {
  const state: CapturedFileActionState = {
    dockOpen: false,
    openedItems: [],
    panel: panel(),
    readPaths: [],
  };

  const handled = await handleLibraryFileAction({
    action,
    getMetadata: async (path) => {
      state.readPaths.push(`metadata:${path}`);
      return options.metadata ?? null;
    },
    locale: "en",
    openCapabilityItem: (item) => {
      state.openedItems.push(item);
    },
    readFile: async (path) => {
      state.readPaths.push(`file:${path}`);
      return options.file ?? null;
    },
    setCapabilityDockOpen: (open) => {
      state.dockOpen = open;
    },
    setLibraryPanel: (updater) => {
      state.panel = updater(state.panel);
    },
  });

  return { handled, state };
}

describe("library file actions", () => {
  it("opens explicit paths in the capability dock", async () => {
    const { handled, state } = await handleAction({
      id: "open-path",
      label: "Open path",
      pathToOpen: "/repo/src/App.tsx",
      pathKind: "file",
    });

    expect(handled).toBe(true);
    expect(state.dockOpen).toBe(true);
    expect(state.openedItems).toEqual([
      {
        label: "App.tsx",
        path: "/repo/src/App.tsx",
        kind: "file",
      },
    ]);
  });

  it("opens knowledge directories in the capability dock", async () => {
    const { handled, state } = await handleAction({
      id: "open-knowledge-file",
      label: "Open knowledge",
      knowledgeKind: "directory",
      knowledgePath: "/repo/docs",
      knowledgeTitle: "Docs",
    });

    expect(handled).toBe(true);
    expect(state.dockOpen).toBe(true);
    expect(state.openedItems).toEqual([
      { label: "Docs", path: "/repo/docs", kind: "directory" },
    ]);
    expect(state.readPaths).toEqual([]);
  });

  it("reads knowledge files into the active knowledge panel", async () => {
    const { handled, state } = await handleAction(
      {
        id: "open-knowledge-file",
        label: "Open knowledge",
        knowledgePath: "/repo/notes.md",
      },
      {
        file: { dataBase64: btoa("hello knowledge") } as FsReadFileResponse,
      },
    );

    expect(handled).toBe(true);
    expect(state.readPaths).toEqual([
      "file:/repo/notes.md",
      "metadata:/repo/notes.md",
    ]);
    expect(state.panel).toMatchObject({
      title: "notes.md",
      subtitle: "/repo/notes.md",
      body: expect.stringContaining("hello knowledge"),
    });
  });

  it("leaves unrelated actions for the app handler", async () => {
    const { handled } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
  });
});
