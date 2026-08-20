import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkflowHumanGatePublicationStore,
  WorkflowRunAdmissionStore,
  WorkflowRunCompositionStore,
  WorkflowRuntimeStore,
} from "@crewon/application";

import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { PostgresWorkflowRunCompositionStore } from "./postgres-workflow-run-composition-store.ts";

type PostgresWorkflowAuthority = WorkflowRuntimeStore &
  WorkflowHumanGatePublicationStore;

const postgresWorkflowAuthorityMethods = [
  "publishWorkflowHumanGate",
  "listPublishedWorkflowHumanGates",
  "loadWorkflowExecution",
  "commitWorkflowRunStart",
  "scheduleWorkflowNodes",
  "admitWorkflowNodeWork",
  "settleWorkflowNode",
  "recordWorkflowHumanGateDecision",
  "settleWorkflowHumanGate",
  "scheduleWorkflowReconciliation",
  "reconcileWorkflowNode",
  "settleRetrievedWorkflowNode",
  "commitRetrievedWorkflowNodeContinuation",
  "cancelWorkflowExecution",
  "loadModelDispatchReceipt",
  "prepareModelDispatch",
  "markModelDispatchPossiblySent",
  "observeModelDispatchResponse",
  "terminateModelDispatch",
  "loadWorkflowNodeContinuation",
  "commitWorkflowToolContinuation",
  "commitWorkflowAssistantContinuation",
  "settlePreparedWorkflowNodeTerminal",
  "settleWorkflowNodeModelTerminal",
  "publishWorkflowToolApproval",
  "consumeWorkflowToolApproval",
] as const satisfies readonly (keyof PostgresWorkflowAuthority)[];

const postgresWorkflowMethodListIsExhaustive: Exclude<
  keyof PostgresWorkflowAuthority,
  (typeof postgresWorkflowAuthorityMethods)[number]
> extends never
  ? true
  : false = true;

test("PostgreSQL composition exposes only the current Workflow contract", () => {
  const implementation: abstract new (
    ...args: never[]
  ) => WorkflowRunCompositionStore = PostgresWorkflowRunCompositionStore;
  assert.equal(implementation, PostgresWorkflowRunCompositionStore);
  const admission: abstract new (
    ...args: never[]
  ) => WorkflowRunAdmissionStore = PostgresWorkflowRunCompositionStore;
  assert.equal(admission, PostgresWorkflowRunCompositionStore);
  assert.equal(
    "admitWorkflowNodes" in PostgresWorkflowRunCompositionStore.prototype,
    false,
  );
  assert.equal(postgresWorkflowMethodListIsExhaustive, true);
  assert.deepEqual(
    postgresWorkflowAuthorityMethods.filter(
      (method) =>
        typeof PostgresWorkflowRunCompositionStore.prototype[
          method as keyof PostgresWorkflowRunCompositionStore
        ] !== "function",
    ),
    [],
  );
});

test("PostgresDomainStore is the single compile-time WorkflowRuntimeStore identity", () => {
  const implementation: abstract new (
    ...args: never[]
  ) => WorkflowRuntimeStore = PostgresDomainStore;
  assert.equal(implementation, PostgresDomainStore);
});
