import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import type { LibraryPanel, McpDetailAction } from "../domain/crewonDomain";
import { openMcpDetailAction } from "./mcpDetailActions";

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "github.search_issues result",
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
    name: "Tool check · github.search_issues",
    turns: [],
    ...overrides,
  };
}

function panel(): LibraryPanel {
  return {
    kind: "tools",
    title: "Tools",
    subtitle: "Library",
    body: "Existing",
    items: [],
  };
}

function mcpAction(overrides: Partial<McpDetailAction> = {}): McpDetailAction {
  return {
    type: "mcp-detail",
    title: "GitHub search",
    subtitle: "github.search_issues",
    body: "Search issues",
    tool: {
      server: "github",
      name: "search_issues",
      label: "Search issues",
      inputSchema: "{}",
    },
    ...overrides,
  };
}

async function runAction(
  overrides: Partial<Parameters<typeof openMcpDetailAction>[0]> = {},
) {
  let currentPanel: LibraryPanel | null = panel();
  const handled = await openMcpDetailAction({
    action: mcpAction(),
    isConnected: true,
    listThreads: async () => [],
    locale: "en",
    readThread: async (threadId) => thread({ id: threadId }),
    refreshToolAction: async (action) => action,
    setLibraryPanel: (updater) => {
      currentPanel = updater(currentPanel);
    },
    ...overrides,
  });
  return { currentPanel, handled };
}

describe("mcp detail actions", () => {
  it("renders detail content without loading history for actions without a tool", async () => {
    let listed = false;
    const { currentPanel, handled } = await runAction({
      action: mcpAction({ tool: undefined }),
      listThreads: async () => {
        listed = true;
        return [];
      },
    });

    expect(handled).toBe(true);
    expect(listed).toBe(false);
    expect(currentPanel).toMatchObject({
      title: "GitHub search",
      subtitle: "github.search_issues",
      body: "Search issues",
      items: [],
    });
  });

  it("loads matching tool history when connected", async () => {
    const historyThread = thread({
      id: "tool-thread",
      turns: [turn({ id: "tool-turn" })],
    });
    const { currentPanel, handled } = await runAction({
      listThreads: async () => [historyThread],
      readThread: async () => historyThread,
    });

    expect(handled).toBe(true);
    expect(currentPanel?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "open-thread",
          threadId: "tool-thread",
        }),
      ]),
    );
    expect(currentPanel?.items[0]).toMatchObject({
      title: "Backend call history",
    });
  });

  it("shows empty history when no matching thread exists", async () => {
    const { currentPanel, handled } = await runAction({
      listThreads: async () => [
        thread({ id: "other", name: "Other", preview: "unrelated" }),
      ],
    });

    expect(handled).toBe(true);
    expect(currentPanel?.items).toEqual([
      {
        title: "No call history",
        meta: "Waiting for first call",
        description:
          "Call an MCP tool or read a resource to write results into the backend tool verification thread.",
        glyph: "◷",
        accent: "slate",
      },
    ]);
  });

  it("shows history loading failures", async () => {
    const { currentPanel, handled } = await runAction({
      listThreads: async () => {
        throw new Error("history failed");
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel).toMatchObject({
      error: "history failed",
    });
  });

  it("skips history loading while disconnected", async () => {
    let listed = false;
    const { currentPanel, handled } = await runAction({
      isConnected: false,
      listThreads: async () => {
        listed = true;
        return [];
      },
    });

    expect(handled).toBe(true);
    expect(listed).toBe(false);
    expect(currentPanel?.items[0]).toMatchObject({
      title: "Reading call history",
    });
  });
});
