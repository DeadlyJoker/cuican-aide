import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowHumanGateApplicationService } from "./workflow-human-gate-application-service.ts";

type AuthorizationInput = Readonly<{
  action: string;
  tenantId: string;
  spaceId: string;
}>;
type DecisionStoreInput = Readonly<{
  tenantId: string;
  runId: string;
  decisionReceiptId: string;
}>;

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const command = {
  kind: "workflowHumanGate.decide" as const,
  idempotencyKey: "decision-1",
  runId: "run-1",
  nodeId: "gate",
  gateRequestId: "gate-request-1",
  decision: "approve" as const,
};

test("Workflow Human Gate decision authorizes scope before the receipt-first Store mutation", async () => {
  const calls: string[] = [];
  const service = new WorkflowHumanGateApplicationService({
    authorization: {
      async authorize(input: AuthorizationInput) {
        calls.push(`authorize:${input.action}:${input.tenantId}:${input.spaceId}`);
        return { outcome: "allow" as const };
      },
    },
    store: {
      async recordWorkflowHumanGateDecision(input: DecisionStoreInput) {
        calls.push(`record:${input.tenantId}:${input.runId}:${input.decisionReceiptId}`);
        return {
          disposition: "recorded" as const,
          approvalResumeWorkItemId: "resume-work-1",
        };
      },
    },
    ids: { decisionReceiptId: () => "decision-receipt-1" },
  });

  assert.deepEqual(await service.decide(actor, command), {
    disposition: "recorded",
    runId: "run-1",
    nodeId: "gate",
    gateRequestId: "gate-request-1",
    decisionReceiptId: "decision-receipt-1",
    resumeWorkItemId: "resume-work-1",
  });
  assert.deepEqual(calls, [
    "authorize:workflowHumanGate.decide:tenant-1:space-1",
    "record:tenant-1:run-1:decision-receipt-1",
  ]);
});

test("Workflow Human Gate decision denial and scope mismatch perform zero Store mutations", async () => {
  let mutations = 0;
  const service = new WorkflowHumanGateApplicationService({
    authorization: {
      async authorize() {
        return { outcome: "deny" as const, reasonCode: "forbidden" };
      },
    },
    store: {
      async recordWorkflowHumanGateDecision() {
        mutations += 1;
        throw new Error("must not mutate");
      },
    },
    ids: { decisionReceiptId: () => "decision-receipt-1" },
  });

  await assert.rejects(service.decide(actor, command), /forbidden/u);
  await assert.rejects(
    service.decide(
      actor,
      { ...command, tenantId: "tenant-2", spaceId: "space-2" },
    ),
    /scope|invalid/u,
  );
  assert.equal(mutations, 0);
});

test("Workflow Human Gate exact replay returns one durable resume authority", async () => {
  let mutations = 0;
  const service = new WorkflowHumanGateApplicationService({
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    store: {
      async recordWorkflowHumanGateDecision() {
        mutations += 1;
        return {
          disposition: mutations === 1 ? "recorded" as const : "replay" as const,
          approvalResumeWorkItemId: "resume-work-1",
        };
      },
    },
    ids: { decisionReceiptId: () => "decision-receipt-1" },
  });

  const fresh = await service.decide(actor, command);
  assert.deepEqual(await service.decide(actor, command), {
    ...fresh,
    disposition: "replay",
  });
  assert.equal(mutations, 2);
});
