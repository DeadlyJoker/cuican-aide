import { describe, expect, it } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import {
  commandSidebarThreadNeedsAttention,
  commandSidebarThreadScope,
  commandSidebarThreadScopeLabel,
  commandSidebarThreadState,
  commandSidebarThreadStateLabel,
} from "./commandSidebarThreadPresentation";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    agentNickname: null,
    cliVersion: "0.1.0",
    createdAt: 100,
    cwd: "/workspace",
    ephemeral: false,
    gitInfo: null,
    id: "thread-1",
    modelProvider: "openai",
    name: "整理发布说明",
    path: "/tmp/thread-1.jsonl",
    preview: "整理发布说明",
    source: "vscode",
    status: { type: "idle" },
    turns: [],
    updatedAt: 200,
    ...overrides,
  } as Thread;
}

describe("command sidebar thread presentation", () => {
  it("maps runtime and seen state to compact sidebar signals", () => {
    const running = thread({
      status: { activeFlags: [], type: "active" },
    });
    const waiting = thread({
      status: { activeFlags: ["waitingOnUserInput"], type: "active" },
    });
    const completed = thread();

    expect({
      completedUnread: commandSidebarThreadState(completed, 199),
      completedViewed: commandSidebarThreadState(completed, 200),
      failed: commandSidebarThreadState(
        thread({ status: { type: "systemError" } }),
        0,
      ),
      pendingUnread: commandSidebarThreadState(waiting, 199),
      pendingViewed: commandSidebarThreadState(waiting, 200),
      running: commandSidebarThreadState(running, 0),
    }).toEqual({
      completedUnread: "completedUnread",
      completedViewed: "completedViewed",
      failed: "failed",
      pendingUnread: "pendingUnread",
      pendingViewed: "pendingViewed",
      running: "running",
    });
  });

  it("keeps empty drafts neutral instead of presenting them as completed work", () => {
    expect(
      commandSidebarThreadState(
        thread({ name: null, preview: "", turns: [] }),
        0,
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

  it("provides plain-language labels and attention rules", () => {
    expect({
      completedLabel: commandSidebarThreadStateLabel("completedUnread", "zh"),
      completedNeedsAttention:
        commandSidebarThreadNeedsAttention("completedUnread"),
      personalLabel: commandSidebarThreadScopeLabel("personal", "zh"),
      runningNeedsAttention: commandSidebarThreadNeedsAttention("running"),
      teamLabel: commandSidebarThreadScopeLabel("team", "en"),
    }).toEqual({
      completedLabel: "新完成，结果未查看",
      completedNeedsAttention: true,
      personalLabel: "个人任务",
      runningNeedsAttention: false,
      teamLabel: "Team task",
    });
  });
});
