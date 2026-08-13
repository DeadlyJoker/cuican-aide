import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { ThreadItem } from "@crewon-ui-model/v2/ThreadItem";
import type { Turn } from "@crewon-ui-model/v2/Turn";
import { describe, expect, it } from "vitest";

import {
  appendCommandOutputDeltaInThread,
  appendItemInThread,
  appendPlanDeltaInThread,
  appendReasoningContentDeltaInThread,
  appendReasoningSummaryDeltaInThread,
  appendTurnWithFallbackPreview,
  ensureReasoningSummaryPartInThread,
  mergeThreadListSummaries,
  mergeTurnsPreservingActionItems,
  removeThreadFromList,
  selectedThreadIdAfterThreadList,
  selectedThreadIdAfterThreadRemoval,
  updateFileChangeItemChangesInThread,
  updateItemInThread,
  updateThreadName,
  updateThreadStatus,
  updateThreadTurns,
  upsertTurnInThread,
} from "./threadModel";

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

function planItem(overrides: Partial<Extract<ThreadItem, { type: "plan" }>> = {}) {
  return {
    type: "plan" as const,
    id: "item-1",
    text: "first",
    ...overrides,
  };
}

function commandExecutionItem(
  overrides: Partial<Extract<ThreadItem, { type: "commandExecution" }>> = {},
): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id: "command-1",
    command: "npm test",
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    ...overrides,
  };
}

function fileChangeItem(
  overrides: Partial<Extract<ThreadItem, { type: "fileChange" }>> = {},
): Extract<ThreadItem, { type: "fileChange" }> {
  return {
    type: "fileChange",
    id: "file-1",
    changes: [],
    status: "inProgress",
    ...overrides,
  };
}

function reasoningItem(
  overrides: Partial<Extract<ThreadItem, { type: "reasoning" }>> = {},
): Extract<ThreadItem, { type: "reasoning" }> {
  return {
    type: "reasoning",
    id: "reasoning-1",
    summary: [],
    content: [],
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
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
    cwd: "/workspace",
    clientVersion: "test",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [turn()],
    ...overrides,
  };
}

