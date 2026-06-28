import type { FuzzyFileSearchResponse } from "@crewon-protocol/FuzzyFileSearchResponse";
import type { FsGetMetadataResponse } from "@crewon-protocol/v2/FsGetMetadataResponse";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CapabilityPanel,
  CapabilityPanelItem,
} from "../capability/capabilityPanelTypes";
import type {
  ArtifactItem,
  LibraryPanel,
  OfficeConfig,
  OfficeMessage,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import {
  handleOfficeArtifactAction,
  type OfficeArtifactClient,
} from "./officeArtifactActions";

type CapturedOfficeArtifactState = {
  busyToolId: string | null;
  capabilityDockOpen: boolean;
  capabilityPanel: CapabilityPanel | null;
  createdDirectories: Array<{ path: string; recursive?: boolean }>;
  directoryItems: CapabilityPanelItem[];
  ensuredThreads: number;
  fuzzySearches: Array<{
    cancellationToken?: string | null;
    query: string;
    roots: string[];
  }>;
  libraryPanel: LibraryPanel | null;
  metadataPaths: string[];
  readFiles: string[];
  threads: Thread[];
  upsertedArtifacts: Array<{
    artifact: ArtifactItem;
    message: OfficeMessage;
    root: string;
    threadId: string;
  }>;
  writtenFiles: Array<{ path: string; text: string }>;
};

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

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "office-thread",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Preview",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/repo",
    clientVersion: "test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Office",
    turns: [],
    ...overrides,
  };
}

function artifact(overrides: Partial<ArtifactItem> = {}): ArtifactItem {
  return {
    title: "Client brief",
    kind: "markdown",
    glyph: "A",
    accent: "violet",
    meta: "client-demo",
    ...overrides,
  };
}

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Ship cleaner frontend",
    threadId: "office-thread",
    backendStatus: "connected",
    members: [],
    messages: [],
    tasks: [],
    activity: {
      trace: [],
      approvals: [],
      budget: [],
      budgetCapUsd: 0,
      artifacts: [],
      runs: [],
    },
    ...overrides,
  };
}

function officeConfig(workspaceConfig: OfficeWorkspace): OfficeConfig {
  return {
    title: "Office",
    subtitle: "Workspace",
    workspace: workspaceConfig,
  };
}

function panel(workspaceConfig: OfficeWorkspace = workspace()): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Workspace",
    items: [],
    workspace: workspaceConfig,
  };
}

function state(initialPanel: LibraryPanel | null = panel()): CapturedOfficeArtifactState {
  return {
    busyToolId: null,
    capabilityDockOpen: false,
    capabilityPanel: null,
    createdDirectories: [],
    directoryItems: [],
    ensuredThreads: 0,
    fuzzySearches: [],
    libraryPanel: initialPanel,
    metadataPaths: [],
    readFiles: [],
    threads: [thread()],
    upsertedArtifacts: [],
    writtenFiles: [],
  };
}

function client(
  captured: CapturedOfficeArtifactState,
  response: FuzzyFileSearchResponse,
): OfficeArtifactClient {
  return {
    async createDirectory(path, recursive) {
      captured.createdDirectories.push({ path, recursive });
    },
    async fuzzyFileSearch(query, roots, cancellationToken) {
      captured.fuzzySearches.push({ query, roots, cancellationToken });
      return response;
    },
    async getMetadata(path) {
      captured.metadataPaths.push(path);
      return metadata();
    },
    async readFile(path) {
      captured.readFiles.push(path);
      return { dataBase64: btoa("artifact body") };
    },
    async startTurn() {
      return { turn: turn({ id: "turn-artifact" }) };
    },
    async writeTextFile(path, text) {
      captured.writtenFiles.push({ path, text });
    },
  };
}

