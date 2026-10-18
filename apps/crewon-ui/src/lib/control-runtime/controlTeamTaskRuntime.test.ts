import { describe, expect, it, vi } from "vitest";
import type { MessageView, RunEventView, RunView } from "@crewon/contracts";
import { startControlTeamTask } from "./controlTeamTaskRuntime";

const occurredAt = "2026-10-19T00:00:00.000Z";
const message: MessageView = {
  messageId: "message-1",
  threadId: "thread-1",
  sequence: 4,
  role: "user",
  content: "verify the release",
  proposedPlan: null,
  createdAt: occurredAt,
};
const run: RunView = {
  runId: "run-final",
  threadId: "thread-1",
  status: "completed",
  revision: 3,
  lastSequence: 3,
  cancelRequested: false,
  waitingApproval: null,
  collaborationMode: "default",
  purpose: "turn",
  workflowVersionBinding: null,
  goalBinding: null,
  outputRef: "run-final-output",
  failure: null,
  createdAt: occurredAt,
  updatedAt: occurredAt,
  terminalAt: occurredAt,
};
const plan = {
  officeVersionId: "office-1",
  officeTitle: "Release team",
  manager: {
    memberId: "manager",
    displayName: "Lead",
    agentVersionId: "agent-1",
    targetId: "target-manager",
  },
  workers: [
    {
      memberId: "worker",
      displayName: "QA",
      agentVersionId: "agent-2",
      targetId: "target-worker",
    },
  ],
} as const;

describe("durable Team task runtime", () => {
  it("replays admission snapshots and consumes only the final Run SSE", async () => {
    const snapshots = [
      {
        schemaVersion: "crewon.team-task-snapshot.v1" as const,
        task: {
          taskId: "task-1",
          threadId: "thread-1",
          status: "coordinating" as const,
          revision: 2,
          cancelRequested: false,
          mainMessageSequence: 4,
          resultRunId: null,
        },
      },
      {
        schemaVersion: "crewon.team-task-snapshot.v1" as const,
        task: {
          taskId: "task-1",
          threadId: "thread-1",
          status: "finalAccepted" as const,
          revision: 9,
          cancelRequested: false,
          mainMessageSequence: 4,
          resultRunId: "run-final",
        },
      },
    ];
    const events: RunEventView[] = [];
    const client = {
      admitTeamTask: vi.fn(async () => ({
        schemaVersion: "crewon.team-task-admission.v1" as const,
        disposition: "committed" as const,
        task: snapshots[0]!.task,
      })),
      getTeamTask: vi.fn(async () => snapshots.shift()!),
      getThread: vi.fn(async () => ({
        thread: { threadId: "thread-1" },
        eventSequence: 0,
      })),
      listThreadMessages: vi.fn(async () => ({
        data: [message],
        nextCursor: null,
      })),
      getRun: vi.fn(async () => ({ run })),
      openRunEventStream: vi.fn(),
    };
    const result = await startControlTeamTask({
      client,
      threadId: "thread-1",
      expectedRevision: 3,
      content: message.content,
      plan,
      idempotencyKey: (operation) => `client:${operation}`,
      responseMode: "manager",
      eventStream: async function* () {
        const event = {
          type: "run.completed",
          runId: "run-final",
          sequence: 3,
        } as RunEventView;
        events.push(event);
        yield event;
      },
    });
    expect(result).toEqual({ message, run });
    expect(client.admitTeamTask).toHaveBeenCalledOnce();
    expect(client.getTeamTask).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
  });

  it("stops waiting when the durable task has been canceled", async () => {
    const client = {
      admitTeamTask: vi.fn(async () => ({
        schemaVersion: "crewon.team-task-admission.v1" as const,
        disposition: "committed" as const,
        task: {
          taskId: "task-canceled",
          threadId: "thread-1",
          status: "coordinating" as const,
          revision: 2,
          cancelRequested: false,
          mainMessageSequence: 4,
        },
      })),
      getTeamTask: vi.fn(async () => ({
        schemaVersion: "crewon.team-task-snapshot.v1" as const,
        task: {
          taskId: "task-canceled",
          threadId: "thread-1",
          status: "coordinating" as const,
          revision: 3,
          cancelRequested: true,
          mainMessageSequence: 4,
          resultRunId: null,
        },
      })),
      listThreadMessages: vi.fn(async () => ({
        data: [message],
        nextCursor: null,
      })),
      getRun: vi.fn(),
      openRunEventStream: vi.fn(),
    };

    await expect(
      startControlTeamTask({
        client,
        threadId: "thread-1",
        expectedRevision: 3,
        content: message.content,
        plan,
        idempotencyKey: (operation) => `client:${operation}`,
        responseMode: "manager",
        pollDelayMs: 20,
      }),
    ).rejects.toThrow("control_team_task_cancel_requested");
    expect(client.getTeamTask).toHaveBeenCalledOnce();
    expect(client.getRun).not.toHaveBeenCalled();
  });

  it("bounds a task that remains coordinating after its deadline", async () => {
    const client = {
      admitTeamTask: vi.fn(async () => ({
        schemaVersion: "crewon.team-task-admission.v1" as const,
        disposition: "committed" as const,
        task: {
          taskId: "task-stalled",
          threadId: "thread-1",
          status: "coordinating" as const,
          revision: 2,
          cancelRequested: false,
          mainMessageSequence: 4,
        },
      })),
      getTeamTask: vi.fn(async () => ({
        schemaVersion: "crewon.team-task-snapshot.v1" as const,
        task: {
          taskId: "task-stalled",
          threadId: "thread-1",
          status: "coordinating" as const,
          revision: 3,
          cancelRequested: false,
          mainMessageSequence: 4,
          resultRunId: null,
        },
      })),
      listThreadMessages: vi.fn(async () => ({
        data: [message],
        nextCursor: null,
      })),
      getRun: vi.fn(),
      openRunEventStream: vi.fn(),
    };

    await expect(
      startControlTeamTask({
        client,
        threadId: "thread-1",
        expectedRevision: 3,
        content: message.content,
        plan,
        idempotencyKey: (operation) => `client:${operation}`,
        responseMode: "manager",
        pollDelayMs: 20,
        taskDeadlineMs: 1,
      }),
    ).rejects.toThrow("control_team_task_deadline_exceeded");
    expect(client.getRun).not.toHaveBeenCalled();
  });
});
