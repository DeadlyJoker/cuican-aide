import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import { describe, expect, it, vi } from "vitest";

import type {
  OfficeMessageSubmitResponse,
  OfficeRunResponse,
} from "../app-server/appServer";
import type {
  LibraryPanel,
  OfficeConfig,
  OfficeMessage,
  OfficeWorkspace,
} from "../domain/crewonDomain";
import {
  sendOfficeMessageAction,
  type OfficeMessageActionParams,
} from "./officeMessageActions";
import type { OfficeRunTurnRecord } from "./officeRunPanel";

type CapturedOfficeMessageState = {
  activeTurns: Record<string, string>;
  ensuredThreads: Array<{ forceNew?: boolean; workspaceMessages: number }>;
  libraryPanel: LibraryPanel | null;
  persistedMessages: Array<{ text: string; threadId: string }>;
  runRecords: Record<string, OfficeRunTurnRecord>;
  runRevisions: Array<string | undefined>;
  runThreads: string[];
  startedTurns: Array<{ input: string; threadId: string }>;
  threads: Thread[];
};

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

function workspace(overrides: Partial<OfficeWorkspace> = {}): OfficeWorkspace {
  return {
    goal: "Ship cleaner frontend",
    threadId: "office-thread",
    backendStatus: "connected",
    members: [
      {
        name: "Coordinator",
        role: "Office coordination",
        glyph: "@",
        accent: "blue",
        status: "online",
        online: true,
      },
    ],
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

function runResponse(overrides: Partial<OfficeRunResponse> = {}): OfficeRunResponse {
  return {
    filePath: "/offices/office.json",
    config: officeConfig(workspace({ threadId: "run-thread" })),
    threadId: "run-thread",
    runId: "run-1",
    turn: turn({ id: "run-turn" }),
    ...overrides,
  };
}

function state(initialPanel: LibraryPanel | null = panel()): CapturedOfficeMessageState {
  return {
    activeTurns: {},
    ensuredThreads: [],
    libraryPanel: initialPanel,
    persistedMessages: [],
    runRecords: {},
    runRevisions: [],
    runThreads: [],
    startedTurns: [],
    threads: [thread()],
  };
}

function submitResponse(
  overrides: Partial<OfficeMessageSubmitResponse> = {},
): OfficeMessageSubmitResponse {
  return {
    filePath: "/offices/office.json",
    config: officeConfig(
      workspace({
        threadId: "office-thread",
        recordRevision: "revision-submit",
        messages: [
          {
            clientUserMessageId: "message-1",
            author: "Coordinator",
            glyph: "@",
            accent: "slate",
            time: "now",
            kind: "message",
            text: "Ship it",
          },
        ],
      }),
    ),
    receiptId: "receipt-1",
    clientUserMessageId: "message-1",
    replayed: false,
    delivery: {
      type: "queued",
      afterRunId: "run-current",
      position: 1,
    },
    ...overrides,
  };
}

function baseParams(
  captured: CapturedOfficeMessageState,
  overrides: Partial<OfficeMessageActionParams> = {},
): OfficeMessageActionParams {
  const params: OfficeMessageActionParams = {
    clientUserMessageId: "message-1",
    confirmLegacyOfficeIdle: async () => "confirmedIdle",
    ensureOfficeThread: async (_panel, targetWorkspace, forceNew) => {
      captured.ensuredThreads.push({
        forceNew,
        workspaceMessages: targetWorkspace.messages.length,
      });
      const threadId = forceNew ? "office-thread-recreated" : "office-thread";
      return {
        config: officeConfig({
          ...targetWorkspace,
          threadId,
          recordRevision: forceNew ? "revision-recreated" : "revision-current",
        }),
        filePath: `/offices/${threadId}.json`,
        threadId,
      };
    },
    isConnected: true,
    isMissingThreadError: (error) =>
      error instanceof Error && error.message === "missing-thread",
    isUnsupportedRpcError: (error) =>
      error instanceof Error && error.message === "unsupported-submit",
    locale: "en",
    panel: captured.libraryPanel,
    persistOfficeMessage: async (
      _panel,
      _workspaceBeforeMessage,
      _message,
      text,
      threadId,
      fallbackWorkspace,
    ) => {
      captured.persistedMessages.push({ text, threadId });
      return officeConfig({ ...fallbackWorkspace, threadId });
    },
    recordOfficeRunTurn: (turnId, record) => {
      captured.runRecords[turnId] = record;
    },
    runOfficeMessage: async () => ({
      cwd: "/repo",
      handled: false,
      response: null,
    }),
    setActiveTurnByThread: (updater) => {
      captured.activeTurns = updater(captured.activeTurns);
    },
    setLibraryPanel: (updater) => {
      captured.libraryPanel = updater(captured.libraryPanel);
    },
    setThreads: (updater) => {
      captured.threads = updater(captured.threads);
    },
    startTurn: async (threadId, input) => {
      captured.startedTurns.push({ threadId, input });
      return { turn: turn({ id: `turn-${threadId}` }) };
    },
    submitOfficeMessage: async () => {
      throw new Error("unsupported-submit");
    },
    text: "Ship it",
    ...overrides,
  };
  params.clientUserMessageId =
    overrides.clientUserMessageId ?? "message-1";
  return params;
}

describe("office message actions", () => {
  it("retains the draft without inventing Office activity when disconnected", async () => {
    const captured = state();
    const handled = await sendOfficeMessageAction(
      baseParams(captured, {
        isConnected: false,
      }),
    );

    expect(handled).toEqual({
      delivery: null,
      disposition: "retainOutbox",
    });
    expect(captured.ensuredThreads).toEqual([]);
    expect(captured.libraryPanel).toEqual(panel());
  });

  it("replaces the optimistic bubble with the canonical submit response", async () => {
    const captured = state();
    const response = submitResponse();

    await expect(
      sendOfficeMessageAction(
        baseParams(captured, {
          submitOfficeMessage: async () => ({ cwd: "/repo", response }),
        }),
      ),
    ).resolves.toEqual({
      delivery: response.delivery,
      disposition: "retainOutbox",
    });

    expect(captured.ensuredThreads).toEqual([]);
    expect(captured.startedTurns).toEqual([]);
    expect(captured.persistedMessages).toEqual([]);
    expect(captured.libraryPanel).toMatchObject({
      configPath: "/offices/office.json",
      workspace: {
        backendStatus: "connected",
        recordRevision: "revision-submit",
        messages: [
          {
            clientUserMessageId: "message-1",
            text: "Ship it",
          },
        ],
      },
    });
    expect(captured.libraryPanel?.workspace?.messages).toHaveLength(1);
  });

  it("provisions a server-owned manager before the first threadless message", async () => {
    const captured = state(
      panel(
        workspace({
          recordId: "office-record",
          recordRevision: "revision-1",
          threadId: undefined,
        }),
      ),
    );
    let submittedWorkspace: OfficeWorkspace | null = null;

    const handled = await sendOfficeMessageAction(
      baseParams(captured, {
        submitOfficeMessage: async (_panel, targetWorkspace) => {
          submittedWorkspace = targetWorkspace;
          return {
            cwd: "/repo",
            response: submitResponse({
              config: officeConfig(
                workspace({
                  recordId: "office-record",
                  recordRevision: "revision-submit",
                  threadId: "office-thread",
                }),
              ),
            }),
          };
        },
      }),
    );

    expect(captured.ensuredThreads).toEqual([
      { forceNew: undefined, workspaceMessages: 0 },
    ]);
    expect(submittedWorkspace).toMatchObject({
      recordId: "office-record",
      recordRevision: "revision-current",
      threadId: "office-thread",
    });
    expect(handled.disposition).toBe("retainOutbox");
  });

  it("surfaces a threadless manager provisioning failure for a visible retry", async () => {
    const captured = state(
      panel(
        workspace({
          recordId: "office-record",
          recordRevision: "revision-1",
          threadId: undefined,
        }),
      ),
    );
    const submitOfficeMessage = vi.fn();

    await expect(
      sendOfficeMessageAction(
        baseParams(captured, {
          ensureOfficeThread: async () => {
            throw new Error("manager ensure failed");
          },
          submitOfficeMessage,
        }),
      ),
    ).rejects.toThrow("manager ensure failed");

    expect(submitOfficeMessage).not.toHaveBeenCalled();
    expect(captured.libraryPanel?.workspace).toMatchObject({
      backendStatus: "error",
      messages: [
        {
          clientOnly: true,
          kind: "system",
          text: "manager ensure failed",
        },
      ],
      threadId: undefined,
    });
  });

  it("treats an empty manager ensure response as a visible failure", async () => {
    const captured = state(
      panel(
        workspace({
          recordId: "office-record",
          recordRevision: "revision-1",
          threadId: undefined,
        }),
      ),
    );

    await expect(
      sendOfficeMessageAction(
        baseParams(captured, {
          ensureOfficeThread: async () => null,
        }),
      ),
    ).rejects.toThrow("Unable to provision the Office manager runtime");

    expect(captured.libraryPanel?.workspace).toMatchObject({
      backendStatus: "error",
      messages: [
        {
          kind: "system",
          text: "Unable to provision the Office manager runtime",
        },
      ],
    });
  });

  it("records a runStarted submit delivery without creating a second turn", async () => {
    const captured = state();
    captured.threads = [thread()];
    const response = submitResponse({
      delivery: {
        type: "runStarted",
        runId: "run-submit",
        threadId: "office-thread",
        turn: turn({ id: "turn-submit" }),
      },
    });

    await sendOfficeMessageAction(
      baseParams(captured, {
        submitOfficeMessage: async () => ({ cwd: "/repo", response }),
      }),
    );

    expect(captured.runRecords).toEqual({
      "turn-submit": {
        cwd: "/repo",
        runId: "run-submit",
        threadId: "office-thread",
        turnThreadId: "office-thread",
        config: response.config,
      },
    });
    expect(captured.activeTurns).toEqual({
      "office-thread": "turn-submit",
    });
    expect(captured.threads[0]?.turns).toEqual([
      expect.objectContaining({ id: "turn-submit" }),
    ]);
    expect(captured.startedTurns).toEqual([]);
  });

  it("fails closed when an active Office uses a server without submit", async () => {
    const captured = state(
      panel(
        workspace({
          activity: {
            runs: [
              {
                id: "run-active",
                title: "Active",
                status: "running",
              },
            ],
          },
        }),
      ),
    );

    await expect(
      sendOfficeMessageAction(baseParams(captured)),
    ).rejects.toThrow("unsupported-submit");

    expect(captured.ensuredThreads).toEqual([]);
    expect(captured.startedTurns).toEqual([]);
    expect(captured.persistedMessages).toEqual([]);
  });

  it("fails closed when local runtime cannot confirm legacy idle", async () => {
    const captured = state();

    await expect(
      sendOfficeMessageAction(
        baseParams(captured, {
          confirmLegacyOfficeIdle: async () => "deny",
        }),
      ),
    ).rejects.toThrow("unsupported-submit");

    expect(captured.ensuredThreads).toEqual([]);
    expect(captured.startedTurns).toEqual([]);
    expect(captured.persistedMessages).toEqual([]);
  });

  it("keeps the canonical receipt but rejects a failed delivery for retry", async () => {
    const captured = state();
    const response = submitResponse({
      config: officeConfig(
        workspace({
          recordRevision: "revision-failed",
          messages: [
            {
              clientUserMessageId: "message-1",
              author: "Coordinator",
              glyph: "@",
              accent: "slate",
              time: "now",
              text: "Ship it",
            },
          ],
        }),
      ),
      delivery: {
        type: "failed",
        code: "queuePersistenceFailed",
        message: "queue persistence failed",
        retryable: false,
      },
    });

    await expect(
      sendOfficeMessageAction(
        baseParams(captured, {
          submitOfficeMessage: async () => ({ cwd: "/repo", response }),
        }),
      ),
    ).rejects.toThrow("queue persistence failed");

    expect(captured.ensuredThreads).toEqual([]);
    expect(captured.libraryPanel?.workspace).toMatchObject({
      backendStatus: "error",
      recordRevision: "revision-failed",
      messages: [
        { clientUserMessageId: "message-1", text: "Ship it" },
        { kind: "system", text: "queue persistence failed" },
      ],
    });
  });

  it("treats processing as an accepted durable receipt", async () => {
    const captured = state();
    const response = submitResponse({
      delivery: {
        type: "processing",
        phase: "dispatching",
        retryAfterMs: 250,
      },
    });

    await expect(
      sendOfficeMessageAction(
        baseParams(captured, {
          submitOfficeMessage: async () => ({ cwd: "/repo", response }),
        }),
      ),
    ).resolves.toEqual({
      delivery: response.delivery,
      disposition: "retainOutbox",
    });
    expect(captured.libraryPanel?.workspace?.recordRevision).toBe(
      "revision-submit",
    );
  });

  it("retries queued work with the same receipt until a run starts", async () => {
    const captured = state();
    const submittedIds: string[] = [];
    const queued = submitResponse();
    const started = submitResponse({
      delivery: {
        type: "runStarted",
        runId: "run-after-queue",
        threadId: "office-thread",
        turn: turn({ id: "turn-after-queue" }),
      },
      replayed: true,
    });
    let attempt = 0;
    const submitOfficeMessage: OfficeMessageActionParams["submitOfficeMessage"] =
      async (_panel, _workspace, _text, clientUserMessageId) => {
        submittedIds.push(clientUserMessageId);
        const response = attempt === 0 ? queued : started;
        attempt += 1;
        return { cwd: "/repo", response };
      };

    await expect(
      sendOfficeMessageAction(
        baseParams(captured, { submitOfficeMessage }),
      ),
    ).resolves.toEqual({
      delivery: queued.delivery,
      disposition: "retainOutbox",
    });
    await expect(
      sendOfficeMessageAction(
        baseParams(captured, { submitOfficeMessage }),
      ),
    ).resolves.toEqual({
      delivery: started.delivery,
      disposition: "clearOutbox",
    });

    expect(submittedIds).toEqual(["message-1", "message-1"]);
    expect(captured.libraryPanel?.workspace?.messages).toHaveLength(1);
    expect(captured.activeTurns).toEqual({
      "office-thread": "turn-after-queue",
    });
  });

  it("reconciles interaction turns and clears only the exact answered turn", async () => {
    const captured = state();
    const interactionTurn = turn({ id: "interaction-turn" });
    const started = submitResponse({
      delivery: {
        type: "interactionStarted",
        interactionId: "interaction-1",
        threadId: "office-thread",
        turn: interactionTurn,
      },
    });
    await sendOfficeMessageAction(
      baseParams(captured, {
        submitOfficeMessage: async () => ({ cwd: "/repo", response: started }),
      }),
    );

    expect(captured.activeTurns).toEqual({
      "office-thread": "interaction-turn",
    });
    expect(captured.threads[0]?.turns).toEqual([interactionTurn]);

    const answered = submitResponse({
      delivery: {
        type: "answered",
        interactionId: "interaction-1",
        threadId: "office-thread",
        turnId: "interaction-turn",
      },
      replayed: true,
    });
    await sendOfficeMessageAction(
      baseParams(captured, {
        submitOfficeMessage: async () => ({ cwd: "/repo", response: answered }),
      }),
    );
    expect(captured.activeTurns).toEqual({});
  });

  it("rejects a response whose canonical Office identity changed", async () => {
    const captured = state();
    const response = submitResponse({
      config: officeConfig(workspace({ threadId: "other-office-thread" })),
    });

    await expect(
      sendOfficeMessageAction(
        baseParams(captured, {
          submitOfficeMessage: async () => ({ cwd: "/repo", response }),
        }),
      ),
    ).rejects.toThrow("response identity does not match");
    expect(captured.activeTurns).toEqual({});
    expect(captured.threads[0]?.turns).toEqual([]);
  });

  it("does not apply Office A canonical state after the panel switches to Office B", async () => {
    const officeA = panel(
      workspace({ recordId: "office-a", threadId: "office-thread" }),
    );
    const captured = state(officeA);
    let resolveResponse:
      | ((value: { cwd: string; response: OfficeMessageSubmitResponse }) => void)
      | undefined;
    const pending = new Promise<{
      cwd: string;
      response: OfficeMessageSubmitResponse;
    }>((resolve) => {
      resolveResponse = resolve;
    });
    const response = submitResponse({
      config: officeConfig(
        workspace({ recordId: "office-a", threadId: "office-thread" }),
      ),
      delivery: {
        type: "runStarted",
        runId: "run-a",
        threadId: "office-thread",
        turn: turn({ id: "turn-a" }),
      },
    });
    const action = sendOfficeMessageAction(
      baseParams(captured, {
        submitOfficeMessage: async () => pending,
      }),
    );
    captured.libraryPanel = panel(
      workspace({ recordId: "office-b", threadId: "thread-b" }),
    );
    resolveResponse?.({ cwd: "/repo", response });

    await expect(action).resolves.toEqual({
      delivery: response.delivery,
      disposition: "clearOutbox",
    });
    expect(captured.libraryPanel?.workspace?.recordId).toBe("office-b");
    expect(captured.libraryPanel?.workspace?.threadId).toBe("thread-b");
    expect(captured.activeTurns).toEqual({ "office-thread": "turn-a" });
  });

  it("records backend run responses and skips fallback persistence", async () => {
    const captured = state(panel(workspace({ threadId: "run-thread" })));
    captured.threads = [thread({ id: "run-thread" })];
    const response = runResponse();
    const handled = await sendOfficeMessageAction(
      baseParams(captured, {
        runOfficeMessage: async (_panel, targetWorkspace, _message, _text, threadId) => {
          captured.runRevisions.push(targetWorkspace.recordRevision);
          captured.runThreads.push(threadId);
          return {
            cwd: "/repo",
            handled: true,
            response,
          };
        },
      }),
    );

    expect(handled).toEqual({
      delivery: null,
      disposition: "clearOutbox",
    });
    expect(captured.runThreads).toEqual(["office-thread"]);
    expect(captured.runRevisions).toEqual(["revision-current"]);
    expect(captured.persistedMessages).toEqual([]);
    expect(captured.startedTurns).toEqual([]);
    expect(captured.runRecords).toEqual({
      "run-turn": {
        cwd: "/repo",
        runId: "run-1",
        threadId: "run-thread",
        turnThreadId: "run-thread",
        config: response.config,
      },
    });
    expect(captured.activeTurns).toEqual({ "run-thread": "run-turn" });
    expect(captured.threads[0]?.turns).toEqual([response.turn]);
    expect(captured.libraryPanel?.workspace?.threadId).toBe("run-thread");
  });

  it("falls back to turn start and message persistence when run API is unavailable", async () => {
    const captured = state();
    const handled = await sendOfficeMessageAction(baseParams(captured));

    expect(handled).toEqual({
      delivery: null,
      disposition: "clearOutbox",
    });
    expect(captured.ensuredThreads).toEqual([
      { forceNew: undefined, workspaceMessages: 0 },
    ]);
    expect(captured.startedTurns).toEqual([
      {
        threadId: "office-thread",
        input: [
          'Office "Office" group chat message: Ship it',
          "Manager agent: first decide whether this message is a question, status nudge, added context, or new actionable goal before planning or delegating tasks.",
          "Status: message sent",
        ].join("\n"),
      },
    ]);
    expect(captured.persistedMessages).toEqual([
      { text: "Ship it", threadId: "office-thread" },
    ]);
    expect(captured.activeTurns).toEqual({
      "office-thread": "turn-office-thread",
    });
    expect(captured.libraryPanel?.workspace?.backendStatus).toBe("connected");
    expect(captured.libraryPanel?.workspace?.messages).toHaveLength(1);
  });

  it("recreates missing threads for run and turn fallback", async () => {
    const captured = state();
    let runCalls = 0;
    let startCalls = 0;
    const handled = await sendOfficeMessageAction(
      baseParams(captured, {
        runOfficeMessage: async () => {
          runCalls += 1;
          if (runCalls === 1) {
            throw new Error("missing-thread");
          }
          return {
            cwd: "/repo",
            handled: false,
            response: null,
          };
        },
        startTurn: async (threadId, input) => {
          startCalls += 1;
          if (startCalls === 1) {
            throw new Error("missing-thread");
          }
          captured.startedTurns.push({ threadId, input });
          return { turn: turn({ id: `turn-${threadId}` }) };
        },
      }),
    );

    expect(handled).toEqual({
      delivery: null,
      disposition: "clearOutbox",
    });
    expect(captured.ensuredThreads).toEqual([
      { forceNew: undefined, workspaceMessages: 0 },
      { forceNew: true, workspaceMessages: 0 },
      { forceNew: true, workspaceMessages: 0 },
    ]);
    expect(captured.startedTurns[0]?.threadId).toBe("office-thread-recreated");
    expect(captured.persistedMessages).toEqual([
      { text: "Ship it", threadId: "office-thread-recreated" },
    ]);
    expect(captured.activeTurns).toEqual({
      "office-thread-recreated": "turn-office-thread-recreated",
    });
  });

  it("marks the office workspace as errored on backend failure", async () => {
    const captured = state();
    await expect(
      sendOfficeMessageAction(
        baseParams(captured, {
          runOfficeMessage: async () => {
            throw new Error("backend failed");
          },
        }),
      ),
    ).rejects.toThrow("backend failed");

    expect(captured.libraryPanel?.workspace?.backendStatus).toBe("error");
    expect(captured.libraryPanel?.workspace?.messages.at(-1)).toMatchObject({
      author: "System",
      glyph: "⌗",
      accent: "rose",
      text: "backend failed",
    });
  });

  it("selects the exact same-id user message after a failed legacy attempt", async () => {
    const captured = state();
    await expect(
      sendOfficeMessageAction(
        baseParams(captured, {
          runOfficeMessage: async () => {
            throw new Error("legacy failed");
          },
        }),
      ),
    ).rejects.toThrow("legacy failed");
    expect(captured.libraryPanel?.workspace?.messages.at(-1)).toMatchObject({
      kind: "system",
      text: "legacy failed",
    });

    let retriedMessage: OfficeMessage | null = null;
    await sendOfficeMessageAction(
      baseParams(captured, {
        runOfficeMessage: async (
          _panel,
          _workspace,
          message,
        ) => {
          retriedMessage = message;
          return { cwd: "/repo", handled: false, response: null };
        },
      }),
    );

    expect(retriedMessage).toMatchObject({
      clientUserMessageId: "message-1",
      kind: "message",
      text: "Ship it",
    });
  });

  it("does nothing without an office workspace", async () => {
    const captured = state(null);
    const handled = await sendOfficeMessageAction(baseParams(captured));

    expect(handled).toEqual({
      delivery: null,
      disposition: "retainOutbox",
    });
    expect(captured.libraryPanel).toBeNull();
    expect(captured.ensuredThreads).toEqual([]);
  });
});
