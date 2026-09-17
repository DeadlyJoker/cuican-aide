import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowHumanGateApplicationService } from "./workflow-human-gate-service.ts";
import { RunStoreError } from "./run-store-port.ts";
import type { WorkflowHumanGateStore } from "./workflow-human-gate-port.ts";

const actor = {
  tenantId: "tenant",
  spaceId: "space",
  actorId: "actor",
  principalId: "principal",
};
const command = {
  kind: "workflowHumanGate.decide" as const,
  runId: "run",
  nodeId: "gate",
  gateRequestId: "request",
  inputDigest: `sha256:${"a".repeat(64)}`,
  decision: "approved" as const,
};

test("human gate commands validate identity, digest, decision and unexpected output before Store access", async () => {
  let calls = 0;
  const store: WorkflowHumanGateStore = {
    async loadWorkflowHumanGate() {
      calls++;
      throw Error("not expected");
    },
    async decideWorkflowHumanGate() {
      calls++;
      throw Error("not expected");
    },
  };
  const service = new WorkflowHumanGateApplicationService(store);
  for (const value of [
    { ...command, inputDigest: "bad" },
    { ...command, decision: "yes" },
    { ...command, gateRequestId: "" },
    { ...command, output: { topic: "changed" } },
  ])
    await assert.rejects(service.decideGate(actor, value as any), {
      category: "validation",
    });
  await assert.rejects(
    service.getGate({ ...actor, principalId: "x".repeat(513) }, command),
    { category: "validation" },
  );
  assert.equal(calls, 0);
});
for (const [code, category] of [
  ["workflow_gate_authorization_denied", "authorization"],
  ["workflow_gate_not_found", "notFound"],
  ["workflow_gate_input_conflict", "conflict"],
  ["workflow_gate_not_decidable", "conflict"],
  ["workflow_gate_schema_corrupt", "internal"],
])
  test(`human gate application preserves the ${code} boundary`, async () => {
    const service = new WorkflowHumanGateApplicationService({
      async loadWorkflowHumanGate() {
        throw new RunStoreError(code!);
      },
      async decideWorkflowHumanGate() {
        throw new RunStoreError(code!);
      },
    });
    await assert.rejects(service.getGate(actor, command), { code, category });
    await assert.rejects(service.decideGate(actor, command), {
      code,
      category,
    });
  });
