import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKFLOW_PRODUCTION_STORE_CAPABILITIES,
  selectWorkflowRunStartFactory,
  type WorkflowProductionCompositionCandidate,
  type WorkflowRunStartService,
} from "./workflow-production-composition-gate.ts";

const service: WorkflowRunStartService = {
  async startWorkflowRun() {
    throw new Error("wiring-only fixture");
  },
};

function completeCandidate(): WorkflowProductionCompositionCandidate {
  return {
    backend: "sqlite",
    storeCapabilities: WORKFLOW_PRODUCTION_STORE_CAPABILITIES,
    modelDispatchEvidence: "durable",
    agentRuntime: "WorkflowAgentRuntimeAdapter",
    createWorkflowRunStartService: () => service,
  };
}

test("keeps Workflow production composition disabled without a candidate", () => {
  assert.equal(selectWorkflowRunStartFactory({ status: "disabled" }), null);
});

test("rejects incomplete Store capability certification despite a factory", () => {
  const candidate = completeCandidate();
  assert.equal(
    selectWorkflowRunStartFactory({
      status: "candidate",
      candidate: {
        ...candidate,
        storeCapabilities: candidate.storeCapabilities.filter(
          (capability) => capability !== "reconcile",
        ),
      },
    }),
    null,
  );
});

test("exposes wiring factory only for the complete integrated dependency set", () => {
  const factory = selectWorkflowRunStartFactory({
    status: "candidate",
    candidate: completeCandidate(),
  });
  assert.ok(factory);
  assert.equal(factory(), service);
});
