import assert from "node:assert/strict";
import test from "node:test";
import type { ActorContext } from "./authorization-port.ts";
import { ApplicationError } from "./application-error.ts";
import {
  TeamTaskAdmissionApplicationService,
  type AdmitTeamTaskCommand,
} from "./team-task-admission-application-service.ts";
import type {
  TeamTaskAdmissionResult,
  TeamTaskIntent,
  TeamTaskJournalStore,
  TeamTaskRecord,
} from "./team-task-journal.ts";

const actor: ActorContext = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
};

const command: AdmitTeamTaskCommand = {
  kind: "teamTask.admit",
  taskId: "task-1",
  threadId: "thread-1",
  expectedRevision: 4,
  content: "verify the release",
  plan: {
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
  },
  responseMode: "manager",
  managerResponseKind: "office",
};

function preparedThread() {
  return {
    tenantId: actor.tenantId,
    expectedRevision: command.expectedRevision,
    idempotency: {
      scope: "thread-command",
      key: "team-task:task-1:main-message",
      requestFingerprint: "fingerprint",
    },
    events: [],
    messages: [
      {
        messageId: "message-1",
        tenantId: actor.tenantId,
        threadId: command.threadId,
        sequence: 7,
        role: "user" as const,
        content: command.content,
        contentDigest: `sha256:${"a".repeat(64)}`,
        createdAt: "2026-10-19T00:00:00Z",
        origin: null,
        proposedPlan: null,
      },
    ],
    history: { expectedLastSequence: 6, items: [{ sequence: 7 }] },
  } as never;
}

function record(intent: TeamTaskIntent): TeamTaskRecord {
  return {
    intent,
    status: "coordinating",
    revision: 1,
    cancelRequested: false,
    lease: null,
    result: null,
    effectCount: 0,
    journalBytes: 1,
  };
}

function journal(input: {
  prior?: TeamTaskRecord | null;
  admitted?: (value: {
    intent: TeamTaskIntent;
    thread: unknown;
  }) => Promise<TeamTaskAdmissionResult>;
}) {
  let reads = 0;
  const value = {
    reads: () => reads,
    async read() {
      reads += 1;
      return input.prior ?? null;
    },
    admit:
      input.admitted ??
      (async ({ intent }) => ({
        disposition: "committed" as const,
        task: record(intent),
        thread: null,
      })),
  } as unknown as TeamTaskJournalStore;
  return value;
}

function service(
  store: TeamTaskJournalStore,
  prepared = preparedThread(),
  calls: { prepare: number } = { prepare: 0 },
) {
  const threads = {
    async prepareAppendMessage() {
      calls.prepare += 1;
      return prepared;
    },
  };
  return {
    service: new TeamTaskAdmissionApplicationService({
      threads: threads as never,
      journal: store,
    }),
    calls,
  };
}

test("prepares the main message sequence before atomic Team admission", async () => {
  let admitted: { intent: TeamTaskIntent } | undefined;
  const store = journal({
    admitted: async (input) => {
      admitted = { intent: input.intent };
      return {
        disposition: "committed",
        task: record(input.intent),
        thread: null,
      };
    },
  });
  const { service: application } = service(store);
  await application.admit(actor, command);
  assert.equal(admitted?.intent.mainMessageSequence, 7);
  assert.equal(admitted?.intent.actorId, actor.actorId);
  assert.equal(admitted?.intent.turn.content, command.content);
});

test("replays a matching durable Team admission without rereading the stale Thread revision", async () => {
  const prior = record({
    schemaVersion: "crewon.team-task.v1",
    ...actor,
    taskId: command.taskId,
    mainMessageSequence: 7,
    turn: {
      threadId: command.threadId,
      expectedRevision: command.expectedRevision,
      content: command.content,
      plan: command.plan,
      responseMode: "manager",
      managerResponseKind: "office",
    },
  });
  const store = journal({ prior });
  const { service: application, calls } = service(store);
  const result = await application.admit(actor, command);
  assert.equal(result.disposition, "replayed");
  assert.equal(result.task.intent.taskId, command.taskId);
  assert.equal(calls.prepare, 0);
});

test("rejects a reused Team task id with changed input", async () => {
  const prior = record({
    schemaVersion: "crewon.team-task.v1",
    ...actor,
    taskId: command.taskId,
    mainMessageSequence: 7,
    turn: {
      threadId: command.threadId,
      expectedRevision: command.expectedRevision,
      content: "different input",
      plan: command.plan,
      responseMode: "manager",
      managerResponseKind: "office",
    },
  });
  const { service: application } = service(journal({ prior }));
  await assert.rejects(
    application.admit(actor, command),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "conflict" &&
      error.code === "team_task_intent_conflict",
  );
});
