import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  reduceRunLifecycleEvent,
  type WorkflowNodeDefinition,
} from "@crewon/domain";
import { prepareWorkflowChildRun } from "./workflow-child-run-preparation.ts";

const route = {
  authorityId: "authority",
  runtimeGeneration: "ts-v0",
  agentVersionId: "agent",
  policySnapshotId: "policy",
  workspaceBindingId: null,
};
const parent = reduceRunLifecycleEvent(null, {
  schemaVersion: "crewon.run-event.v0",
  identity: { runId: "parent" },
  eventId: "created",
  sequence: 1,
  occurredAt: "2026-09-14T00:00:00.000Z",
  type: "run.created",
  data: {
    ...route,
    tenantId: "tenant",
    spaceId: "space",
    threadId: "thread",
    createdByActorId: "actor",
    collaborationMode: "default",
    goalBinding: null,
  },
});
const schema = {
  type: "object" as const,
  properties: {
    topic: { type: "string" as const, maxLength: 9999, enum: null },
  },
  required: ["topic"],
  additionalProperties: false as const,
};
const node: WorkflowNodeDefinition = {
  kind: "agent",
  nodeId: "node",
  agentVersionId: "agent",
  title: "Node",
  instruction: "Review the input.",
  dependsOn: [],
  inputSchema: schema,
  outputSchema: schema,
};
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

test("workflow child input keeps an identical prefix across clocks, identities and different task data", () => {
  const first = prepare("first", "2026-09-14T00:00:00.000Z", { topic: "one" });
  const replay = prepare("different", "2026-09-15T00:00:00.000Z", {
    topic: "one",
  });
  assert.notEqual(first.childRunId, replay.childRunId);
  assert.deepEqual(
    first.thread.messages.map((m) => m.content),
    replay.thread.messages.map((m) => m.content),
  );
  const changed = prepare("third", "2026-09-16T00:00:00.000Z", {
    topic: "two",
  });
  assert.deepEqual(
    first.thread.messages.slice(0, 2).map((m) => m.content),
    changed.thread.messages.slice(0, 2).map((m) => m.content),
  );
  assert.notEqual(
    first.thread.messages.at(-1)!.content,
    changed.thread.messages.at(-1)!.content,
  );
});

test("workflow child fragments retain Unicode and JSON exactly while staying below 10K bytes", () => {
  const value = { topic: "🙂界".repeat(4000) };
  const result = prepare("unicode", "2026-09-14T00:00:00.000Z", value);
  assert.ok(
    result.thread.messages.every(
      (m) =>
        Buffer.byteLength(m.content) <= 9999 &&
        Buffer.from(m.content, "utf8").toString("utf8") === m.content,
    ),
  );
  assert.equal(
    result.thread.messages
      .slice(2)
      .map((m) => m.content)
      .join(""),
    "Node input:\n" + JSON.stringify(value),
  );
});

test("workflow child aggregate prompt overflow fails before allocating execution identity", () => {
  let ids = 0;
  assert.throws(
    () =>
      prepareWorkflowChildRun({
        parent,
        node: { ...node, instruction: "x".repeat(9999) },
        claimId: "claim",
        value: { parts: Array.from({ length: 8 }, () => "x".repeat(8192)) },
        route,
        now: "2026-09-14T00:00:00.000Z",
        nextId: () => `id-${++ids}`,
        digester,
      }),
    { code: "workflow_child_prompt_limit" },
  );
  assert.equal(ids, 0);
});

function prepare(
  prefix: string,
  now: string,
  value: import("@crewon/contracts").JsonValue,
) {
  let ids = 0;
  return prepareWorkflowChildRun({
    parent,
    node,
    claimId: prefix,
    value,
    route,
    now,
    nextId: () => `${prefix}-${++ids}`,
    digester,
  });
}
