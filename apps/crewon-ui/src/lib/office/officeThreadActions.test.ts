import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import type { LibraryPanel, OfficeWorkspace } from "../domain/crewonDomain";
import {
  ensureOfficeThreadAction,
  type EnsureOfficeThreadActionParams,
} from "./officeThreadActions";

type CapturedOfficeThreadState = {
  ensured: Array<{ recordId: string; revision: string }>;
  libraryPanel: LibraryPanel | null;
  threads: Thread[];
};

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

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Coordinate office",
    threadId: "office-thread",
    recordId: "office-record",
    recordRevision: "revision-office",
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

function panel(workspaceConfig: OfficeWorkspace | null = workspace()): LibraryPanel {
  return {
    kind: "office",
    title: "Office",
    subtitle: "Workspace",
    items: [],
    workspace: workspaceConfig ?? undefined,
  };
}

function state(initialPanel: LibraryPanel | null = panel()): CapturedOfficeThreadState {
  return {
    ensured: [],
    libraryPanel: initialPanel,
    threads: [],
  };
}

function baseParams(
  captured: CapturedOfficeThreadState,
  overrides: Partial<EnsureOfficeThreadActionParams> = {},
): EnsureOfficeThreadActionParams {
  return {
    isConnected: true,
    isMissingThreadError: (error) =>
      error instanceof Error && error.message === "missing-thread",
    locale: "en",
    panel: captured.libraryPanel ?? panel(),
    ensureOfficeManager: async (recordId, revision) => {
      captured.ensured.push({ recordId, revision });
      const targetWorkspace = captured.libraryPanel?.workspace ?? workspace();
      return {
        config: {
          title: captured.libraryPanel?.title ?? "Office",
          subtitle: captured.libraryPanel?.subtitle ?? "Workspace",
          workspace: {
            ...targetWorkspace,
            recordId,
            recordRevision: "revision-new-office-thread",
            threadId: "new-office-thread",
          },
        },
        filePath: "/offices/new-office-thread.json",
        threadId: "new-office-thread",
      };
    },
    readThread: async (threadId) => thread({ id: threadId }),
    setLibraryPanel: (updater) => {
      captured.libraryPanel = updater(captured.libraryPanel);
    },
    setThreads: (updater) => {
      captured.threads = updater(captured.threads);
    },
    ...overrides,
  };
}

describe("office thread actions", () => {
  it("returns the existing thread id while disconnected", async () => {
    const captured = state();
    const resolution = await ensureOfficeThreadAction(
      baseParams(captured, {
        isConnected: false,
      }),
    );

    expect(resolution?.threadId).toBe("office-thread");
    expect(captured.ensured).toEqual([]);
  });

  it("reuses a readable existing backend thread and refreshes panel state", async () => {
    const captured = state();
    const resolution = await ensureOfficeThreadAction(baseParams(captured));

    expect(resolution?.threadId).toBe("office-thread");
    expect(captured.ensured).toEqual([]);
    expect(captured.libraryPanel?.workspace?.backendStatus).toBe("connected");
    expect(captured.libraryPanel?.workspace?.threadId).toBe("office-thread");
  });

  it("uses the server-owned manager ensure flow when the saved one is missing", async () => {
    const captured = state();
    const resolution = await ensureOfficeThreadAction(
      baseParams(captured, {
        readThread: async (threadId) => {
          if (threadId === "office-thread") {
            throw new Error("missing-thread");
          }
          return thread({ id: threadId });
        },
      }),
    );

    expect(resolution).toMatchObject({
      config: {
        workspace: {
          recordRevision: "revision-new-office-thread",
          threadId: "new-office-thread",
        },
      },
      filePath: "/offices/new-office-thread.json",
      threadId: "new-office-thread",
    });
    expect(captured.ensured).toEqual([
      {
        recordId: "office-record",
        revision: "revision-office",
      },
    ]);
    expect(captured.threads).toEqual([
      thread({ id: "new-office-thread", name: "Office" }),
    ]);
    expect(captured.libraryPanel?.workspace?.threadId).toBe("new-office-thread");
    expect(captured.libraryPanel?.workspace?.recordRevision).toBe(
      "revision-new-office-thread",
    );
    expect(captured.libraryPanel?.configPath).toBe(
      "/offices/new-office-thread.json",
    );
  });

  it("asks the server to repair or reuse the manager when forced", async () => {
    const captured = state();
    const resolution = await ensureOfficeThreadAction(
      baseParams(captured, {
        forceNew: true,
      }),
    );

    expect(resolution?.threadId).toBe("new-office-thread");
    expect(captured.ensured).toEqual([
      {
        recordId: "office-record",
        revision: "revision-office",
      },
    ]);
  });

  it("does not apply a completed binding after switching offices", async () => {
    const captured = state();
    const resolution = await ensureOfficeThreadAction(
      baseParams(captured, {
        forceNew: true,
        ensureOfficeManager: async (recordId, revision) => {
          captured.ensured.push({ recordId, revision });
          captured.libraryPanel = panel(
            workspace({
              recordId: "office-b-record",
              threadId: "office-b-thread",
            }),
          );
          return {
            config: {
              title: "Office",
              subtitle: "Workspace",
              workspace: workspace({
                recordId,
                recordRevision: "revision-new-office-thread",
                threadId: "new-office-thread",
              }),
            },
            filePath: "/offices/new-office-thread.json",
            threadId: "new-office-thread",
          };
        },
      }),
    );

    expect(resolution?.threadId).toBe("new-office-thread");
    expect(captured.libraryPanel?.workspace).toMatchObject({
      recordId: "office-b-record",
      threadId: "office-b-thread",
    });
    expect(captured.libraryPanel?.configPath).toBeUndefined();
  });

  it("returns null without a workspace", async () => {
    const captured = state(panel(null));
    const resolution = await ensureOfficeThreadAction(baseParams(captured));

    expect(resolution).toBeNull();
    expect(captured.ensured).toEqual([]);
    expect(captured.threads).toEqual([]);
  });

  it("returns null when the manager ensure request cannot produce a runtime", async () => {
    const captured = state();
    const resolution = await ensureOfficeThreadAction(
      baseParams(captured, {
        forceNew: true,
        ensureOfficeManager: async () => null,
      }),
    );

    expect(resolution).toBeNull();
    expect(captured.libraryPanel?.workspace?.backendStatus).toBe("binding");
    expect(captured.ensured).toEqual([]);
  });

  it("rejects an unversioned Office before requesting a manager", async () => {
    const captured = state(
      {
        ...panel(
          workspace({
            recordId: undefined,
            recordRevision: undefined,
            threadId: undefined,
          }),
        ),
        configPath: "/offices/legacy.json",
        workspaceCwd: "/repo",
      },
    );

    await expect(
      ensureOfficeThreadAction(baseParams(captured, { forceNew: true })),
    ).rejects.toThrow("Office state is incomplete");
    expect(captured.ensured).toEqual([]);
  });
});
