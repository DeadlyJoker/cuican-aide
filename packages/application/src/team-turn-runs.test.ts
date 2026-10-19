import assert from "node:assert/strict";
import test from "node:test";
import type { RunView } from "@crewon/contracts";
import { waitForTerminalRun } from "./team-turn-runs.ts";
import type { ControlTeamRuntimeClient } from "./team-turn-types.ts";

function run(status: RunView["status"]): RunView {
  const now = new Date().toISOString();
  return {
    runId: "run-1",
    threadId: "thread-1",
    status,
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    collaborationMode: "default",
    purpose: "turn",
    workflowVersionBinding: null,
    goalBinding: null,
    outputRef: null,
    failure: null,
    createdAt: now,
    updatedAt: now,
    terminalAt: status === "completed" ? now : null,
  };
}

test("waitForTerminalRun reads once immediately after a queued Run", async () => {
  let reads = 0;
  const client = {
    getRun: async () => {
      reads++;
      return { run: run("completed") };
    },
  } as Pick<ControlTeamRuntimeClient, "getRun">;
  const pending = waitForTerminalRun({
    client,
    run: run("queued"),
    pollIntervalMs: 1_000,
    runDeadlineMs: 5_000,
  });
  assert.equal(reads, 1);
  assert.equal((await pending).status, "completed");
});

test("waitForTerminalRun keeps the polling interval after a nonterminal read", async () => {
  let reads = 0;
  const startedAt = performance.now();
  const client = {
    getRun: async () => {
      reads++;
      return { run: run(reads === 1 ? "running" : "completed") };
    },
  } as Pick<ControlTeamRuntimeClient, "getRun">;
  const pending = waitForTerminalRun({
    client,
    run: run("queued"),
    pollIntervalMs: 20,
    runDeadlineMs: 5_000,
  });
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal((await pending).status, "completed");
  assert.ok(performance.now() - startedAt >= 15);
});

test("waitForTerminalRun accepts a trusted terminal wait and validates its result", async () => {
  let reads = 0;
  let deadlineAt = 0;
  const client = {
    getRun: async () => {
      reads++;
      return { run: run("running") };
    },
  } as Pick<ControlTeamRuntimeClient, "getRun">;
  const terminal = await waitForTerminalRun({
    client,
    run: run("queued"),
    pollIntervalMs: 1_000,
    runDeadlineMs: 5_000,
    waitForRunTerminal: async (input) => {
      deadlineAt = input.deadlineAt;
      return run("completed");
    },
  });
  assert.equal(terminal.status, "completed");
  assert.equal(reads, 0);
  assert.ok(deadlineAt > Date.now());
});

test("waitForTerminalRun rejects a trusted wait that returns another Run", async () => {
  await assert.rejects(
    waitForTerminalRun({
      client: {
        getRun: async () => ({ run: run("running") }),
      },
      run: run("queued"),
      pollIntervalMs: 1,
      runDeadlineMs: 5_000,
      waitForRunTerminal: async () => ({ ...run("completed"), runId: "other" }),
    }),
    /control_team_run_terminal_wait_invalid/u,
  );
});