describe("thread model list helpers", () => {
  it("upserts a turn in the target thread", () => {
    const threads = [
      thread(),
      thread({ id: "thread-2", turns: [turn({ id: "turn-2" })] }),
    ];
    const nextTurn = turn({
      id: "turn-1",
      status: "completed",
      completedAt: 2,
    });

    expect(upsertTurnInThread(threads, "thread-1", nextTurn)).toEqual([
      {
        ...threads[0],
        turns: [nextTurn],
      },
      threads[1],
    ]);
  });

  it("preserves live items when turn/completed sends notLoaded empty items", () => {
    const liveCommand = commandExecutionItem({
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "ok",
    });
    const liveReasoning = reasoningItem({
      summary: ["Checking tests"],
    });
    const threads = [
      thread({
        turns: [
          turn({
            items: [liveReasoning, liveCommand],
            status: "inProgress",
          }),
        ],
      }),
    ];
    const completedStub = turn({
      id: "turn-1",
      items: [],
      itemsView: "notLoaded",
      status: "completed",
      completedAt: 9,
      durationMs: 100,
    });

    expect(upsertTurnInThread(threads, "thread-1", completedStub)).toEqual([
      {
        ...threads[0],
        turns: [
          {
            ...completedStub,
            items: [liveReasoning, liveCommand],
            itemsView: "full",
          },
        ],
      },
    ]);
  });

  it("preserves missing action items when upserting a partial completed turn", () => {
    const liveCommand = commandExecutionItem();
    const agentMessage = {
      id: "item-agent",
      type: "agentMessage" as const,
      text: "Done.",
      phase: "final_answer" as const,
      memoryCitation: null,
    };
    const threads = [
      thread({
        turns: [
          turn({
            items: [liveCommand, agentMessage],
            status: "inProgress",
          }),
        ],
      }),
    ];
    const nextTurn = turn({
      id: "turn-1",
      status: "completed",
      completedAt: 9,
      items: [agentMessage],
    });

    expect(upsertTurnInThread(threads, "thread-1", nextTurn)).toEqual([
      {
        ...threads[0],
        turns: [
          {
            ...nextTurn,
            // Missing live tools are reinserted; without a prior anchor they append.
            items: [agentMessage, liveCommand],
          },
        ],
      },
    ]);
  });

  it("appends and updates items in the target thread turn", () => {
    const threads = [
      thread({ turns: [turn({ items: [planItem()] })] }),
      thread({ id: "thread-2", turns: [turn({ id: "turn-2" })] }),
    ];
    const appended = appendItemInThread(
      threads,
      "thread-1",
      "turn-1",
      planItem({ id: "item-2", text: "second" }),
    );

    expect(appended[0].turns[0]?.items).toEqual([
      planItem(),
      planItem({ id: "item-2", text: "second" }),
    ]);
    expect(appended[1]).toBe(threads[1]);

    expect(
      updateItemInThread(
        appended,
        "thread-1",
        "turn-1",
        "item-2",
        (item) =>
          item.type === "plan" ? { ...item, text: `${item.text} done` } : item,
      )[0].turns[0]?.items,
    ).toEqual([planItem(), planItem({ id: "item-2", text: "second done" })]);
  });

  it("updates notification-driven item deltas in the target thread turn", () => {
    const fileChange = {
      path: "/workspace/app.ts",
      kind: { type: "add" as const },
      diff: "+hello",
    };
    const threads = [
      thread({
        turns: [
          turn({
            items: [
              commandExecutionItem(),
              fileChangeItem(),
              planItem({ id: "plan-1" }),
              reasoningItem(),
            ],
          }),
        ],
      }),
      thread({ id: "thread-2", turns: [turn({ id: "turn-2" })] }),
    ];

    const withOutput = appendCommandOutputDeltaInThread(
      threads,
      "thread-1",
      "turn-1",
      "command-1",
      "done",
    );
    expect(withOutput[0].turns[0]?.items[0]).toEqual(
      commandExecutionItem({ aggregatedOutput: "done" }),
    );
    expect(
      appendCommandOutputDeltaInThread(
        [
          thread({
            turns: [
              turn({
                items: [commandExecutionItem({ aggregatedOutput: "old" })],
              }),
            ],
          }),
        ],
        "thread-1",
        "turn-1",
        "command-1",
        " new",
      )[0].turns[0]?.items[0],
    ).toEqual(commandExecutionItem({ aggregatedOutput: "old new" }));

    const withFileChanges = updateFileChangeItemChangesInThread(
      threads,
      "thread-1",
      "turn-1",
      "file-1",
      [fileChange],
    );
    expect(withFileChanges[0].turns[0]?.items[1]).toEqual(
      fileChangeItem({ changes: [fileChange] }),
    );

    const withPlanDelta = appendPlanDeltaInThread(
      threads,
      "thread-1",
      "turn-1",
      "plan-1",
      " done",
    );
    expect(withPlanDelta[0].turns[0]?.items[2]).toEqual(
      planItem({ id: "plan-1", text: "first done" }),
    );
    expect(withPlanDelta[1]).toBe(threads[1]);

    const withReasoningSummaryPart = ensureReasoningSummaryPartInThread(
      threads,
      "thread-1",
      "turn-1",
      "reasoning-1",
      1,
    );
    expect(withReasoningSummaryPart[0].turns[0]?.items[3]).toEqual(
      reasoningItem({ summary: ["", ""] }),
    );

    const withReasoningSummaryDelta = appendReasoningSummaryDeltaInThread(
      withReasoningSummaryPart,
      "thread-1",
      "turn-1",
      "reasoning-1",
      1,
      "Planning",
    );
    expect(withReasoningSummaryDelta[0].turns[0]?.items[3]).toEqual(
      reasoningItem({ summary: ["", "Planning"] }),
    );

    const withReasoningContentDelta = appendReasoningContentDeltaInThread(
      withReasoningSummaryDelta,
      "thread-1",
      "turn-1",
      "reasoning-1",
      0,
      "Detailed thought",
    );
    expect(withReasoningContentDelta[0].turns[0]?.items[3]).toEqual(
      reasoningItem({
        summary: ["", "Planning"],
        content: ["Detailed thought"],
      }),
    );
  });

  it("updates thread metadata in a list", () => {
    const threads = [thread(), thread({ id: "thread-2" })];
    const renamed = updateThreadName(threads, "thread-1", "Next title");
    const status = { type: "active" as const, activeFlags: [] };

    expect(renamed).toEqual([
      {
        ...threads[0],
        name: "Next title",
      },
      threads[1],
    ]);
    expect(updateThreadStatus(renamed, "thread-1", status)).toEqual([
      {
        ...renamed[0],
        status,
      },
      threads[1],
    ]);
  });

  it("merges list summaries without dropping loaded turns", () => {
    const loadedThread = thread({
      id: "thread-1",
      preview: "Old preview",
      turns: [turn({ id: "loaded-turn" })],
    });
    const summary = thread({
      id: "thread-1",
      preview: "New preview",
      updatedAt: 2,
      turns: [],
    });
    const fullThread = thread({
      id: "thread-2",
      turns: [turn({ id: "server-turn" })],
    });

    expect(mergeThreadListSummaries([loadedThread], [summary, fullThread])).toEqual([
      {
        ...summary,
        turns: loadedThread.turns,
      },
      fullThread,
    ]);
  });

  it("preserves live tool items when history turns omit command executions", () => {
    const commandItem = {
      id: "item-command",
      type: "commandExecution",
      command: "rg App apps/crewon-ui/src",
      status: "completed",
      aggregatedOutput: "apps/crewon-ui/src/App.tsx",
      durationMs: 120,
      exitCode: 0,
    } as ThreadItem;
    const currentTurns = [
      turn({
        id: "turn-live",
        status: "completed",
        items: [
          {
            id: "item-user",
            type: "userMessage",
            clientId: null,
            content: [{ type: "text", text: "Inspect frontend" }],
          } as ThreadItem,
          commandItem,
          {
            id: "item-agent",
            type: "agentMessage",
            text: "Done.",
            phase: "final_answer",
            memoryCitation: null,
          } as ThreadItem,
        ],
      }),
    ];
    const nextTurns = [
      turn({
        id: "turn-live",
        status: "completed",
        items: [
          currentTurns[0].items[0],
          currentTurns[0].items[2],
        ],
      }),
    ];

    expect(mergeTurnsPreservingActionItems(currentTurns, nextTurns)).toEqual([
      {
        ...nextTurns[0],
        items: [
          currentTurns[0].items[0],
          commandItem,
          currentTurns[0].items[2],
        ],
      },
    ]);
  });

  it("updates thread turns and appends optimistic turns with fallback preview", () => {
    const threads = [
      thread({ preview: "", turns: [] }),
      thread({ id: "thread-2", turns: [turn({ id: "turn-2" })] }),
    ];
    const nextTurn = turn({ id: "turn-3" });

    expect(updateThreadTurns(threads, "thread-2", [nextTurn])).toEqual([
      threads[0],
      {
        ...threads[1],
        turns: [nextTurn],
      },
    ]);
    expect(
      appendTurnWithFallbackPreview(
        threads,
        "thread-1",
        nextTurn,
        "Hello world",
        42,
      ),
    ).toEqual([
      {
        ...threads[0],
        name: "Hello world",
        preview: "Hello world",
        updatedAt: 42,
        turns: [nextTurn],
      },
      threads[1],
    ]);
    expect(
      appendTurnWithFallbackPreview(
        [thread({ name: "Existing", preview: "Existing preview" })],
        "thread-1",
        nextTurn,
        "Ignored",
        42,
      ),
    ).toEqual([
      {
        ...thread({ name: "Existing", preview: "Existing preview" }),
        updatedAt: 42,
        turns: [turn(), nextTurn],
      },
    ]);
  });

  it("reconciles selected thread id after list refreshes and removals", () => {
    const threads = [thread(), thread({ id: "thread-2" })];

    expect(selectedThreadIdAfterThreadList("thread-2", threads)).toBe(
      "thread-2",
    );
    expect(selectedThreadIdAfterThreadList("missing", threads)).toBe(
      "thread-1",
    );
    expect(selectedThreadIdAfterThreadList(null, threads)).toBe("thread-1");
    expect(selectedThreadIdAfterThreadList("missing", [])).toBeNull();
    expect(removeThreadFromList(threads, "thread-1")).toEqual([threads[1]]);
    expect(selectedThreadIdAfterThreadRemoval("thread-1", "thread-1")).toBeNull();
    expect(selectedThreadIdAfterThreadRemoval("thread-2", "thread-1")).toBe(
      "thread-2",
    );
  });
});
