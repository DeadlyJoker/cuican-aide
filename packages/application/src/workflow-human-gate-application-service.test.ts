import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { WorkflowHumanGateApplicationService } from "./workflow-human-gate-application-service.ts";

const actor = { principalId: "principal-1", actorId: "actor-1",
  tenantId: "tenant-1", spaceId: "space-1" };
const binding = { workflowId: "workflow-1", workflowVersionId: "workflow-v1",
  contentDigest: "sha256:workflow" };
const run = { tenantId: "tenant-1", spaceId: "space-1", threadId: "thread-1",
  runId: "run-1", purpose: "workflow", status: "running",
  workflowVersionBinding: binding };
const command = { kind: "workflowHumanGate.decide" as const,
  idempotencyKey: "decision-key-1", runId: "run-1", nodeId: "gate",
  claimId: "claim-1", claimEpoch: 1, gateRequestId: "gate-request-1",
  decision: "approve" as const };
const digester = { sha256: (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` };
const expectedReceiptId = digester.sha256(JSON.stringify({
  tenantId: actor.tenantId, spaceId: actor.spaceId,
  principalId: actor.principalId, actorId: actor.actorId,
  runId: command.runId, nodeId: command.nodeId,
  gateRequestId: command.gateRequestId, idempotencyKey: command.idempotencyKey,
}));

type AuthorizationInput = Readonly<{ action: string; tenantId: string;
  spaceId: string; resource: Readonly<{ threadId: string; runId: string }> }>;
type DecisionInput = Readonly<{ tenantId: string; runId: string;
  binding: typeof binding; nodeId: string; claimId: string; claimEpoch: number;
  gateRequestId: string; decisionReceiptId: string }>;

test("Human Gate decision loads canonical Run and authorizes its resource before mutation", async () => {
  const calls: string[] = [];
  const store = {
    async loadRun(locator: Readonly<{ tenantId: string; runId: string }>) {
      calls.push(`load:${locator.tenantId}:${locator.runId}`);
      return run;
    },
    async recordWorkflowHumanGateDecision(input: DecisionInput) {
      calls.push(`record:${input.decisionReceiptId}`);
      assert.deepEqual(input.binding, binding);
      return { disposition: "recorded" as const,
        approvalResumeWorkItemId: "resume-work-1" };
    },
  };
  const service = new WorkflowHumanGateApplicationService({ store,
    digester, authorization: { async authorize(input: AuthorizationInput) {
      calls.push(`authorize:${input.action}:${input.resource.threadId}:${input.resource.runId}`);
      return { outcome: "allow" as const };
    } } });

  assert.deepEqual(await service.decide(actor, command), {
    disposition: "recorded", runId: "run-1", nodeId: "gate",
    gateRequestId: "gate-request-1", decisionReceiptId: expectedReceiptId,
    resumeWorkItemId: "resume-work-1",
  });
  assert.deepEqual(calls, [
    "load:tenant-1:run-1",
    "authorize:workflowHumanGate.decide:thread-1:run-1",
    `record:${expectedReceiptId}`,
  ]);
});

test("decision and claim drift reuse the stable operation identity and reach Store conflict", async () => {
  const operationIds: string[] = [];
  let canonical: DecisionInput | undefined;
  const store = { loadRun: async () => run,
    async recordWorkflowHumanGateDecision(input: DecisionInput) {
      operationIds.push(input.decisionReceiptId);
      if (canonical === undefined) canonical = input;
      else if (JSON.stringify(input) !== JSON.stringify(canonical))
        throw new Error("workflow_composition_idempotency_conflict");
      return { disposition: "recorded" as const,
        approvalResumeWorkItemId: "resume-work-1" };
    } };
  const service = new WorkflowHumanGateApplicationService({ store, digester,
    authorization: { authorize: async () => ({ outcome: "allow" as const }) } });

  await service.decide(actor, command);
  await assert.rejects(service.decide(actor, { ...command, decision: "reject" }),
    /idempotency_conflict/u);
  await assert.rejects(service.decide(actor, { ...command, claimId: "claim-2",
    claimEpoch: 2 }), /idempotency_conflict/u);
  assert.deepEqual(operationIds, [expectedReceiptId, expectedReceiptId, expectedReceiptId]);
});

test("caller authority fields and unknown command fields fail validation before Store mutation", async () => {
  let mutations = 0;
  const service = new WorkflowHumanGateApplicationService({ digester,
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    store: { loadRun: async () => run,
      async recordWorkflowHumanGateDecision() { mutations += 1;
        throw new Error("must not mutate"); } } });
  for (const extra of [
    { tenantId: "tenant-2" }, { spaceId: "space-2" }, { binding },
    { decisionReceiptId: "forged" }, { failureCode: "forged" }, { unknown: true },
  ]) await assert.rejects(service.decide(actor, { ...command, ...extra }),
    /invalid|command/u);
  assert.equal(mutations, 0);
});

test("canonical Run scope mismatch and authorization denial perform zero decision mutations", async () => {
  let mutations = 0;
  const make = (loadedRun: typeof run, outcome: "allow" | "deny") =>
    new WorkflowHumanGateApplicationService({ digester,
      authorization: { authorize: async () => outcome === "allow"
        ? { outcome: "allow" as const }
        : { outcome: "deny" as const, reasonCode: "forbidden" } },
      store: { loadRun: async () => loadedRun,
        async recordWorkflowHumanGateDecision() { mutations += 1;
          throw new Error("must not mutate"); } } });
  await assert.rejects(make({ ...run, spaceId: "space-2" }, "allow")
    .decide(actor, command), /scope|not_found/u);
  await assert.rejects(make(run, "deny").decide(actor, command), /forbidden/u);
  assert.equal(mutations, 0);
});
