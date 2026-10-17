import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  reduceRunLifecycleEvent,
  type WorkflowNodeDefinition,
} from "@crewon/domain";
import {
  prepareWorkflowChildRun,
  prepareWorkflowChildHandoff,
} from "./workflow-child-run-preparation.ts";
import { canonicalJson } from "./canonical-json.ts";
import { RunStoreError } from "./run-store-port.ts";

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

test("ready handoff commits retain exact 0dc48c513 bytes for legacy and contextual preparation", () => {
  const expected = [
    "sha256:edffc571a5911026939f63600094b1c21f5fd883886c35cc9e8055ea8efd44cd",
    "sha256:fba2e250a489c6ca15c724b95b278a6a2c0db3de5d55eed956234533e4df4132",
  ];
  for (const [index, reviewContext] of [
    undefined,
    [{ title: "Review", comment: "  保留\n😀  " }],
  ].entries()) {
    let ids = 0;
    const result = prepareWorkflowChildHandoff({
      parent,
      node,
      claimId: "compat",
      value: { topic: "safe" },
      route,
      now: "2026-09-14T00:00:00.000Z",
      nextId: () => `compat-${++ids}`,
      digester,
      ...(reviewContext ? { reviewContext } : {}),
    });
    assert.equal(digester.sha256(canonicalJson(result)), expected[index]);
  }
});
test("known prompt rejection creates one bounded failed child without model content, execution work or identity loss", () => {
  let ids = 0;
  const input = {
    parent,
    node,
    claimId: "claim",
    value: {
      parts: Array.from({ length: 9 }, () => "private-input-".repeat(1024)),
    },
    route,
    now: "2026-09-14T00:00:00.000Z",
    nextId: () => `reject-${++ids}`,
    digester,
  };
  const rejected = prepareWorkflowChildHandoff(input);
  assert.equal(rejected.run.events[0]!.type, "run.created");
  assert.deepEqual(rejected.run.events[1]!.data, {
    code: "workflow_child_prompt_limit",
    retryable: false,
  });
  assert.equal(rejected.run.events[1]!.type, "run.failed");
  assert.deepEqual(rejected.thread.messages, []);
  assert.deepEqual(rejected.thread.history.items, []);
  assert.deepEqual(rejected.run.workItems, []);
  assert.equal(rejected.run.outbox.length, 2);
  assert.equal(JSON.stringify(rejected).includes("private-input-"), false);
  let changedIds = 0;
  const changed = prepareWorkflowChildHandoff({
    ...input,
    value: {
      parts: Array.from({ length: 9 }, () => "different-input-".repeat(1024)),
    },
    nextId: () => `reject-${++changedIds}`,
  });
  assert.notEqual(
    rejected.run.idempotency.requestFingerprint,
    changed.run.idempotency.requestFingerprint,
  );
  const reviewed = prepareWorkflowChildHandoff({
    ...input,
    value: { topic: "safe" },
    reviewContext: Array.from({ length: 5 }, () => ({
      title: "Review",
      comment: "x".repeat(4096),
    })),
  });
  assert.deepEqual(reviewed.run.events[1]!.data, {
    code: "workflow_review_context_limit",
    retryable: false,
  });
  assert.deepEqual(reviewed.run.workItems, []);
});
test("handoff does not reclassify route failures or ID callback errors as budget rejection", () => {
  let ids = 0;
  const input = {
    parent,
    node,
    claimId: "claim",
    value: { topic: "safe" },
    route,
    now: "2026-09-14T00:00:00.000Z",
    nextId: () => `id-${++ids}`,
    digester,
  };
  assert.throws(
    () =>
      prepareWorkflowChildHandoff({
        ...input,
        route: { ...route, authorityId: "foreign" },
      }),
    { code: "workflow_child_route_mismatch" },
  );
  assert.equal(ids, 0);
  let callbacks = 0;
  assert.throws(
    () =>
      prepareWorkflowChildHandoff({
        ...input,
        nextId() {
          callbacks++;
          throw new RunStoreError("workflow_child_prompt_limit");
        },
      }),
    { code: "workflow_child_prompt_limit" },
  );
  assert.equal(callbacks, 1);
});

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

test("review context is exact bounded task data frozen in initial history and the child receipt fingerprint", () => {
  const comment = "  核对原文\n😀 确认后保留  ";
  let ids = 0;
  const input = {
    parent,
    node,
    claimId: "claim",
    value: { topic: "safe" },
    route,
    now: "2026-09-14T00:00:00.000Z",
    nextId: () => `review-${++ids}`,
    digester,
  };
  const legacy = prepareWorkflowChildRun(input);
  const reviewContext = [
    { title: "审阅", comment },
    { title: "确认", comment: null },
  ];
  const reviewed = prepareWorkflowChildRun({ ...input, reviewContext });
  assert.deepEqual(
    reviewed.thread.messages.slice(0, 2).map((m) => m.content),
    legacy.thread.messages.slice(0, 2).map((m) => m.content),
  );
  assert.equal(
    reviewed.thread.messages.at(-1)!.content,
    legacy.thread.messages.at(-1)!.content,
  );
  const context = reviewed.thread.messages[2]!.content;
  assert.deepEqual(
    JSON.parse(context.slice(context.indexOf("\n") + 1)),
    reviewContext,
  );
  assert.notEqual(
    reviewed.run.idempotency.requestFingerprint,
    legacy.run.idempotency.requestFingerprint,
  );
  assert.deepEqual(
    reviewed.thread.history!.items.map((item) =>
      "content" in item ? item.content : null,
    ),
    reviewed.thread.messages.map((m) => m.content),
  );
  assert.ok(
    reviewed.thread.messages.every((m) => Buffer.byteLength(m.content) <= 9999),
  );
  const before = ids;
  assert.throws(
    () =>
      prepareWorkflowChildRun({
        ...input,
        reviewContext: Array.from({ length: 5 }, () => ({
          title: "Review",
          comment: "x".repeat(4096),
        })),
      }),
    { code: "workflow_review_context_limit" },
  );
  assert.equal(ids, before);
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