async function runAction(
  captured: CapturedOfficeArtifactState,
  overrides: Partial<Parameters<typeof handleOfficeArtifactAction>[0]> = {},
) {
  return handleOfficeArtifactAction({
    artifact: artifact(),
    busyToolId: null,
    client: client(captured, { files: [] }),
    ensureOfficeThread: async () => {
      captured.ensuredThreads += 1;
      return "office-thread";
    },
    handleDirectoryItem: async (item) => {
      captured.directoryItems.push(item);
    },
    isConnected: true,
    libraryPanel: captured.libraryPanel,
    locale: "en",
    nowIso: () => "2026-06-17T07:00:00.000Z",
    resolveBackendCwd: async () => "/repo",
    setBusyToolId: (toolId) => {
      captured.busyToolId = toolId;
    },
    setCapabilityDockOpen: (open) => {
      captured.capabilityDockOpen = open;
    },
    setCapabilityPanel: (nextPanel) => {
      captured.capabilityPanel = nextPanel;
    },
    setLibraryPanel: (updater) => {
      captured.libraryPanel = updater(captured.libraryPanel);
    },
    setThreads: (updater) => {
      captured.threads = updater(captured.threads);
    },
    uniqueId: () => "artifact-search",
    upsertOfficeArtifact: async (
      root,
      _panel,
      workspaceBeforeArtifact,
      threadId,
      savedArtifact,
      message,
    ) => {
      captured.upsertedArtifacts.push({
        artifact: savedArtifact,
        message,
        root,
        threadId,
      });
      return officeConfig({
        ...workspaceBeforeArtifact,
        messages: [...workspaceBeforeArtifact.messages, message],
      });
    },
    ...overrides,
  });
}

