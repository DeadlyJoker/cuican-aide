import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateWorkflowGraph,
  type WorkflowGraphNode,
} from "./workflow-version-graph.ts";

test("derives one stable execution order from the exact DAG boundaries", () => {
  assert.deepEqual(
    validateWorkflowGraph([...graph()].reverse(), ["collect"], ["verify"]),
    ["collect", "analyze", "approval", "verify"],
  );
});

test("rejects cycles, missing dependencies and dishonest boundaries", () => {
  const nodes = graph();
  const replace = (
    nodeId: string,
    update: (node: WorkflowGraphNode) => WorkflowGraphNode,
  ) => nodes.map((node) => (node.nodeId === nodeId ? update(node) : node));
  const invalid: readonly [
    readonly WorkflowGraphNode[],
    readonly string[],
    readonly string[],
    string,
  ][] = [
    [
      replace("collect", (node) => ({ ...node, dependsOn: ["verify"] })),
      ["collect"],
      ["verify"],
      "workflow_graph_cycle",
    ],
    [
      replace("analyze", (node) => ({ ...node, dependsOn: ["missing"] })),
      ["collect"],
      ["verify"],
      "workflow_dependency_not_found",
    ],
    [
      [...nodes, agent("collect", [])],
      ["collect"],
      ["verify"],
      "workflow_node_id_conflict",
    ],
    [
      replace("analyze", (node) => ({
        ...node,
        dependsOn: ["collect", "collect"],
      })),
      ["collect"],
      ["verify"],
      "workflow_dependencies_invalid",
    ],
    [nodes, ["missing"], ["verify"], "workflow_boundary_node_not_found"],
    [nodes, ["analyze"], ["verify"], "workflow_entry_nodes_invalid"],
    [nodes, ["collect"], ["analyze"], "workflow_output_nodes_invalid"],
    [
      [...nodes, agent("discarded", [])],
      ["collect", "discarded"],
      ["verify"],
      "workflow_output_nodes_invalid",
    ],
  ];

  for (const [candidate, entries, outputs, code] of invalid) {
    assert.throws(
      () => validateWorkflowGraph(candidate, entries, outputs),
      hasCode(code),
    );
  }
});

test("requires dependent terminal Verification by an independent AgentVersion", () => {
  const nodes = graph();
  assert.throws(
    () =>
      validateWorkflowGraph(
        nodes.map((node) =>
          node.nodeId === "verify" ? { ...node, dependsOn: [] } : node,
        ),
        ["collect", "verify"],
        ["verify"],
      ),
    hasCode("workflow_verification_dependency_invalid"),
  );
  assert.throws(
    () =>
      validateWorkflowGraph(
        nodes.filter((node) => node.nodeId !== "verify"),
        ["collect"],
        ["analyze", "approval"],
      ),
    hasCode("workflow_output_verification_required"),
  );
  assert.throws(
    () =>
      validateWorkflowGraph(
        nodes.map((node) =>
          node.nodeId === "verify" && node.kind === "verification"
            ? { ...node, verifierAgentVersionId: "agent-analyze-v1" }
            : node,
        ),
        ["collect"],
        ["verify"],
      ),
    hasCode("workflow_verifier_not_independent"),
  );
  const secondVerification: WorkflowGraphNode = {
    nodeId: "verify-again",
    kind: "verification",
    dependsOn: ["verify"],
    verifierAgentVersionId: "agent-verifier-v1",
  };
  assert.throws(
    () =>
      validateWorkflowGraph(
        [...nodes, secondVerification],
        ["collect"],
        ["verify-again"],
      ),
    hasCode("workflow_verifier_not_independent"),
  );
});

function graph(): readonly WorkflowGraphNode[] {
  return [
    agent("collect", []),
    agent("analyze", ["collect"]),
    { nodeId: "approval", kind: "humanGate", dependsOn: ["collect"] },
    {
      nodeId: "verify",
      kind: "verification",
      dependsOn: ["approval", "analyze"],
      verifierAgentVersionId: "agent-verifier-v1",
    },
  ];
}

function agent(
  nodeId: string,
  dependsOn: readonly string[],
): WorkflowGraphNode {
  return {
    nodeId,
    kind: "agent",
    dependsOn,
    agentVersionId: `agent-${nodeId}-v1`,
  };
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}
