import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import {
  commandSidebarThreadEventFingerprint,
  commandSidebarThreadHasUnreadSignal,
  commandSidebarThreadScope,
  commandSidebarThreadScopeLabel,
  commandSidebarThreadState,
  commandSidebarThreadStateLabel,
  commandSidebarViewedThreadId,
  reconcileCommandSidebarSeenThreadEvents,
} from "./commandSidebarThreadPresentation";

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    completedAt: null,
    durationMs: null,
    error: null,
    id: "turn-1",
    items: [],
    itemsView: "full",
    startedAt: 150,
    status: "inProgress",
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    agentNickname: null,
    agentRole: null,
    clientVersion: "0.1.0",
    createdAt: 100,
    cwd: "/workspace",
    ephemeral: false,
    forkedFromId: null,
    gitInfo: null,
    id: "thread-1",
    modelProvider: "openai",
    name: "整理发布说明",
    parentThreadId: null,
    path: "/tmp/thread-1.jsonl",
    preview: "整理发布说明",
    sessionId: "session-1",
    source: "vscode",
    status: { type: "idle" },
    threadSource: null,
    turns: [],
    updatedAt: 200,
    ...overrides,
  } as Thread;
}

function seenFingerprint(value: Thread): string {
  return commandSidebarThreadEventFingerprint(value);
}

describe("command sidebar thread presentation", () => {
  it("shows signals only for unseen completion, interaction, and abnormal stops", () => {
    const running = thread({
      status: { activeFlags: [], type: "active" },
    });
    const waiting = thread({
      status: { activeFlags: ["waitingOnUserInput"], type: "active" },
    });
    const completed = thread({
      turns: [turn({ completedAt: 200, status: "completed" })],
    });
    const failed = thread({
      turns: [turn({ completedAt: 200, status: "failed" })],
    });
    const interrupted = thread({
      turns: [turn({ completedAt: 200, status: "interrupted" })],
    });
    const systemError = thread({ status: { type: "systemError" } });

    expect({
      completedUnread: commandSidebarThreadState(completed, undefined),
      completedViewed: commandSidebarThreadState(
        completed,
        seenFingerprint(completed),
      ),
      failedUnread: commandSidebarThreadState(failed, undefined),
      failedViewed: commandSidebarThreadState(
        failed,
        seenFingerprint(failed),
      ),
      interruptedUnread: commandSidebarThreadState(interrupted, undefined),
      pendingUnread: commandSidebarThreadState(waiting, undefined),
      pendingViewed: commandSidebarThreadState(
        waiting,
        seenFingerprint(waiting),
      ),
      running: commandSidebarThreadState(running, undefined),
      systemErrorUnread: commandSidebarThreadState(systemError, undefined),
      systemErrorViewed: commandSidebarThreadState(
        systemError,
        seenFingerprint(systemError),
      ),
    }).toEqual({
      completedUnread: "completedUnread",
      completedViewed: "completedViewed",
      failedUnread: "failedUnread",
      failedViewed: "failedViewed",
      interruptedUnread: "failedUnread",
      pendingUnread: "pendingUnread",
      pendingViewed: "pendingViewed",
      running: "running",
      systemErrorUnread: "failedUnread",
      systemErrorViewed: "failedViewed",
    });
  });

  it("detects same-second state changes and repeated interaction requests", () => {
    const completed = thread();
    const running = thread({
      status: { activeFlags: [], type: "active" },
    });
    const waiting = thread({
      status: { activeFlags: ["waitingOnApproval"], type: "active" },
    });
    let seenEvents = {
      [completed.id]: seenFingerprint(completed),
    };

    seenEvents = reconcileCommandSidebarSeenThreadEvents(
      seenEvents,
      [running],
      null,
    );
    expect(seenEvents[running.id]).toBe(seenFingerprint(running));

    const waitingUnseen = reconcileCommandSidebarSeenThreadEvents(
      seenEvents,
      [waiting],
      null,
    );
    expect(commandSidebarThreadState(waiting, waitingUnseen[waiting.id])).toBe(
      "pendingUnread",
    );

    const waitingViewed = reconcileCommandSidebarSeenThreadEvents(
      waitingUnseen,
      [waiting],
      waiting.id,
    );
    expect(commandSidebarThreadState(waiting, waitingViewed[waiting.id])).toBe(
      "pendingViewed",
    );

    const runningAgain = reconcileCommandSidebarSeenThreadEvents(
      waitingViewed,
      [running],
      null,
    );
    const waitingAgain = reconcileCommandSidebarSeenThreadEvents(
      runningAgain,
      [waiting],
      null,
    );
    expect(commandSidebarThreadState(waiting, waitingAgain[waiting.id])).toBe(
      "pendingUnread",
    );
  });

  it("marks a task viewed only while its conversation is actually visible", () => {
    expect({
      draft: commandSidebarViewedThreadId({
        activeView: "command",
        hasNewTaskDraft: true,
        selectedThreadId: "thread-1",
      }),
      taskList: commandSidebarViewedThreadId({
        activeView: "projects",
        hasNewTaskDraft: false,
        selectedThreadId: "thread-1",
      }),
      visibleConversation: commandSidebarViewedThreadId({
        activeView: "command",
        hasNewTaskDraft: false,
        selectedThreadId: "thread-1",
      }),
    }).toEqual({
      draft: null,
      taskList: null,
      visibleConversation: "thread-1",
    });
  });

  it("keeps empty drafts and unloaded summaries neutral", () => {
    expect(
      commandSidebarThreadState(
        thread({ name: null, preview: "", turns: [] }),
        undefined,
      ),
    ).toBe("neutral");
    expect(
      commandSidebarThreadState(
        thread({ status: { type: "notLoaded" }, turns: [] }),
        undefined,
      ),
    ).toBe("neutral");
  });

  it("distinguishes personal and team tasks without inventing members", () => {
    expect({
      legacyTeam: commandSidebarThreadScope(
        thread({ name: "CrewON Office Chat · 发布协作" }),
      ),
      personal: commandSidebarThreadScope(thread({ name: "整理发布说明" })),
      team: commandSidebarThreadScope(thread({ name: "💬 发布协作" })),
    }).toEqual({
      legacyTeam: "team",
      personal: "personal",
      team: "team",
    });
  });

  it("provides plain-language labels and unread-signal rules", () => {
    expect({
      completedLabel: commandSidebarThreadStateLabel("completedUnread", "zh"),
      completedUnread: commandSidebarThreadHasUnreadSignal("completedUnread"),
      failedUnread: commandSidebarThreadHasUnreadSignal("failedUnread"),
      failedViewed: commandSidebarThreadHasUnreadSignal("failedViewed"),
      pendingUnread: commandSidebarThreadHasUnreadSignal("pendingUnread"),
      pendingViewed: commandSidebarThreadHasUnreadSignal("pendingViewed"),
      personalLabel: commandSidebarThreadScopeLabel("personal", "zh"),
      running: commandSidebarThreadHasUnreadSignal("running"),
      teamLabel: commandSidebarThreadScopeLabel("team", "en"),
    }).toEqual({
      completedLabel: "新完成，结果未查看",
      completedUnread: true,
      failedUnread: true,
      failedViewed: false,
      pendingUnread: true,
      pendingViewed: false,
      personalLabel: "个人任务",
      running: false,
      teamLabel: "Team task",
    });
  });
});
