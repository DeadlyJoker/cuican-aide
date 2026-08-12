import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  compileWorkflowVersion,
  type WorkflowVersionSource,
} from "@crewon/domain";
import { readyWorkflowNodes } from "./workflow-version-runtime.ts";

const schema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const common = (nodeId: string, dependsOn: string[]) => ({
  nodeId,
  title: nodeId,
  instruction: nodeId,
  dependsOn,
  inputSchema: schema,
  outputSchema: schema,
});
const source: WorkflowVersionSource = {
  schemaVersion: "crewon.workflow-version-source.v0",
  workflowId: "workflow",
  workflowVersionId: "version",
  name: "workflow",
  description: "workflow",
  inputSchema: schema,
  outputSchema: schema,
  entryNodeIds: ["agent"],
  outputNodeIds: ["verify"],
  nodes: [
    { ...common("agent", []), kind: "agent", agentVersionId: "agent-1" },
    {
      ...common("gate", ["agent"]),
      kind: "humanGate",
      approvalPolicyId: "approval-1",
    },
    {
      ...common("verify", ["gate"]),
      kind: "verification",
      verifierAgentVersionId: "agent-2",
    },
  ],
};
const workflow = compileWorkflowVersion(source, {
  sha256: (value) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
});

test("schedules agent, then durable human gate, then independent verification", () => {
  assert.deepEqual(
    readyWorkflowNodes(workflow, []).map((node) => node.kind),
    ["agent"],
  );
  assert.deepEqual(
    readyWorkflowNodes(workflow, [
      { nodeId: "agent", status: "completed" },
    ]).map((node) => node.kind),
    ["humanGate"],
  );
  assert.deepEqual(
    readyWorkflowNodes(workflow, [
      { nodeId: "agent", status: "completed" },
      { nodeId: "gate", status: "completed" },
    ]).map((node) => node.kind),
    ["verification"],
  );
});

test("rejects forged or non-canonical settlement histories", () => {
  for (const settlements of [
    [{ nodeId: "missing", status: "completed" }],
    [
      { nodeId: "agent", status: "completed" },
      { nodeId: "agent", status: "completed" },
    ],
    [{ nodeId: "gate", status: "completed" }],
    [{ nodeId: "verify", status: "completed" }],
    [
      { nodeId: "agent", status: "failed" },
      { nodeId: "gate", status: "completed" },
    ],
  ] as const)
    assert.throws(
      () => readyWorkflowNodes(workflow, settlements),
      /workflow_node_settlement_invalid/,
    );
});

test("accepts either ready branch while keeping ready output stable", () => {
  const branch = compileWorkflowVersion(
    {
      ...source,
      workflowVersionId: "branch-version",
      entryNodeIds: ["A"],
      outputNodeIds: ["join"],
      nodes: [
        { ...common("A", []), kind: "agent", agentVersionId: "agent-a" },
        { ...common("B", ["A"]), kind: "agent", agentVersionId: "agent-b" },
        { ...common("C", ["A"]), kind: "agent", agentVersionId: "agent-c" },
        {
          ...common("join", ["B", "C"]),
          inputSchema: {
            type: "object",
            properties: { B: schema, C: schema },
            required: ["B", "C"],
            additionalProperties: false,
          },
          kind: "verification",
          verifierAgentVersionId: "agent-verifier",
        },
      ],
    },
    {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
  );
  assert.deepEqual(
    readyWorkflowNodes(branch, [{ nodeId: "A", status: "completed" }]).map(
      (node) => node.nodeId,
    ),
    ["B", "C"],
  );
  assert.deepEqual(
    readyWorkflowNodes(branch, [
      { nodeId: "A", status: "completed" },
      { nodeId: "C", status: "completed" },
    ]).map((node) => node.nodeId),
    ["B"],
  );
  assert.deepEqual(
    readyWorkflowNodes(branch, [
      { nodeId: "A", status: "completed" },
      { nodeId: "C", status: "completed" },
      { nodeId: "B", status: "completed" },
    ]).map((node) => node.nodeId),
    ["join"],
  );
});
