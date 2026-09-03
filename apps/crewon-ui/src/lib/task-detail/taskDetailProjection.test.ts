import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import { projectTaskDetail } from "./taskDetailProjection";

const EMPTY_AGENT_COUNTS = {
  unknown: 0,
  pendingInit: 0,
  running: 0,
  interrupted: 0,
  completed: 0,
  errored: 0,
  shutdown: 0,
  notFound: 0,
};

function turn(items: ThreadItem[] = [], overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    items,
    itemsView: "full",
    status: "completed",
    startedAt: 150,
    completedAt: 180,
    durationMs: 30_000,
    error: null,
    ...overrides,
  };
}

function thread(turns: Turn[] = [], overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    name: "交付任务详情",
    preview: "交付任务详情",
    cwd: "/workspace",
    modelProvider: "openai",
    gitInfo: null,
    status: { type: "idle" },
    turns,
    createdAt: 100,
    updatedAt: 200,
    agentNickname: null,
    agentRole: null,
    clientVersion: "0.1.0",
    ephemeral: false,
    forkedFromId: null,
    parentThreadId: null,
    path: "/tmp/thread-1.jsonl",
    sessionId: "session-1",
    source: "appServer",
    threadSource: null,
    ...overrides,
  } as Thread;
}

describe("task detail projection", () => {
  it("projects environment and task-event changes without claiming live Git state", () => {
    const fileChange = (
      id: string,
      status: "completed" | "declined",
      path: string,
      diff: string,
    ): ThreadItem => ({
      type: "fileChange",
      id,
      status,
      changes: [{ path, kind: { type: "update", move_path: null }, diff }],
    });
    const value = projectTaskDetail({
      thread: thread(
        [
          turn([
            fileChange(
              "change-1",
              "completed",
              "src/zeta.ts",
              "-old\n+new\n+extra",
            ),
            fileChange("change-2", "completed", "src/alpha.ts", "+alpha"),
          ]),
          turn(
            [fileChange("change-3", "declined", "src/zeta.ts", "-no\n+yes")],
            {
              id: "turn-2",
            },
          ),
        ],
        {
          cwd: "/workspace/crewon",
          gitInfo: {
            branch: "main",
            sha: "abc123",
            originUrl: "https://git.test/crewon.git",
          },
        },
      ),
      linkedThreads: [],
      locale: "zh",
    });

    expect(value).toEqual({
      threadId: "thread-1",
      environment: {
        cwd: "/workspace/crewon",
        workspaceName: "crewon",
        modelProvider: "openai",
        gitSnapshot: {
          basis: "threadCreationSnapshot",
          branch: "main",
          sha: "abc123",
          originUrl: "https://git.test/crewon.git",
        },
      },
      status: {
        phase: "completed",
        label: "已完成",
        basis: "latestTurn",
        activeFlags: [],
        latestTurnId: "turn-2",
        errorMessage: null,
      },
      changes: {
        basis: "threadRecordedChanges",
        complete: true,
        isLiveGitStatus: false,
        eventCount: 3,
        fileCount: 2,
        paths: ["src/alpha.ts", "src/zeta.ts"],
        recordedAdditions: 3,
        recordedDeletions: 1,
        statusCounts: { inProgress: 0, completed: 2, failed: 0, declined: 1 },
      },
      subagents: { total: 0, statusCounts: EMPTY_AGENT_COUNTS, agents: [] },
      sources: { total: 0, truncatedCount: 0, items: [] },
    });
  });

  it("marks task change totals incomplete when any Turn is only partially loaded", () => {
    const value = projectTaskDetail({
      thread: thread([
        turn(
          [
            {
              type: "fileChange",
              id: "partial-change",
              status: "completed",
              changes: [
                {
                  path: "src/partial.ts",
                  kind: { type: "update", move_path: null },
                  diff: "+partial",
                },
              ],
            },
          ],
          { itemsView: "summary" },
        ),
      ]),
      linkedThreads: [],
      locale: "zh",
    });

    expect(value.changes).toMatchObject({
      complete: false,
      fileCount: 1,
      recordedAdditions: 1,
      recordedDeletions: 0,
    });
  });

  it("hides exact totals while a native file mutation is still in progress", () => {
    const pending: ThreadItem = {
      type: "fileChange",
      id: "pending-change",
      status: "inProgress",
      changes: [],
    };
    const completed: ThreadItem = {
      ...pending,
      status: "completed",
      changes: [
        {
          path: "src/task.ts",
          kind: { type: "update", move_path: null },
          diff: "+done",
        },
      ],
    };

    expect(
      projectTaskDetail({
        thread: thread([turn([pending])]),
        linkedThreads: [],
        locale: "zh",
      }).changes.complete,
    ).toBe(false);
    expect(
      projectTaskDetail({
        thread: thread([turn([completed])]),
        linkedThreads: [],
        locale: "zh",
      }).changes,
    ).toMatchObject({
      complete: true,
      fileCount: 1,
      recordedAdditions: 1,
    });
  });

  it("aggregates exact workspace command ledgers without using Tool previews", () => {
    const workspaceCommand = (
      id: string,
      paths: string[],
      additions: number,
      deletions: number,
    ) =>
      ({
        type: "dynamicToolCall",
        id,
        namespace: null,
        tool: "workspace_run_command",
        arguments: { command: "redacted" },
        status: "completed",
        contentItems: [{ type: "inputText", text: "not a diff" }],
        success: true,
        durationMs: 10,
        workspaceChanges: {
          schemaVersion: "crewon.workspace-change-summary.v0",
          paths,
          additions,
          deletions,
          statsComplete: true,
        },
      }) as unknown as ThreadItem;
    const value = projectTaskDetail({
      thread: thread([
        turn([
          workspaceCommand("command-1", ["src/a.ts", "src/shared.ts"], 4, 1),
          workspaceCommand("command-2", ["src/shared.ts"], 2, 3),
        ]),
      ]),
      linkedThreads: [],
      locale: "zh",
    });

    expect(value.changes).toMatchObject({
      complete: true,
      eventCount: 2,
      fileCount: 2,
      paths: ["src/a.ts", "src/shared.ts"],
      recordedAdditions: 6,
      recordedDeletions: 4,
    });
  });

  it("does not treat a custom Tool with the command name as a native mutation", () => {
    const custom = {
      type: "dynamicToolCall",
      id: "custom-command",
      namespace: null,
      tool: "workspace_run_command",
      controlToolKind: "custom",
      arguments: {},
      status: "completed",
      contentItems: null,
      success: true,
      durationMs: 1,
    } as unknown as ThreadItem;

    expect(
      projectTaskDetail({
        thread: thread([turn([custom])]),
        linkedThreads: [],
        locale: "zh",
      }).changes,
    ).toMatchObject({ complete: true, eventCount: 0, fileCount: 0 });
  });

  it("adds the active Run overlay without recounting terminal ledger Runs", () => {
    const command = (
      id: string,
      path: string,
      additions: number,
      deletions: number,
    ) =>
      ({
        type: "dynamicToolCall",
        id,
        namespace: null,
        tool: "workspace_run_command",
        controlToolKind: "function",
        arguments: {},
        status: "completed",
        contentItems: null,
        success: true,
        durationMs: 1,
        workspaceChanges: {
          schemaVersion: "crewon.workspace-change-summary.v0",
          paths: [path],
          additions,
          deletions,
          statsComplete: true,
        },
      }) as unknown as ThreadItem;
    const projected = thread([
      turn(
        [
          command("terminal-call", "src/history.ts", 4, 1),
          {
            type: "fileChange",
            id: "terminal-file-change",
            status: "completed",
            changes: [
              {
                path: "src/history.ts",
                kind: { type: "update", move_path: null },
                diff: "-old\n+new",
              },
            ],
          } as ThreadItem,
        ],
        {
          id: "run-terminal",
          itemsView: "summary",
          taskChangesView: "summary",
        } as Partial<Turn>,
      ),
      turn([command("active-call", "src/live.ts", 2, 3)], {
        id: "run-active",
        status: "inProgress",
        itemsView: "summary",
        taskChangesView: "full",
      } as Partial<Turn>),
    ]) as Thread & { controlTaskChangeLedger: unknown };
    projected.controlTaskChangeLedger = {
      schemaVersion: "crewon.thread-task-change-ledger.v0",
      threadId: "thread-1",
      threadRevision: 3,
      historySequence: 8,
      complete: true,
      summary: {
        schemaVersion: "crewon.workspace-change-summary.v0",
        paths: ["src/history.ts"],
        additions: 4,
        deletions: 1,
        statsComplete: true,
      },
      eventCount: 2,
      includedRunIds: ["run-terminal"],
    };

    expect(
      projectTaskDetail({
        thread: projected,
        linkedThreads: [],
        locale: "zh",
      }).changes,
    ).toMatchObject({
      complete: true,
      eventCount: 2,
      fileCount: 2,
      paths: ["src/history.ts", "src/live.ts"],
      recordedAdditions: 6,
      recordedDeletions: 4,
    });
  });

  it("fails closed when a terminal mutation is absent from a complete ledger", () => {
    const projected = thread([
      turn(
        [
          {
            type: "dynamicToolCall",
            id: "racing-terminal-call",
            namespace: null,
            tool: "workspace_run_command",
            controlToolKind: "function",
            arguments: {},
            status: "completed",
            contentItems: null,
            success: true,
            durationMs: 1,
            workspaceChanges: {
              schemaVersion: "crewon.workspace-change-summary.v0",
              paths: ["src/race.ts"],
              additions: 2,
              deletions: 0,
              statsComplete: true,
            },
          } as unknown as ThreadItem,
        ],
        { id: "run-racing-terminal", status: "failed" },
      ),
    ]) as Thread & { controlTaskChangeLedger: unknown };
    projected.controlTaskChangeLedger = {
      schemaVersion: "crewon.thread-task-change-ledger.v0",
      threadId: "thread-1",
      threadRevision: 3,
      historySequence: 4,
      complete: true,
      summary: {
        schemaVersion: "crewon.workspace-change-summary.v0",
        paths: [],
        additions: 0,
        deletions: 0,
        statsComplete: true,
      },
      eventCount: 0,
      includedRunIds: [],
    };

    expect(
      projectTaskDetail({
        thread: projected,
        linkedThreads: [],
        locale: "zh",
      }).changes,
    ).toMatchObject({ complete: false, eventCount: 0, fileCount: 0 });
  });

  it("fails closed when a terminal Run has no authoritative ledger provenance", () => {
    const projected = thread([
      turn([], {
        id: "run-failed-before-history",
        status: "failed",
        error: {
          message: "provider_unavailable",
          codexErrorInfo: null,
          additionalDetails: null,
        },
        itemsView: "summary",
        taskChangesView: "summary",
      } as Partial<Turn>),
    ]) as Thread & { controlTaskChangeLedger: unknown };
    projected.controlTaskChangeLedger = {
      schemaVersion: "crewon.thread-task-change-ledger.v0",
      threadId: "thread-1",
      threadRevision: 3,
      historySequence: 1,
      complete: true,
      summary: {
        schemaVersion: "crewon.workspace-change-summary.v0",
        paths: [],
        additions: 0,
        deletions: 0,
        statsComplete: true,
      },
      eventCount: 0,
      includedRunIds: [],
    };

    expect(
      projectTaskDetail({
        thread: projected,
        linkedThreads: [],
        locale: "zh",
      }).changes,
    ).toMatchObject({ complete: false, eventCount: 0, fileCount: 0 });
  });

  it("fails closed when the Thread ledger snapshot is incomplete", () => {
    const projected = thread([]) as Thread & {
      controlTaskChangeLedger: unknown;
    };
    projected.controlTaskChangeLedger = {
      schemaVersion: "crewon.thread-task-change-ledger.v0",
      threadId: "thread-1",
      threadRevision: 3,
      historySequence: 8,
      complete: false,
      summary: {
        schemaVersion: "crewon.workspace-change-summary.v0",
        paths: [],
        additions: 0,
        deletions: 0,
        statsComplete: false,
      },
      eventCount: 0,
      includedRunIds: [],
    };

    expect(
      projectTaskDetail({
        thread: projected,
        linkedThreads: [],
        locale: "zh",
      }).changes,
    ).toMatchObject({ complete: false, fileCount: 0 });
  });

  it("fails closed for missing, incomplete, or overflowing workspace command evidence", () => {
    const command = (id: string, workspaceChanges?: Record<string, unknown>) =>
      ({
        type: "dynamicToolCall",
        id,
        namespace: null,
        tool: "workspace_run_command",
        arguments: {},
        status: "completed",
        contentItems: null,
        success: true,
        durationMs: 1,
        ...(workspaceChanges === undefined ? {} : { workspaceChanges }),
      }) as unknown as ThreadItem;
    const exact = (
      additions: number,
      statsComplete = true,
    ): Record<string, unknown> => ({
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: statsComplete ? ["src/task.ts"] : [],
      additions: statsComplete ? additions : 0,
      deletions: 0,
      statsComplete,
    });

    for (const items of [
      [command("missing")],
      [command("incomplete", exact(0, false))],
      [
        command("max", exact(Number.MAX_SAFE_INTEGER)),
        command("overflow", exact(1)),
      ],
    ]) {
      const changes = projectTaskDetail({
        thread: thread([turn(items)]),
        linkedThreads: [],
        locale: "zh",
      }).changes;

      expect(changes.complete).toBe(false);
      if (items.length === 2) {
        expect(changes.recordedAdditions).toBe(0);
        expect(changes.recordedDeletions).toBe(0);
      }
    }
  });

  it("uses deterministic thread-status precedence and localized labels", () => {
    const failed = turn([], {
      id: "failed-turn",
      status: "failed",
      error: {
        message: "disconnected",
        codexErrorInfo: null,
        additionalDetails: null,
      },
    });
    const statuses = [
      thread([], { status: { type: "notLoaded" } }),
      thread([], {
        status: {
          type: "active",
          activeFlags: ["waitingOnUserInput", "waitingOnApproval"],
        },
      }),
      thread([failed]),
      thread([failed], { status: { type: "systemError" } }),
    ].map(
      (value) =>
        projectTaskDetail({
          thread: value,
          linkedThreads: [],
          locale: "en",
        }).status,
    );

    expect(statuses).toEqual([
      {
        phase: "notLoaded",
        label: "Not loaded",
        basis: "threadStatus",
        activeFlags: [],
        latestTurnId: null,
        errorMessage: null,
      },
      {
        phase: "waitingOnApproval",
        label: "Waiting for approval",
        basis: "threadStatus",
        activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
        latestTurnId: null,
        errorMessage: null,
      },
      {
        phase: "failed",
        label: "Failed",
        basis: "latestTurn",
        activeFlags: [],
        latestTurnId: "failed-turn",
        errorMessage: "disconnected",
      },
      {
        phase: "failed",
        label: "Failed",
        basis: "threadStatus",
        activeFlags: [],
        latestTurnId: "failed-turn",
        errorMessage: "disconnected",
      },
    ]);
  });

  it("merges collaboration events and linked direct children in stable order", () => {
    const value = projectTaskDetail({
      thread: thread([
        turn([
          {
            type: "collabAgentToolCall",
            id: "spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "thread-1",
            receiverThreadIds: ["agent-b", "agent-b"],
            prompt: "Investigate",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
            agentsStates: { "agent-b": { status: "running", message: null } },
          },
          {
            type: "subAgentActivity",
            id: "a-start",
            kind: "started",
            agentThreadId: "agent-a",
            agentPath: "/root/agent-a",
          },
          {
            type: "collabAgentToolCall",
            id: "a-done",
            tool: "sendInput",
            status: "completed",
            senderThreadId: "thread-1",
            receiverThreadIds: ["agent-a"],
            prompt: null,
            model: null,
            reasoningEffort: null,
            agentsStates: {
              "agent-a": { status: "completed", message: "Verified" },
            },
          },
          {
            type: "subAgentActivity",
            id: "b-stop",
            kind: "interrupted",
            agentThreadId: "agent-b",
            agentPath: "/root/agent-b",
          },
        ]),
      ]),
      linkedThreads: [
        thread([], {
          id: "agent-a",
          name: "验证成员",
          agentRole: "reviewer",
          parentThreadId: "thread-1",
        }),
        thread([], {
          id: "agent-b",
          name: null,
          agentNickname: "beta",
          parentThreadId: "thread-1",
        }),
        thread([turn()], {
          id: "agent-c",
          name: "补充成员",
          parentThreadId: "thread-1",
          createdAt: 103,
        }),
      ],
      locale: "zh",
    });

    expect(value.subagents).toEqual({
      total: 3,
      statusCounts: { ...EMPTY_AGENT_COUNTS, interrupted: 1, completed: 2 },
      agents: [
        {
          threadId: "agent-b",
          displayName: "beta",
          role: null,
          status: "interrupted",
          lastActivity: "interrupted",
          message: null,
        },
        {
          threadId: "agent-a",
          displayName: "验证成员",
          role: "reviewer",
          status: "completed",
          lastActivity: "started",
          message: "Verified",
        },
        {
          threadId: "agent-c",
          displayName: "补充成员",
          role: null,
          status: "completed",
          lastActivity: null,
          message: null,
        },
      ],
    });
  });

  it("deduplicates all supported source kinds and applies the source limit", () => {
    const userMessage: ThreadItem = {
      type: "userMessage",
      id: "user-1",
      clientId: null,
      content: [
        { type: "image", url: "https://cdn.test/design.png?token=1" },
        { type: "localImage", path: "/tmp/screen.png" },
        { type: "skill", name: "Review", path: "/skills/review" },
        { type: "mention", name: "Brief", path: "/workspace/brief.md" },
        { type: "mention", name: "Duplicate", path: "/workspace/brief.md" },
      ],
    };
    const mcp: ThreadItem = {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "filesystem",
      tool: "read_file",
      status: "completed",
      arguments: {},
      mcpAppResourceUri: "mcp://filesystem/README.md",
      pluginId: null,
      result: null,
      error: null,
      durationMs: 10,
    };
    const task = thread([
      turn([
        userMessage,
        {
          type: "webSearch",
          id: "search-1",
          query: "CrewON protocol",
          action: { type: "openPage", url: "https://docs.test/protocol" },
        },
        mcp,
        { ...userMessage, id: "user-2", content: [userMessage.content[0]!] },
      ]),
    ]);
    const expectedItems = [
      ["image", "design.png", "https://cdn.test/design.png", "user-1"],
      ["localImage", "screen.png", "/tmp/screen.png", "user-1"],
      ["skill", "Review", "/skills/review", "user-1"],
      ["mention", "Brief", "/workspace/brief.md", "user-1"],
      [
        "webSearch",
        "CrewON protocol",
        "https://docs.test/protocol",
        "search-1",
      ],
      [
        "mcpResource",
        "filesystem/read_file",
        "mcp://filesystem/README.md",
        "mcp-1",
      ],
    ].map(([kind, displayName, reference, itemId]) => ({
      kind,
      displayName,
      reference,
      turnId: "turn-1",
      itemId,
    }));
    const sources = (sourceLimit: number) =>
      projectTaskDetail({
        thread: task,
        linkedThreads: [],
        locale: "zh",
        sourceLimit,
      }).sources;

    expect([sources(10), sources(4)]).toEqual([
      { total: 6, truncatedCount: 0, items: expectedItems },
      { total: 6, truncatedCount: 2, items: expectedItems.slice(0, 4) },
    ]);
  });

  it("keeps data URL payloads out of projected source labels and references", () => {
    const value = projectTaskDetail({
      thread: thread([
        turn([
          {
            type: "userMessage",
            id: "data-image",
            clientId: null,
            content: [
              { type: "image", url: "data:image/png;base64,private-payload" },
            ],
          },
        ]),
      ]),
      linkedThreads: [],
      locale: "zh",
    });

    expect(value.sources).toEqual({
      total: 1,
      truncatedCount: 0,
      items: [
        {
          displayName: "图片",
          itemId: "data-image",
          kind: "image",
          reference: "data:image/png",
          turnId: "turn-1",
        },
      ],
    });
  });
});
