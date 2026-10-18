import { expect, it, vi } from "vitest";
import type {
  ActiveAgentVersionCatalogResponse,
  MessageView,
  RunEventView,
  RunView,
  ThreadView,
} from "@crewon/contracts";
import { ControlApiClient } from "@crewon/control-client";
import { ControlThreadRuntime } from "./controlThreadRuntime";

const occurredAt = "2026-10-19T00:00:00.000Z";
const thread: ThreadView = {
  threadId: "thread-1",
  title: "Control thread",
  status: "active",
  revision: 1,
  lastMessageSequence: 0,
  forkedFromThreadId: null,
  forkedThroughHistorySequence: null,
  createdAt: occurredAt,
  updatedAt: occurredAt,
  archivedAt: null,
  deletedAt: null,
};
const office = {
  schemaVersion: "crewon.office-definition.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  officeId: "office-1",
  officeVersionId: "office-version-1",
  revision: 1,
  title: "Delivery Office",
  members: [
    {
      memberId: "manager",
      displayName: "Manager",
      agentVersionId: "agent-1",
    },
    {
      memberId: "reviewer",
      displayName: "Reviewer",
      agentVersionId: "agent-2",
    },
  ],
  executionTargets: [
    { targetId: "target-manager", agentVersionId: "agent-1" },
    { targetId: "target-reviewer", agentVersionId: "agent-2" },
  ],
  createdByActorId: "actor-1",
  createdAt: occurredAt,
};
const catalog: ActiveAgentVersionCatalogResponse = {
  releaseId: `sha256:${"a".repeat(64)}`,
  activatedAt: occurredAt,
  defaultAgentVersionId: "agent-1",
  data: office.members.map((member, index) => ({
    agentVersionId: member.agentVersionId,
    contentDigest: `sha256:${String(index + 1).repeat(64)}`,
    runtimeGeneration: "ts-v0",
    policySnapshotId: `policy-${index + 1}`,
    model: {
      adapterName: "responses-http",
      adapterVersion: "1",
      modelId: `model-${index + 1}`,
    },
    createdAt: occurredAt,
  })),
};
const message: MessageView = {
  messageId: "message-1",
  threadId: "thread-1",
  sequence: 1,
  role: "user",
  content: "Prepare the launch checklist",
  proposedPlan: null,
  createdAt: occurredAt,
};
const run: RunView = {
  runId: "run-final",
  threadId: "thread-1",
  status: "running",
  revision: 2,
  lastSequence: 2,
  cancelRequested: false,
  waitingApproval: null,
  collaborationMode: "default",
  purpose: "turn",
  workflowVersionBinding: null,
  goalBinding: null,
  outputRef: null,
  failure: null,
  createdAt: occurredAt,
  updatedAt: occurredAt,
  terminalAt: null,
};

it("runs the durable Team path behind an explicit runtime gate", async () => {
  const client = Object.assign(
    new ControlApiClient({
      baseUrl: "http://127.0.0.1:3210",
      fetch: async () => {
        throw new Error("unexpected network request");
      },
    }),
    {
      getThread: vi.fn(async () => ({ thread, eventSequence: 1 })),
      getActiveAgentVersionCatalog: vi.fn(async () => catalog),
      getThreadGoal: vi.fn(async () => ({ goal: null, eventSequence: 1 })),
      getOffice: vi.fn(async () => ({ office })),
      listOffices: vi.fn(async () => ({ data: [office], nextCursor: null })),
      authorizeOfficeRun: vi.fn(
        async (_officeVersionId: string, body: { targetId: string }) => ({
          target: office.executionTargets.find(
            (target) => target.targetId === body.targetId,
          )!,
        }),
      ),
      admitTeamTask: vi.fn(async () => ({
        schemaVersion: "crewon.team-task-admission.v1" as const,
        disposition: "committed" as const,
        task: {
          taskId: "task-1",
          threadId: "thread-1",
          status: "coordinating" as const,
          revision: 2,
          cancelRequested: false,
          mainMessageSequence: 1,
        },
      })),
      getTeamTask: vi.fn(async () => ({
        schemaVersion: "crewon.team-task-snapshot.v1" as const,
        task: {
          taskId: "task-1",
          threadId: "thread-1",
          status: "finalAccepted" as const,
          revision: 9,
          cancelRequested: false,
          mainMessageSequence: 1,
          resultRunId: "run-final",
        },
      })),
      listThreadMessages: vi.fn(async () => ({
        data: [message],
        nextCursor: null,
      })),
      getRun: vi.fn(async () => ({ run })),
    },
  );
  const onTurnStarted = vi.fn();
  const forkThread = vi.spyOn(client, "forkThread");
  const createRun = vi.spyOn(client, "createRun");
  const startTurn = vi.spyOn(client, "startTurn");
  const runtime = new ControlThreadRuntime(
    {
      client,
      teamExecutionMode: "durableTask",
      eventStream: async function* () {
        yield {
          eventId: "run-final-completed",
          runId: "run-final",
          sequence: 3,
          occurredAt,
          type: "run.completed",
          data: { outputRef: null },
        } as RunEventView;
      },
    },
    {
      onThread() {},
      onTextDelta() {},
      onToolItem() {},
      onRunSettled() {},
      onStreamError() {},
      onTurnStarted,
    },
  );

  await runtime.startTurn("thread-1", message.content, [], {
    scene: {
      sceneId: "office",
      mode: "coordinate",
      executionTarget: { kind: "team", id: office.officeVersionId },
    },
  });

  expect(client.admitTeamTask).toHaveBeenCalledOnce();
  expect(onTurnStarted).toHaveBeenCalledOnce();
  expect(forkThread).not.toHaveBeenCalled();
  expect(createRun).not.toHaveBeenCalled();
  expect(startTurn).not.toHaveBeenCalled();
  runtime.close();
});