describe("office artifact actions", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { atob });
  });

  it("shows a disconnected panel without opening the dock", async () => {
    const captured = state();
    const handled = await runAction(captured, {
      isConnected: false,
    });

    expect(handled).toBe(true);
    expect(captured.capabilityDockOpen).toBe(false);
    expect(captured.capabilityPanel).toEqual({
      title: "Client brief",
      subtitle: "Office artifact",
      body: "Connect app-server to search and read this artifact from the current workspace.",
    });
    expect(captured.busyToolId).toBeNull();
  });

  it("creates a draft artifact when search finds no match", async () => {
    const captured = state();
    const handled = await runAction(captured);

    expect(handled).toBe(true);
    expect(captured.capabilityDockOpen).toBe(true);
    expect(captured.busyToolId).toBeNull();
    expect(captured.createdDirectories).toEqual([
      { path: "/repo/.crewon/offices/artifacts", recursive: true },
    ]);
    expect(captured.writtenFiles).toEqual([
      {
        path: "/repo/.crewon/offices/artifacts/client-brief.md",
        text: [
          "# Client brief",
          "- Kind: markdown",
          "- Source: Crewon office",
          "- Created: 2026-06-17T07:00:00.000Z",
          "- Office goal: Ship cleaner frontend",
          "client-demo",
          "This captures an office collaboration deliverable for reuse by agents, automations, or the knowledge library.",
        ].join("\n"),
      },
    ]);
    expect(captured.upsertedArtifacts).toHaveLength(1);
    expect(captured.upsertedArtifacts[0]).toMatchObject({
      artifact: {
        title: "Client brief",
        meta: "client-demo · saved /repo/.crewon/offices/artifacts/client-brief.md",
      },
      root: "/repo",
      threadId: "office-thread",
    });
    expect(captured.threads[0]?.turns).toEqual([
      turn({ id: "turn-artifact" }),
    ]);
    expect(captured.libraryPanel?.workspace?.messages).toEqual([
      captured.upsertedArtifacts[0]?.message,
    ]);
    expect(captured.capabilityPanel).toMatchObject({
      title: "Client brief",
      subtitle: "/repo/.crewon/offices/artifacts/client-brief.md",
    });
  });

  it("delegates directory matches to the capability item handler", async () => {
    const captured = state();
    const handled = await runAction(captured, {
      client: client(captured, {
        files: [
          {
            root: "/repo",
            path: "docs",
            match_type: "directory",
            file_name: "docs",
            score: 1,
            indices: null,
          },
        ],
      }),
    });

    expect(handled).toBe(true);
    expect(captured.directoryItems).toEqual([
      {
        label: "Client brief",
        path: "/repo/docs",
        kind: "directory",
      },
    ]);
    expect(captured.capabilityPanel).toMatchObject({
      title: "Client brief",
      subtitle: "/repo/docs",
      items: [{ label: "> docs", path: "/repo/docs", kind: "directory" }],
    });
  });

  it("loads matching artifact files into the capability panel", async () => {
    const captured = state();
    const handled = await runAction(captured, {
      artifact: artifact({
        contentSha256:
          "9938be87d35f2a7a2b80237e8dc71806b209aaea8252f12c1b12949f61d40476",
        contentSource: "file",
        contentStatus: "fingerprinted",
      }),
      client: client(captured, {
        files: [
          {
            root: "/repo",
            path: "docs/client-brief.md",
            match_type: "file",
            file_name: "Client brief",
            score: 1,
            indices: null,
          },
        ],
      }),
    });

    expect(handled).toBe(true);
    expect(captured.capabilityPanel).toMatchObject({
      title: "Client brief",
      subtitle: "/repo/docs/client-brief.md",
      body: expect.stringContaining("artifact body"),
      items: [
        {
          label: "  docs/client-brief.md",
          path: "/repo/docs/client-brief.md",
          kind: "file",
        },
      ],
    });
    expect(captured.capabilityPanel?.body).toContain(
      "- Current read SHA-256: 9938be87d35f2a7a2b80237e8dc71806b209aaea8252f12c1b12949f61d40476",
    );
    expect(captured.capabilityPanel?.body).toContain(
      "- Fingerprint: matches backend record",
    );
  });

  it("loads explicit artifact paths before fuzzy title matches", async () => {
    const captured = state();
    const handled = await runAction(captured, {
      artifact: artifact({
        path: "docs/exact/client-brief.md",
      }),
      client: client(captured, {
        files: [
          {
            root: "/repo",
            path: "docs/wrong/client-brief.md",
            match_type: "file",
            file_name: "Client brief",
            score: 1,
            indices: null,
          },
        ],
      }),
    });

    expect(handled).toBe(true);
    expect(captured.fuzzySearches).toEqual([]);
    expect(captured.readFiles).toEqual(["/repo/docs/exact/client-brief.md"]);
    expect(captured.metadataPaths).toEqual([
      "/repo/docs/exact/client-brief.md",
    ]);
    expect(captured.capabilityPanel).toMatchObject({
      title: "Client brief",
      subtitle: "/repo/docs/exact/client-brief.md",
      body: expect.stringContaining("artifact body"),
      items: [
        {
          label: "  docs/exact/client-brief.md",
          path: "/repo/docs/exact/client-brief.md",
          kind: "file",
        },
      ],
    });
  });

  it("loads explicit artifact URLs before fuzzy title matches", async () => {
    const captured = state();
    const handled = await runAction(captured, {
      artifact: artifact({
        url: "artifact://office/client-brief.md",
      }),
      client: client(captured, {
        files: [
          {
            root: "/repo",
            path: "docs/wrong/client-brief.md",
            match_type: "file",
            file_name: "Client brief",
            score: 1,
            indices: null,
          },
        ],
      }),
    });

    expect(handled).toBe(true);
    expect(captured.fuzzySearches).toEqual([]);
    expect(captured.readFiles).toEqual(["artifact://office/client-brief.md"]);
    expect(captured.metadataPaths).toEqual(["artifact://office/client-brief.md"]);
    expect(captured.capabilityPanel).toMatchObject({
      title: "Client brief",
      subtitle: "artifact://office/client-brief.md",
      body: expect.stringContaining("artifact body"),
      items: [
        {
          label: "  artifact://office/client-brief.md",
          path: "artifact://office/client-brief.md",
          kind: "file",
        },
      ],
    });
  });

  it("skips while another tool is busy", async () => {
    const captured = state();
    const handled = await runAction(captured, {
      busyToolId: "terminal",
    });

    expect(handled).toBe(false);
    expect(captured.capabilityPanel).toBeNull();
    expect(captured.busyToolId).toBeNull();
  });
});
