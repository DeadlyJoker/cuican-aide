import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import { describe, expect, it } from "vitest";

import type { OfficeConfig } from "../domain/crewonDomain";
import type { OfficeRunTurnRecord } from "./appTurnCompletionNotificationHandler";
import {
  autoDispatchNextOfficeDelegationFromClientAction,
  listThreadTurnsFromClientAction,
  syncOfficeRunFromClientAction,
} from "./appTurnCompletionActions";

function turn(id: string): Turn {
  return {
    id,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
    items: [],
  };
}

function officeConfig(title: string): OfficeConfig {
  return {
    title,
    subtitle: "Office",
    workspace: {
      activity: {
        approvals: [],
        artifacts: [],
        budget: [],
        budgetCapUsd: 8,
        runs: [],
        trace: [],
      },
      backendStatus: "connected",
      goal: "Ship",
      members: [],
      messages: [],
      tasks: [],
    },
  };
}

describe("app turn completion actions", () => {
  it("lists full thread turns through the client", async () => {
    const turns = [turn("turn-1"), turn("turn-2")];

    await expect(
      listThreadTurnsFromClientAction(
        {
          async listThreadTurns(threadId) {
            expect(threadId).toBe("thread-1");
            return turns;
          },
        },
        "thread-1",
      ),
    ).resolves.toBe(turns);
  });

  it("returns null when listing turns without a client", async () => {
    await expect(
      listThreadTurnsFromClientAction(null, "thread-1"),
    ).resolves.toBeNull();
  });

  it("syncs office runs through the backend client adapter", async () => {
    const record: OfficeRunTurnRecord = {
      config: officeConfig("Saved"),
      cwd: "/repo",
      runId: "run-1",
      threadId: "thread-1",
    };
    const completedTurn = turn("turn-1");
    const syncedConfig = officeConfig("Synced");
    const calls: unknown[] = [];

    const result = await syncOfficeRunFromClientAction({
      client: {
        async syncOfficeRunConfig(cwd, config, turnArg, params) {
          calls.push({ config, cwd, params, turn: turnArg });
          return {
            filePath: "/repo/.crewon/office.json",
            config: syncedConfig,
          };
        },
      },
      config: record.config,
      locale: "en",
      record,
      turn: completedTurn,
    });

    expect(result).toBe(syncedConfig);
    expect(calls).toEqual([
      {
        config: record.config,
        cwd: "/repo",
        params: { locale: "en", runId: "run-1" },
        turn: completedTurn,
      },
    ]);
  });

  it("returns null when syncing office runs without a client", async () => {
    await expect(
      syncOfficeRunFromClientAction({
        client: null,
        config: officeConfig("Saved"),
        locale: "zh",
        record: {
          config: officeConfig("Saved"),
          cwd: "/repo",
          runId: "run-1",
          threadId: "thread-1",
        },
        turn: turn("turn-1"),
      }),
    ).resolves.toBeNull();
  });

  it("auto-dispatches the next safe office delegation through the backend client", async () => {
    const record: OfficeRunTurnRecord = {
      config: officeConfig("Saved"),
      cwd: "/repo",
      runId: "run-1",
      threadId: "office-thread-1",
    };
    const calls: unknown[] = [];
    const result = await autoDispatchNextOfficeDelegationFromClientAction({
      client: {
        async dispatchNextOfficeDelegationConfig(cwd, config, runId, params) {
          calls.push({ config, cwd, params, runId });
          return {
            config: officeConfig("Dispatched"),
            delegationId: "delegation-1",
            filePath: "/repo/.crewon/office.json",
            runId,
            threadId: "member-thread-1",
            turn: { id: "turn-member-1", status: "inProgress" } as never,
          };
        },
      },
      config: record.config,
      locale: "en",
      record,
    });

    expect(result).toMatchObject({
      delegationId: "delegation-1",
      threadId: "member-thread-1",
      turn: { id: "turn-member-1" },
    });
    expect(calls).toEqual([
      {
        config: record.config,
        cwd: "/repo",
        params: {
          clientUserMessageId: expect.stringMatching(
            /^office-auto-delegation-/,
          ),
          dispatchPolicy: "auto",
          locale: "en",
        },
        runId: "run-1",
      },
    ]);
  });

  it("returns null when auto-dispatching without a client", async () => {
    await expect(
      autoDispatchNextOfficeDelegationFromClientAction({
        client: null,
        config: officeConfig("Saved"),
        locale: "en",
        record: {
          config: officeConfig("Saved"),
          cwd: "/repo",
          runId: "run-1",
          threadId: "thread-1",
        },
      }),
    ).resolves.toBeNull();
  });
});
