import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunCompositionStore } from "@crewon/application";

import { PostgresWorkflowRunCompositionStore } from "./postgres-workflow-run-composition-store.ts";

test("PostgreSQL composition exposes only the current Workflow contract", () => {
  const implementation: abstract new (
    ...args: never[]
  ) => WorkflowRunCompositionStore = PostgresWorkflowRunCompositionStore;
  assert.equal(implementation, PostgresWorkflowRunCompositionStore);
  assert.equal(
    "admitWorkflowNodes" in PostgresWorkflowRunCompositionStore.prototype,
    false,
  );
  assert.deepEqual(
    [
      "scheduleWorkflowNodes",
      "admitWorkflowNodeWork",
      "settleWorkflowNode",
      "recordWorkflowHumanGateDecision",
      "settleWorkflowHumanGate",
      "scheduleWorkflowReconciliation",
      "reconcileWorkflowNode",
      "cancelWorkflowExecution",
    ].filter(
      (method) =>
        typeof PostgresWorkflowRunCompositionStore.prototype[
          method as keyof PostgresWorkflowRunCompositionStore
        ] !== "function",
    ),
    [],
  );
});
