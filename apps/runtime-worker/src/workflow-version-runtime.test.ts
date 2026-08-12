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
