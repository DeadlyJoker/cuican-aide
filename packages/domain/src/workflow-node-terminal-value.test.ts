import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { WorkflowObjectSchema } from "./workflow-schema.ts";
import type { WorkflowSchemaValue } from "./workflow-schema-value.ts";
import {
  createWorkflowNodeTerminalEvidence,
  validateWorkflowDispatchTerminalCorrelation,
  validateWorkflowNodeTerminalEvidence,
} from "./workflow-node-terminal-value.ts";
import { compileWorkflowVersion } from "./workflow-version.ts";

test("canonicalizes object keys and replays as deeply equal frozen evidence", () => {
  const workflow = compile(
    schema({
      alpha: stringSchema(32),
      zeta: stringSchema(32),
    }),
  );
  const evidence = completed(workflow, { zeta: "last", alpha: "first" });

  assert.equal(evidence.canonicalValueJson, '{"alpha":"first","zeta":"last"}');
  assert.deepEqual(
    validateWorkflowNodeTerminalEvidence({
      workflow,
      nodeId: "node",
      evidence: JSON.parse(JSON.stringify(evidence)),
      digester: { sha256 },
    }),
    evidence,
  );
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(evidence.value));
});

test("enforces the 32 KiB canonical value boundary", () => {
  const workflow = compile(
    schema({
      payload: { type: "array", items: stringSchema(9_999), maxItems: 4 },
    }),
  );
  const overhead = JSON.stringify({ payload: ["", "", "", ""] }).length;
  const boundary = [
    "x".repeat(9_999),
    "x".repeat(9_999),
    "x".repeat(9_999),
    "x".repeat(32_768 - overhead - 9_999 * 3),
  ];
  assert.equal(
    completed(workflow, { payload: boundary }).canonicalValueJson.length,
    32_768,
  );
  assert.throws(
    () =>
      completed(workflow, {
        payload: [...boundary.slice(0, 3), `${boundary[3]}x`],
      }),
    invalid,
  );
});

test("rejects schema mismatch, digest tamper and extra persisted fields", () => {
  const workflow = compile(schema({ value: stringSchema(32) }));
  assert.throws(() => completed(workflow, { wrong: "value" } as never), {
    name: "WorkflowVersionError",
    code: "workflow_value_schema_mismatch",
  });
  const evidence = completed(workflow, { value: "ok" });
  assert.throws(
    () =>
      validate(workflow, {
        ...evidence,
        valueRef: {
          ...evidence.valueRef,
          valueDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
    invalid,
  );
  assert.throws(
    () => validate(workflow, { ...evidence, extra: true }),
    invalid,
  );
});

test("binds evidence to the exact node and output schema", () => {
  const workflow = compile(schema({ value: stringSchema(32) }));
  const evidence = completed(workflow, { value: "ok" });
  const sourceEvidence = createWorkflowNodeTerminalEvidence({
    workflow,
    nodeId: "source",
    outcome: { status: "completed", value: { value: "ok" } },
    digester: { sha256 },
  });
  assert.throws(() => validate(workflow, sourceEvidence), invalid);
  const substituted = compile(schema({ value: stringSchema(64) }));
  assert.throws(() => validate(substituted, evidence), invalid);
});

test("represents completed, failed and canceled certainty without possiblySent terminality", () => {
  const workflow = compile(schema({ value: stringSchema(32) }));
  const failed = createWorkflowNodeTerminalEvidence({
    workflow,
    nodeId: "node",
    outcome: {
      status: "failed",
      certainty: "notSent",
      failureCode: "provider_timeout",
    },
    digester: { sha256 },
  });
  const canceled = createWorkflowNodeTerminalEvidence({
    workflow,
    nodeId: "node",
    outcome: { status: "canceled", certainty: "responseObserved" },
    digester: { sha256 },
  });
  assert.deepEqual(validate(workflow, failed), failed);
  assert.deepEqual(validate(workflow, canceled), canceled);
  assert.throws(
    () =>
      createWorkflowNodeTerminalEvidence({
        workflow,
        nodeId: "node",
        outcome: { status: "canceled", certainty: "possiblySent" } as never,
        digester: { sha256 },
      }),
    invalid,
  );
  assert.throws(
    () =>
      createWorkflowNodeTerminalEvidence({
        workflow,
        nodeId: "node",
        outcome: {
          status: "failed",
          certainty: "notSent",
          failureCode: "x".repeat(129),
        },
        digester: { sha256 },
      }),
    invalid,
  );
});

test("correlates exact provider dispatch terminal evidence", () => {
  const workflow = compile(schema({ value: stringSchema(32) }));
  const completedEvidence = completed(workflow, { value: "ok" });
  const failedEvidence = createWorkflowNodeTerminalEvidence({
    workflow,
    nodeId: "node",
    outcome: {
      status: "failed",
      certainty: "notSent",
      failureCode: "provider_timeout",
    },
    digester: { sha256 },
  });
  validateWorkflowDispatchTerminalCorrelation({
    dispatch: { kind: "completed", code: null, certainty: "responseObserved" },
    evidence: completedEvidence,
  });
  validateWorkflowDispatchTerminalCorrelation({
    dispatch: {
      kind: "failed",
      code: "provider_timeout",
      certainty: "notSent",
    },
    evidence: failedEvidence,
  });
  for (const dispatch of [
    { kind: "failed", code: "provider_timeout", certainty: "responseObserved" },
    { kind: "failed", code: "different", certainty: "notSent" },
    { kind: "completed", code: null, certainty: "notSent" },
  ] as const)
    assert.throws(
      () =>
        validateWorkflowDispatchTerminalCorrelation({
          dispatch,
          evidence:
            dispatch.kind === "completed" ? completedEvidence : failedEvidence,
        }),
      invalid,
    );
});

function completed(
  workflow: ReturnType<typeof compile>,
  value: WorkflowSchemaValue,
) {
  const evidence = createWorkflowNodeTerminalEvidence({
    workflow,
    nodeId: "node",
    outcome: { status: "completed", value },
    digester: { sha256 },
  });
  assert.equal(evidence.status, "completed");
  return evidence;
}

function validate(
  workflow: ReturnType<typeof compile>,
  evidence: unknown,
  nodeId = "node",
) {
  return validateWorkflowNodeTerminalEvidence({
    workflow,
    nodeId,
    evidence,
    digester: { sha256 },
  });
}

function compile(outputSchema: WorkflowObjectSchema) {
  return compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: "flow",
      workflowVersionId: "flow-v1",
      name: "Flow",
      description: "Terminal value authority.",
      inputSchema: schema({}),
      outputSchema,
      entryNodeIds: ["source"],
      outputNodeIds: ["node"],
      nodes: [
        {
          nodeId: "source",
          kind: "agent",
          agentVersionId: "agent-v1",
          title: "Source",
          instruction: "Return output.",
          dependsOn: [],
          inputSchema: schema({}),
          outputSchema,
        },
        {
          nodeId: "node",
          kind: "verification",
          verifierAgentVersionId: "verifier-v1",
          title: "Node",
          instruction: "Verify output.",
          dependsOn: ["source"],
          inputSchema: outputSchema,
          outputSchema,
        },
      ],
    },
    { sha256 },
  );
}

function schema(
  properties: WorkflowObjectSchema["properties"],
): WorkflowObjectSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function stringSchema(maxLength: number) {
  return { type: "string" as const, maxLength, enum: null };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const invalid = {
  name: "WorkflowVersionError",
  code: "workflow_node_terminal_evidence_invalid",
};
