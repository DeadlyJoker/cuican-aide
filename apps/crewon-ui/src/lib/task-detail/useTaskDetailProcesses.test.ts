import {
  AppServerRpcError,
  type BackgroundTerminal,
} from "../app-server/appServer";
import { describe, expect, it } from "vitest";

import {
  isTaskDetailProcessPermissionError,
  taskDetailProcessPresentation,
  taskDetailProcessRefreshMs,
  taskDetailProcessStateForThread,
} from "./useTaskDetailProcesses";

function terminal(
  overrides: Partial<BackgroundTerminal> = {},
): BackgroundTerminal {
  return {
    command: "pnpm test",
    cpuPercent: 3.25,
    cwd: "/Users/me/project/apps/ui",
    itemId: "item-1",
    osPid: 42,
    processId: "process-1",
    rssKb: 2_048,
    ...overrides,
  };
}

describe("taskDetailProcessPresentation", () => {
  it("projects a compact process row without exposing its full cwd", () => {
    expect(taskDetailProcessPresentation(terminal())).toEqual({
      command: "pnpm test",
      cpuLabel: "3.3% CPU",
      cwdLabel: "ui",
      id: "process-1",
      memoryLabel: "2.0 MB",
      pidLabel: "PID 42",
    });
  });

  it("keeps only an allowlisted executable and safe subcommand", () => {
    const result = taskDetailProcessPresentation(
      terminal({
        command:
          'API_TOKEN=private-value PASSWORD="another secret" pnpm --token private test --filter @crewon/ui',
        cpuPercent: null,
        osPid: null,
        rssKb: null,
      }),
    );

    expect(result).toEqual({
      command: "pnpm test",
      cpuLabel: null,
      cwdLabel: "ui",
      id: "process-1",
      memoryLabel: null,
      pidLabel: null,
    });
  });

  it("never reflects headers, bearer tokens, URL credentials, or query secrets", () => {
    const curl = taskDetailProcessPresentation(
      terminal({
        command:
          'curl --api-key private --password="secret value" -H "Authorization: Bearer abc.def" "https://user:pass@example.test/run?token=query-secret"',
      }),
    );
    const psql = taskDetailProcessPresentation(
      terminal({ command: "psql postgres://user:pass@host/db" }),
    );
    const unknown = taskDetailProcessPresentation(
      terminal({ command: "private-binary --credential secret" }),
    );

    expect([curl.command, psql.command, unknown.command]).toEqual([
      "curl",
      "psql",
      "process",
    ]);
  });
});

describe("taskDetailProcessStateForThread", () => {
  it("replaces stale process rows and pending ids before a new thread renders", () => {
    const staleState = {
      data: [taskDetailProcessPresentation(terminal())],
      error: null,
      refreshing: false,
      status: "ready" as const,
      terminatingIds: ["process-1"],
      threadId: "thread-a",
    };

    expect(
      taskDetailProcessStateForThread(staleState, "thread-b", "loading"),
    ).toEqual({
      data: [],
      error: null,
      refreshing: false,
      status: "loading",
      terminatingIds: [],
      threadId: "thread-b",
    });
    expect(
      taskDetailProcessStateForThread(staleState, "thread-a", "loading"),
    ).toBe(staleState);
    expect(
      taskDetailProcessStateForThread(
        staleState,
        "thread-a",
        "unavailable",
        false,
      ),
    ).toEqual({
      data: [],
      error: null,
      refreshing: false,
      status: "unavailable",
      terminatingIds: [],
      threadId: "thread-a",
    });
  });
});

describe("taskDetailProcessRefreshMs", () => {
  it("refreshes active processes more frequently than an empty section", () => {
    expect({
      active: taskDetailProcessRefreshMs(1),
      empty: taskDetailProcessRefreshMs(0),
    }).toEqual({ active: 3_000, empty: 10_000 });
  });
});

describe("task detail process permissions", () => {
  it("recognizes permission failures without treating ordinary errors as forbidden", () => {
    expect([
      isTaskDetailProcessPermissionError(new Error("403 Forbidden")),
      isTaskDetailProcessPermissionError(new Error("permission denied")),
      isTaskDetailProcessPermissionError(
        new AppServerRpcError("request failed", 403),
      ),
      isTaskDetailProcessPermissionError(new Error("socket closed")),
    ]).toEqual([true, true, true, false]);
  });
});
