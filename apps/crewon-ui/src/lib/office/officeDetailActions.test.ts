import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import type {
  LibraryItemAction,
  LibraryPanel,
  OfficeConfig,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import { openOfficeDetailAction } from "./officeDetailActions";

type OfficeDetailAction = Extract<LibraryItemAction, { type: "office-detail" }>;

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
    id: "office-thread",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Office update",
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

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Coordinate office",
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

function officeConfig(
  workspaceConfig: OfficeWorkspace,
  overrides: Partial<OfficeConfig> = {},
): OfficeConfig {
  return {
    title: "Latest Office",
    subtitle: "Latest Workspace",
    workspace: workspaceConfig,
    ...overrides,
  };
}

function action(overrides: Partial<OfficeDetailAction> = {}): OfficeDetailAction {
  return {
    type: "office-detail",
    title: "Office",
    subtitle: "Workspace",
    body: "Office body",
    items: [],
    workspace: workspace(),
    ...overrides,
  };
}

function panel(): LibraryPanel {
  return {
    kind: "office",
    title: "Office Library",
    subtitle: "Library",
    items: [],
  };
}

async function runAction(
  overrides: Partial<Parameters<typeof openOfficeDetailAction>[0]> = {},
) {
  let currentPanel: LibraryPanel | null = panel();
  const ensured: Array<{ title: string; workspaceThreadId?: string }> = [];
  const handled = await openOfficeDetailAction({
    action: action(),
    ensureOfficeThread: async (targetPanel, workspaceOverride) => {
      ensured.push({
        title: targetPanel.title,
        workspaceThreadId: workspaceOverride?.threadId,
      });
      const threadId = workspaceOverride?.threadId ?? "office-thread";
      return {
        config: {
          title: targetPanel.title,
          subtitle: targetPanel.subtitle,
          workspace: {
            ...(workspaceOverride ?? workspace()),
            threadId,
            recordRevision: "revision-bound",
          },
        },
        filePath: "/offices/office.json",
        threadId,
      };
    },
    isConnected: true,
    isUnsupportedRpcError: (error) =>
      error instanceof Error && error.message === "unsupported",
    locale: "en",
    readOfficeConfig: async () => null,
    readThread: async (threadId) => thread({ id: threadId }),
    setLibraryPanel: (updater) => {
      currentPanel = updater(currentPanel);
    },
    ...overrides,
  });
  return { currentPanel, ensured, handled };
}

describe("office detail actions", () => {
  it("renders local office detail without backend hydration while disconnected", async () => {
    const { currentPanel, ensured, handled } = await runAction({
      isConnected: false,
    });

    expect(handled).toBe(true);
    expect(ensured).toEqual([]);
    expect(currentPanel).toMatchObject({
      kind: "office",
      title: "Office",
      subtitle: "Workspace",
      workspace: { threadId: "office-thread" },
    });
  });

  it("loads latest office config and hydrates from the bound thread", async () => {
    const latestWorkspace = workspace({
      threadId: "latest-thread",
      messages: [
        {
          author: "System",
          glyph: "⌗",
          accent: "slate",
          time: "now",
          text: "Existing",
        },
      ],
    });
    const { currentPanel, ensured, handled } = await runAction({
      readOfficeConfig: async () => ({
        record: { config: officeConfig(latestWorkspace) },
      }),
      readThread: async (threadId) =>
        thread({
          id: threadId,
          turns: [
            turn({
              items: [
                {
                  type: "agentMessage",
                  id: "item-1",
                  text: "Backend update",
                  phase: null,
                  memoryCitation: null,
                },
              ],
            }),
          ],
        }),
    });

    expect(handled).toBe(true);
    expect(ensured).toEqual([
      { title: "Latest Office", workspaceThreadId: "latest-thread" },
    ]);
    expect(currentPanel).toMatchObject({
      title: "Latest Office",
      subtitle: "Latest Workspace",
      workspace: {
        recordRevision: "revision-bound",
        threadId: "latest-thread",
        messages: [{ text: "Existing" }, { text: "Backend update" }],
      },
    });
  });

  it("continues binding when office/read is unsupported", async () => {
    const { currentPanel, ensured, handled } = await runAction({
      readOfficeConfig: async () => {
        throw new Error("unsupported");
      },
    });

    expect(handled).toBe(true);
    expect(ensured).toEqual([
      { title: "Office", workspaceThreadId: "office-thread" },
    ]);
    expect(currentPanel?.workspace?.threadId).toBe("office-thread");
  });

  it("marks the office detail as errored when hydration fails", async () => {
    const { currentPanel, handled } = await runAction({
      readOfficeConfig: async () => {
        throw new Error("read failed");
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel).toMatchObject({
      error: "read failed",
      workspace: { backendStatus: "error" },
    });
  });

  it("skips backend work when the action has no workspace", async () => {
    const { currentPanel, ensured, handled } = await runAction({
      action: action({ workspace: undefined }),
    });

    expect(handled).toBe(true);
    expect(ensured).toEqual([]);
    expect(currentPanel).toMatchObject({
      title: "Office",
      body: "Office body",
      workspace: undefined,
    });
  });
});
