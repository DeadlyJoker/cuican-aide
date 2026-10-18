import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTeamTaskCancelRequest,
  parseTeamTaskAdmissionRequest,
  parseTeamTaskAdmissionResponse,
  parseTeamTaskSnapshotResponse,
} from "./team-task-control-contract.ts";

function request() {
  return {
    threadId: "thread-1",
    expectedRevision: 3,
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
  } as const;
}

test("parses bounded Team admission input with omitted optional fields", () => {
  const parsed = parseTeamTaskAdmissionRequest(request());
  assert.equal(parsed.threadId, "thread-1");
  assert.equal(parsed.managerResponseKind, "office");
  assert.equal(parsed.plan.workers.length, 1);
});

test("rejects a member request carrying manager-only response fields", () => {
  assert.throws(() =>
    parseTeamTaskAdmissionRequest({
      ...request(),
      responseMode: "member",
      managerResponseKind: "office",
    }),
  );
});

test("copies data properties and rejects accessors before validation", () => {
  const value = request() as Record<string, unknown>;
  Object.defineProperty(value, "content", {
    enumerable: true,
    get() {
      throw new Error("getter must not run");
    },
  });
  assert.throws(() => parseTeamTaskAdmissionRequest(value));
});

test("parses the bounded admission response", () => {
  const response = parseTeamTaskAdmissionResponse({
    schemaVersion: "crewon.team-task-admission.v1",
    disposition: "committed",
    task: {
      taskId: "task-1",
      threadId: "thread-1",
      status: "coordinating",
      revision: 3,
      cancelRequested: false,
      mainMessageSequence: 4,
    },
  });
  assert.equal(response.task.mainMessageSequence, 4);
});

test("parses task snapshots and requires an empty cancel body", () => {
  const snapshot = parseTeamTaskSnapshotResponse({
    schemaVersion: "crewon.team-task-snapshot.v1",
    task: {
      taskId: "task-1",
      threadId: "thread-1",
      status: "coordinating",
      revision: 4,
      cancelRequested: true,
      mainMessageSequence: null,
      resultRunId: null,
    },
  });
  assert.equal(snapshot.task.mainMessageSequence, null);
  assert.deepEqual(parseTeamTaskCancelRequest({}), {});
  assert.throws(() => parseTeamTaskCancelRequest({ reason: "x" }));
});
