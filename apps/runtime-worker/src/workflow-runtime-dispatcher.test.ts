import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  WorkflowNodeContinuationResume,
  WorkflowNodeResponseRecovery,
  WorkflowRuntimeStore,
} from "@crewon/application";
import { canonicalJson } from "@crewon/application";
import {
  compileWorkflowVersion,
  createWorkflowNodeTerminalEvidence,
  serializeCompiledWorkflowVersion,
} from "@crewon/domain";
import {
  ProductionWorkflowRuntimeDispatcher,
  WorkflowNodeDurabilityUncertainError,
  WorkflowNodeSideEffectUncertainError,
} from "./workflow-runtime-dispatcher.ts";

const schema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const workflow = compileWorkflowVersion(
  {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: "wf",
    workflowVersionId: "v1",
    name: "wf",
    description: "wf",
    inputSchema: schema,
    outputSchema: schema,
    entryNodeIds: ["a"],
    outputNodeIds: ["z"],
    nodes: [
      {
        nodeId: "a",
        title: "a",
        instruction: "a",
        kind: "agent",
        agentVersionId: "agent-a",
        dependsOn: [],
        inputSchema: schema,
        outputSchema: schema,
      },
      {
        nodeId: "z",
        title: "z",
        instruction: "z",
        kind: "verification",
        verifierAgentVersionId: "agent-z",
        dependsOn: ["a"],
        inputSchema: schema,
        outputSchema: schema,
      },
    ],
  },
  { sha256: digest },
);
const binding = {
  workflowId: "wf",
  workflowVersionId: "v1",
  contentDigest: workflow.contentDigest,
};

test("scheduler receipt fanout never executes a node", async () => {
  const fixture = composition();
  let executions = 0;
  const dispatcher = create(fixture.store, async () => {
    executions += 1;
    return { status: "completed", value: { result: "x" } };
  });
  const outcome = await dispatcher.dispatch(input("scheduler"));
  assert.deepEqual(outcome, {
    kind: "recovery",
    runId: "r",
    code: "workflow_fanout_committed",
  });
  assert.equal(executions, 0);
  assert.equal(fixture.schedules, 1);
  assert.deepEqual(fixture.workflowInputs, [
    { valueId: "value-1", valueDigest: digest("input") },
  ]);
});

test("node admission replay performs zero duplicate side effects", async () => {
  const fixture = composition();
  fixture.nodeDisposition = "replay";
  let executions = 0;
  const dispatcher = create(fixture.store, async () => {
    executions += 1;
    return { status: "completed", value: { result: "x" } };
  });
  await dispatcher.dispatch(input("node"));
  assert.equal(executions, 0);
  assert.equal(fixture.settlements, 0);
});

test("settlement commit-before-return replay executes the Agent exactly once", async () => {
  const fixture = composition();
  fixture.loseFirstSettlementResponse = true;
  let executeCount = 0;
  const dispatcher = create(fixture.store, async () => {
    executeCount += 1;
    return terminal({ status: "completed", value: {} });
  });

  assert.deepEqual(await dispatcher.dispatch(input("node")), {
    kind: "recovery",
    runId: "r",
    code: "workflow_settlement_result_unknown",
  });
  assert.deepEqual(await dispatcher.dispatch(input("node")), {
    kind: "recovery",
    runId: "r",
    code: "workflow_node_admission_replayed",
  });
  assert.equal(executeCount, 1);
  assert.equal(fixture.atomicSettlements, 1);
});

test("node reconcileRequired admission performs zero execution", async () => {
  const fixture = composition();
  fixture.nodeDisposition = "reconcileRequired";
  let executions = 0;
  await create(fixture.store, async () => {
    executions += 1;
    return { status: "unknown" };
  }).dispatch(input("node"));
  assert.equal(executions, 0);
  assert.equal(fixture.settlements + fixture.atomicSettlements, 0);
});

test("responseObserved reconciliation retrieves once and atomically settles evidence", async () => {
  const fixture = composition();
  fixture.recovery = retrievalRecovery();
  let executions = 0;
  let retrieves = 0;
  const dispatcher = create(
    fixture.store,
    async () => {
      executions += 1;
      return { status: "unknown" };
    },
    fixture.store,
    async ({ recovery }) => {
      retrieves += 1;
      assert.equal(recovery, fixture.recovery);
      return { kind: "terminal", outcome: { status: "completed", value: {} } };
    },
  );

  assert.deepEqual(await dispatcher.dispatch(input("reconcile")), {
    kind: "completed",
    runId: "r",
  });
  assert.equal(executions, 0);
  assert.equal(retrieves, 1);
  assert.equal(fixture.retrievedSettlements, 1);
  assert.deepEqual(fixture.retrievedInputs[0], {
    tenantId: "t",
    runId: "r",
    lease: {
      workItemId: "work-claim-1",
      ownerId: "o",
      leaseId: "l",
      leaseEpoch: 1,
    },
    binding,
    nodeId: "a",
    claimId: "claim-1",
    claimEpoch: 1,
    reconciliationOperationId: "reconcile-1",
    agentVersionId: "agent-a",
    attempt: {
      stepId: "a",
      attemptId: "attempt-1",
      workItemId: "node-work",
      leaseEpoch: 4,
    },
    dispatch: {
      operationId: "segment:attempt-1:request:1",
      requestSequence: 1,
      expectedRevision: 3,
      status: "responseObserved",
    },
    evidence: createWorkflowNodeTerminalEvidence({
      workflow,
      nodeId: "a",
      outcome: { status: "completed", value: {} },
      digester: { sha256: digest },
    }),
    dispatchTerminalOutcome: {
      kind: "completed",
      code: null,
      certainty: "responseObserved",
    },
  });
});

test("GET reconciliation unknown outcome retains work for retry without settlement", async () => {
  const fixture = composition();
  fixture.recovery = retrievalRecovery();
  const dispatcher = create(
    fixture.store,
    async () => ({ status: "unknown" }),
    fixture.store,
    async () => ({ kind: "terminal", outcome: { status: "unknown" } }),
  );

  assert.deepEqual(await dispatcher.dispatch(input("reconcile")), {
    kind: "retry",
    runId: "r",
    code: "workflow_response_retrieve_retry_required",
  });
  assert.equal(fixture.retrievedSettlements, 0);
});

test("retrieved nonterminal commits once and resumes without another GET or POST", async () => {
  const fixture = composition();
  fixture.recovery = retrievalRecovery();
  let retrieves = 0;
  let resumes = 0;
  const dispatcher = create(
    fixture.store,
    async () => {
      throw new Error("fresh execution forbidden");
    },
    fixture.store,
    async () => {
      retrieves += 1;
      return { kind: "continuation", payload: retrievedContinuationPayload() };
    },
    async () => {
      resumes += 1;
      return { status: "completed", value: {} };
    },
  );

  assert.deepEqual(await dispatcher.dispatch(input("reconcile")), {
    kind: "completed",
    runId: "r",
  });
  assert.deepEqual(
    {
      retrieves,
      commits: fixture.retrievedContinuationCommits,
      resumes,
      terminalSettlements: fixture.retrievedSettlements,
    },
    { retrieves: 1, commits: 1, resumes: 1, terminalSettlements: 0 },
  );
});

test("lost continuation commit response replays resume without another GET", async () => {
  const fixture = composition();
  fixture.recovery = retrievalRecovery();
  fixture.loseRetrievedContinuationResponse = true;
  let retrieves = 0;
  let resumes = 0;
  const dispatcher = create(
    fixture.store,
    async () => {
      throw new Error("fresh execution forbidden");
    },
    fixture.store,
    async () => {
      retrieves += 1;
      return { kind: "continuation", payload: retrievedContinuationPayload() };
    },
    async () => {
      resumes += 1;
      return { status: "completed", value: {} };
    },
  );

  assert.deepEqual(await dispatcher.dispatch(input("reconcile")), {
    kind: "recovery",
    runId: "r",
    code: "workflow_retrieved_continuation_commit_unknown",
  });
  assert.deepEqual(await dispatcher.dispatch(input("reconcile")), {
    kind: "completed",
    runId: "r",
  });
  assert.deepEqual(
    { retrieves, commits: fixture.retrievedContinuationCommits, resumes },
    { retrieves: 1, commits: 1, resumes: 1 },
  );
});

test("continuation reconciliation resumes once without execute or provider GET", async () => {
  const fixture = composition();
  fixture.resume = continuationResume();
  let executions = 0;
  let retrieves = 0;
  let resumes = 0;
  const dispatcher = create(
    fixture.store,
    async () => {
      executions += 1;
      return { status: "unknown" };
    },
    fixture.store,
    async () => {
      retrieves += 1;
      return { kind: "terminal", outcome: { status: "unknown" } };
    },
    async ({ resume }) => {
      resumes += 1;
      assert.equal(resume, fixture.resume);
      return { status: "completed", value: {} };
    },
  );

  assert.deepEqual(await dispatcher.dispatch(input("reconcile")), {
    kind: "completed",
    runId: "r",
  });
  assert.equal(executions, 0);
  assert.equal(retrieves, 0);
  assert.equal(resumes, 1);
  assert.equal(fixture.settlements, 1);
});

test("continuation resume drift fails closed before Agent execution", async () => {
  const baseline = continuationResume();
  const drifts: ReadonlyArray<
    readonly [string, WorkflowNodeContinuationResume]
  > = [
    [
      "reconciliation lease",
      {
        ...baseline,
        reconciliationLease: { ...baseline.reconciliationLease, leaseEpoch: 2 },
      },
    ],
    [
      "attempt work item",
      {
        ...baseline,
        attempt: { ...baseline.attempt, workItemId: "stale-work" },
      },
    ],
    [
      "pending Tool work item",
      {
        ...baseline,
        pendingTools: [
          {
            receipt: {
              call: { callId: "call-1" },
              status: "prepared",
              actionIntent: {},
              tenantId: "t",
              runId: "r",
              workItemId: "stale-work",
            } as never,
            step: {} as never,
            attempt: {} as never,
          },
        ],
      },
    ],
    [
      "attempt lease",
      { ...baseline, attempt: { ...baseline.attempt, leaseEpoch: 2 } },
    ],
    [
      "attempt tenant",
      { ...baseline, attempt: { ...baseline.attempt, tenantId: "other" } },
    ],
    [
      "step status",
      { ...baseline, step: { ...baseline.step, status: "completed" } },
    ],
    ["step run", { ...baseline, step: { ...baseline.step, runId: "other" } }],
    [
      "checkpoint authority",
      {
        ...baseline,
        continuation: {
          ...baseline.continuation,
          authority: { ...baseline.continuation.authority, claimEpoch: 2 },
        },
      },
    ],
    [
      "checkpoint digest",
      {
        ...baseline,
        attempt: { ...baseline.attempt, checkpointDigest: digest("stale") },
      },
    ],
    [
      "provider checkpoint",
      {
        ...baseline,
        continuation: {
          ...baseline.continuation,
          providerCheckpoint: {
            ...baseline.continuation.providerCheckpoint!,
            modelId: "other-model",
          },
        },
      },
    ],
    [
      "provider turn state",
      {
        ...baseline,
        continuation: {
          ...baseline.continuation,
          providerTurnState: "drifted",
        },
      },
    ],
    [
      "active dispatch",
      {
        ...baseline,
        continuation: {
          ...baseline.continuation,
          activeDispatch: {
            operationId: "old-dispatch",
            requestSequence: 1,
            expectedRevision: 1,
            status: "responseObserved",
          },
        },
      },
    ],
    [
      "terminal candidate",
      {
        ...baseline,
        continuation: {
          ...baseline.continuation,
          terminalCandidate: {} as never,
        },
      },
    ],
  ];
  for (const [label, resume] of drifts) {
    const fixture = composition();
    fixture.resume = resume;
    let resumes = 0;
    await assert.rejects(
      create(
        fixture.store,
        async () => {
          throw new Error("execute must not run");
        },
        fixture.store,
        async () => {
          throw new Error("GET must not run");
        },
        async () => {
          resumes += 1;
          return { status: "unknown" };
        },
      ).dispatch(input("reconcile")),
      /workflow_node_resume_identity_mismatch/u,
      label,
    );
    assert.equal(resumes, 0, label);
  }
});

test("transient continuation resume failure retries the retained reconcile work", async () => {
  const fixture = composition();
  fixture.resume = continuationResume();
  const dispatcher = create(
    fixture.store,
    async () => {
      throw new Error("execute must not run");
    },
    fixture.store,
    async () => {
      throw new Error("GET must not run");
    },
    async () => {
      throw new Error("provider temporarily unavailable");
    },
  );
  assert.deepEqual(await dispatcher.dispatch(input("reconcile")), {
    kind: "retry",
    runId: "r",
    code: "workflow_node_resume_failed",
  });
  assert.equal(fixture.settlements, 0);
});

test("rejects a split Workflow Store identity", () => {
  const fixture = composition();
  assert.throws(
    () =>
      create(
        fixture.store,
        async () => ({ status: "unknown" }),
        {} as WorkflowRuntimeStore,
      ),
    /workflow_runtime_store_identity_mismatch/u,
  );
});

test("fresh sibling admissions pass actual values and settle independently", async () => {
  const left = composition();
  const right = composition();
  const order: string[] = [];
  const run = async (
    fixture: ReturnType<typeof composition>,
    claimId: string,
  ) =>
    create(fixture.store, async (node) => {
      order.push(node.claimId);
      return terminal({ status: "completed", value: {} });
    }).dispatch(input("node", claimId));
  await run(right, "claim-right");
  await run(left, "claim-left");
  assert.deepEqual(order, ["claim-right", "claim-left"]);
  assert.equal(left.atomicSettlements, 1);
  assert.equal(right.atomicSettlements, 1);
  const exact = left.atomicInputs[0] as Record<string, unknown>;
  assert.equal((exact.authority as { nodeId: string }).nodeId, "a");
  assert.equal(
    (exact.authority as { workItemId: string }).workItemId,
    "work-claim-left",
  );
  assert.equal(exact.candidateId, "candidate-1");
});

test("commit-response loss retries through nonfresh recovery without execution", async () => {
  const fixture = composition();
  fixture.failSettlement = true;
  let executions = 0;
  const dispatcher = create(fixture.store, async () => {
    executions += 1;
    return terminal({ status: "completed", value: {} });
  });
  assert.equal((await dispatcher.dispatch(input("node"))).kind, "recovery");
  fixture.nodeDisposition = "replay";
  assert.equal((await dispatcher.dispatch(input("node"))).kind, "recovery");
  assert.equal(executions, 1);
  assert.equal(fixture.atomicSettlements, 1);
});

test("reports completed only for terminalConverged Store authority", async () => {
  const fixture = composition();
  fixture.atomicRunDisposition = "nonTerminal";
  const dispatcher = create(fixture.store, async () =>
    terminal({ status: "completed", value: {} }),
  );
  assert.equal((await dispatcher.dispatch(input("node"))).kind, "recovery");
  fixture.nodeDisposition = "fresh";
  fixture.settlementCommitted = false;
  fixture.atomicRunDisposition = "terminalConverged";
  assert.equal(
    (await dispatcher.dispatch(input("node", "claim-2"))).kind,
    "completed",
  );
});

test("deterministic local execution errors use ordinary settlement", async () => {
  const fixture = composition();
  const outcome = await create(fixture.store, async () => {
    throw new Error("workflow_node_output_json_invalid");
  }).dispatch(input("node"));
  assert.deepEqual(outcome, { kind: "completed", runId: "r" });
  assert.equal(fixture.settlements, 1);
  assert.equal(fixture.atomicSettlements, 0);
});

test("approval publication returns a typed waiting outcome without settlement", async () => {
  const fixture = composition();
  const outcome = await create(fixture.store, async () => ({
    status: "waitingApproval",
    approvalId: "approval-1",
  })).dispatch(input("node"));
  assert.deepEqual(outcome, {
    kind: "waitingApproval",
    runId: "r",
    approvalId: "approval-1",
  });
  assert.equal(fixture.settlements, 0);
});

test("uses unknown only when node side effects may have been sent", async () => {
  const fixture = composition();
  await create(fixture.store, async () => {
    throw new WorkflowNodeSideEffectUncertainError();
  }).dispatch(input("node"));
  assert.deepEqual(fixture.outcomes, [{ status: "unknown" }]);
});

test("keeps an indeterminate continuation commit out of business failure settlement", async () => {
  const fixture = composition();
  await create(fixture.store, async () => {
    throw new WorkflowNodeDurabilityUncertainError(
      new Error("postgres_commit_ack_lost"),
    );
  }).dispatch(input("node"));
  assert.deepEqual(fixture.outcomes, [{ status: "unknown" }]);
});

test("propagates an unavailable reconciliation authority without recursive scheduling", async () => {
  const fixture = composition();
  await assert.rejects(
    create(fixture.store, async () => ({ status: "unknown" })).dispatch(
      input("reconcile"),
    ),
    /reconciliation evidence provider is not composed/,
  );
  assert.equal(fixture.reconciliations, 0);
});

test("routes cancellation through composition authority", async () => {
  const fixture = composition();
  const outcome = await create(fixture.store, async () => ({
    status: "unknown",
  })).cancel(input("scheduler"));
  assert.deepEqual(outcome, { kind: "completed", runId: "r" });
  assert.equal(fixture.cancellations, 1);
});

test("retains a dedicated cancellation coordinator until sibling leases settle", async () => {
  const fixture = composition();
  fixture.store.cancelWorkflowExecution = async () => ({
    disposition: "retryRequired",
    execution: {} as never,
    canceledNodeIds: [],
    canceledGateRequestNodeIds: [],
    reconciliationWorkItemIds: [],
    handoff: {
      currentWorkItem: "retained",
      nextWorkItemId: null,
      kind: "none",
    },
    runDisposition: "nonTerminal",
  });
  const outcome = await create(fixture.store, async () => {
    throw new Error("agent must not execute");
  }).cancel(input("scheduler"));
  assert.deepEqual(outcome, {
    kind: "retry",
    runId: "r",
    code: "workflow_cancellation_retry_required",
  });
});

test("rejects non-canonical cancellation proof from composition authority", async () => {
  const fixture = composition();
  fixture.store.cancelWorkflowExecution = async () => ({
    disposition: "cancellationPending",
    execution: {
      nodes: [
        { nodeId: "a", status: "canceled" },
        { nodeId: "b", status: "canceled" },
      ],
    } as never,
    canceledNodeIds: ["b", "a"],
    canceledGateRequestNodeIds: [],
    reconciliationWorkItemIds: [],
    handoff: {
      currentWorkItem: "completed",
      nextWorkItemId: null,
      kind: "none",
    },
    runDisposition: "nonTerminal",
  });
  await assert.rejects(
    create(fixture.store, async () => {
      throw new Error("agent must not execute");
    }).cancel(input("scheduler")),
    /workflow_cancellation_proof_invalid/u,
  );
});

test("routes cancel-requested reconciliation without invoking cancellation", async () => {
  const fixture = composition();
  fixture.store.reconcileWorkflowNode = async () => ({
    disposition: "settled",
    evidenceStatus: "possiblySent",
    execution: {} as never,
    handoff: {
      currentWorkItem: "completed",
      nextWorkItemId: null,
      kind: "none",
    },
    runDisposition: "nonTerminal",
  });
  const outcome = await create(fixture.store, async () => {
    throw new Error("agent must not execute");
  }).cancel(input("reconcile"));
  assert.deepEqual(outcome, {
    kind: "recovery",
    runId: "r",
    code: "workflow_reconciliation_settled",
  });
  assert.equal(fixture.cancellations, 0);
});

test("projects completed possibly-sent reconciliation as operator required", async () => {
  const fixture = composition();
  const current = (await fixture.store.loadWorkflowExecution({
    tenantId: "t",
    runId: "r",
  }))!;
  const execution = {
    ...current,
    status: "failed" as const,
    nodes: current.nodes.map((node) =>
      node.nodeId === "a"
        ? {
            ...node,
            status: "failed" as const,
            failureCode: "workflow_model_dispatch_operator_required",
          }
        : node,
    ),
  };
  fixture.store.reconcileWorkflowNode = async () => ({
    disposition: "operatorRequired",
    evidenceStatus: "possiblySent",
    execution,
    handoff: {
      currentWorkItem: "completed",
      nextWorkItemId: null,
      kind: "none",
    },
    runDisposition: "terminalConverged",
  });

  assert.deepEqual(
    await create(fixture.store, async () => {
      throw new Error("agent must not execute");
    }).dispatch(input("reconcile")),
    {
      kind: "operatorRequired",
      runId: "r",
      code: "workflow_model_dispatch_operator_required",
    },
  );
});

test("projects nonterminal operator action without retrying a parallel lane", async () => {
  const fixture = composition();
  const current = (await fixture.store.loadWorkflowExecution({
    tenantId: "t",
    runId: "r",
  }))!;
  fixture.store.reconcileWorkflowNode = async () => ({
    disposition: "operatorRequired",
    evidenceStatus: "possiblySent",
    execution: {
      ...current,
      nodes: [
        {
          ...current.nodes[0]!,
          status: "failed",
          failureCode: "workflow_model_dispatch_operator_required",
        },
        {
          ...current.nodes[0]!,
          nodeId: "b",
          status: "running",
          failureCode: null,
        },
      ],
    },
    handoff: {
      currentWorkItem: "completed",
      nextWorkItemId: null,
      kind: "none",
    },
    runDisposition: "nonTerminal",
  });
  assert.deepEqual(
    await create(fixture.store, async () => {
      throw new Error("agent must not execute");
    }).dispatch(input("reconcile")),
    {
      kind: "operatorRequired",
      runId: "r",
      code: "workflow_model_dispatch_operator_required",
    },
  );
});

test("rejects forged operator-required node projection", async () => {
  const fixture = composition();
  const current = (await fixture.store.loadWorkflowExecution({
    tenantId: "t",
    runId: "r",
  }))!;
  fixture.store.reconcileWorkflowNode = async () => ({
    disposition: "operatorRequired",
    evidenceStatus: "possiblySent",
    execution: {
      ...current,
      status: "failed",
      nodes: current.nodes.map((node) =>
        node.nodeId === "a"
          ? { ...node, status: "failed", failureCode: "forged" }
          : node,
      ),
    },
    handoff: {
      currentWorkItem: "completed",
      nextWorkItemId: null,
      kind: "none",
    },
    runDisposition: "terminalConverged",
  });
  await assert.rejects(
    create(fixture.store, async () => {
      throw new Error("agent must not execute");
    }).dispatch(input("reconcile")),
    /workflow_operator_required_node_invalid/u,
  );
});

function composition() {
  const state = (status: "running" | "completed" = "running") => ({
    schemaVersion: "crewon.workflow-execution.v0" as const,
    tenantId: "t",
    runId: "r",
    workflowId: "wf",
    workflowVersionId: "v1",
    contentDigest: workflow.contentDigest,
    revision: 1,
    status,
    cancelRequested: false,
    nodes: [
      {
        nodeId: "a",
        kind: "agent" as const,
        agentVersionId: "agent-a",
        status: "running" as const,
        claimId: "claim-1",
        claimOperationId: "schedule-1",
        claimEpoch: 1,
        leaseExpiresAt: null,
        gateRequestId: null,
        inputDigest: digest("input"),
        resultDigest: null,
        failureCode: null,
      },
    ],
    updatedAt: "2026-08-12T00:00:00Z",
  });
  const fixture = {
    schedules: 0,
    settlements: 0,
    atomicSettlements: 0,
    atomicInputs: [] as unknown[],
    reconciliations: 0,
    cancellations: 0,
    retrievedSettlements: 0,
    retrievedInputs: [] as unknown[],
    retrievedContinuationCommits: 0,
    retrievedContinuationInputs: [] as unknown[],
    loseRetrievedContinuationResponse: false,
    recovery: null as WorkflowNodeResponseRecovery | null,
    resume: null as WorkflowNodeContinuationResume | null,
    outcomes: [] as unknown[],
    workflowInputs: [] as unknown[],
    nodeDisposition: "fresh" as "fresh" | "replay" | "reconcileRequired",
    failSettlement: false,
    loseFirstSettlementResponse: false,
    settlementCommitted: false,
    atomicRunDisposition: "terminalConverged" as
      | "terminalConverged"
      | "nonTerminal",
    store: null as unknown as WorkflowRuntimeStore,
  };
  fixture.store = {
    async loadWorkflowExecution() {
      return state();
    },
    async publishWorkflowToolApproval() {
      throw new Error("unused");
    },
    async consumeWorkflowToolApproval() {
      throw new Error("unused");
    },
    async commitWorkflowRunStart() {
      throw new Error("unused");
    },
    async scheduleWorkflowNodes(input) {
      fixture.schedules += 1;
      fixture.workflowInputs.push(input.workflowInput);
      return {
        disposition: "replay",
        execution: state(),
        nodeWorkItems: [],
        gatePublications: [],
        reconciliationClaims: [],
        handoff: {
          currentWorkItem: "completed",
          nextWorkItemId: null,
          kind: "none",
        },
        runDisposition: "nonTerminal",
      };
    },
    async admitWorkflowNodeWork(input) {
      if (fixture.nodeDisposition === "reconcileRequired")
        return {
          disposition: "reconcileRequired" as const,
          execution: state(),
          admission: null,
          reconciliationClaim: {
            node: workflow.nodes[0]!,
            claimId: input.claimId,
            claimEpoch: input.claimEpoch,
            gateRequestId: null,
            inputDigest: digest("input"),
          },
          handoff: {
            currentWorkItem: "completed",
            nextWorkItemId: "reconcile-1",
            kind: "reconcile" as const,
          },
        };
      if (fixture.nodeDisposition === "replay" || fixture.settlementCommitted)
        return {
          disposition: "replay" as const,
          execution: state(),
          admission: null,
          handoff: {
            currentWorkItem: "completed" as const,
            nextWorkItemId: null,
            kind: "none" as const,
          },
        };
      const claim = {
        node: workflow.nodes[0]!,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        gateRequestId: null,
        inputDigest: digest("input"),
      };
      return {
        disposition: "fresh",
        execution: {
          ...state(),
          nodes: [{ ...state().nodes[0]!, claimId: input.claimId }],
        },
        admission: {
          claim,
          step: { stepId: `step-${input.claimId}` } as never,
          attempt: { attemptId: `attempt-${input.claimId}` } as never,
          inputValue: {
            schemaVersion: "crewon.workflow-execution-value.v0",
            valueId: `value-${input.claimId}`,
            value: { input: input.claimId },
            valueDigest: digest("input"),
          },
        },
        handoff: {
          currentWorkItem: "retained",
          nextWorkItemId: null,
          kind: "none",
        },
      };
    },
    async settleWorkflowNode(input) {
      fixture.settlements += 1;
      fixture.outcomes.push(input.outcome);
      if (fixture.failSettlement) throw new Error("commit unknown");
      fixture.settlementCommitted = true;
      if (fixture.loseFirstSettlementResponse)
        throw new Error("response lost after commit");
      return {
        disposition: "settled",
        execution: state("completed"),
        schedulerContinuationWorkItemId: null,
        handoff: {
          currentWorkItem: "completed",
          nextWorkItemId: null,
          kind: "none",
        },
        runDisposition: "terminalConverged",
      };
    },
    async recordWorkflowHumanGateDecision() {
      throw new Error("not used");
    },
    async settleWorkflowHumanGate() {
      throw new Error("not used");
    },
    async scheduleWorkflowReconciliation() {
      fixture.reconciliations += 1;
      return {
        disposition: "scheduled",
        reconciliationWorkItemId: "wf1:rec:hash",
        handoff: {
          currentWorkItem: "completed",
          nextWorkItemId: "wf1:rec:hash",
          kind: "reconcile",
        },
      };
    },
    async reconcileWorkflowNode() {
      if (fixture.resume !== null)
        return {
          disposition: "resumeRequired" as const,
          evidenceStatus: "responseObserved" as const,
          resume: fixture.resume,
          execution: state(),
          handoff: {
            currentWorkItem: "retained" as const,
            nextWorkItemId: null,
            kind: "none" as const,
          },
          runDisposition: "nonTerminal" as const,
        };
      if (fixture.recovery === null)
        throw new Error("reconciliation evidence provider is not composed");
      return {
        disposition: "retrieveRequired",
        evidenceStatus: "responseObserved",
        recovery: fixture.recovery,
        execution: state(),
        handoff: {
          currentWorkItem: "retained",
          nextWorkItemId: null,
          kind: "none",
        },
        runDisposition: "nonTerminal",
      };
    },
    async settleRetrievedWorkflowNode(input) {
      fixture.retrievedSettlements += 1;
      fixture.retrievedInputs.push(input);
      return {
        disposition: "settled",
        execution: state("completed"),
        handoff: {
          currentWorkItem: "completed",
          nextWorkItemId: null,
          kind: "none",
        },
        runDisposition: "terminalConverged",
        evidenceStatus: "responseObserved",
        evidence: input.evidence,
        dispatchTerminalOutcome: input.dispatchTerminalOutcome,
      };
    },
    async commitRetrievedWorkflowNodeContinuation(input) {
      fixture.retrievedContinuationCommits += 1;
      fixture.retrievedContinuationInputs.push(input);
      fixture.resume = continuationResume();
      if (fixture.loseRetrievedContinuationResponse)
        throw new Error("response lost after commit");
      return {
        disposition: "resumeRequired",
        evidenceStatus: "responseObserved",
        resume: fixture.resume,
        execution: state(),
        handoff: {
          currentWorkItem: "retained",
          nextWorkItemId: null,
          kind: "none",
        },
        runDisposition: "nonTerminal",
      };
    },
    async cancelWorkflowExecution() {
      fixture.cancellations += 1;
      return {
        disposition: "canceled",
        execution: state("completed"),
        canceledNodeIds: [],
        canceledGateRequestNodeIds: [],
        reconciliationWorkItemIds: [],
        handoff: {
          currentWorkItem: "completed",
          nextWorkItemId: null,
          kind: "none",
        },
        runDisposition: "terminalConverged",
      };
    },
    async loadWorkflowNodeContinuation() {
      return null;
    },
    async commitWorkflowToolContinuation() {
      throw new Error("unused");
    },
    async commitWorkflowAssistantContinuation() {
      throw new Error("unused");
    },
    async settleWorkflowNodeModelTerminal(input) {
      fixture.atomicSettlements += 1;
      fixture.atomicInputs.push(input);
      if (fixture.failSettlement) throw new Error("commit unknown");
      fixture.settlementCommitted = true;
      if (fixture.loseFirstSettlementResponse)
        throw new Error("response lost after commit");
      return {
        disposition: "settled",
        continuation: null,
        handoff: {
          currentWorkItem: "completed",
          nextWorkItemId: null,
          kind: "none",
        },
        runDisposition: fixture.atomicRunDisposition,
        evidence: input.evidence,
      };
    },
    async settlePreparedWorkflowNodeTerminal(input) {
      fixture.atomicSettlements += 1;
      fixture.atomicInputs.push(input);
      if (fixture.failSettlement) throw new Error("commit unknown");
      fixture.settlementCommitted = true;
      if (fixture.loseFirstSettlementResponse)
        throw new Error("response lost after commit");
      return {
        disposition: "settled",
        continuation: null,
        handoff: {
          currentWorkItem: "completed",
          nextWorkItemId: null,
          kind: "none",
        },
        runDisposition: fixture.atomicRunDisposition,
        evidence: {} as never,
      };
    },
    async loadModelDispatchReceipt() {
      return null;
    },
    async prepareModelDispatch() {
      throw new Error("unused");
    },
    async markModelDispatchPossiblySent() {
      throw new Error("unused");
    },
    async observeModelDispatchResponse() {
      throw new Error("unused");
    },
    async terminateModelDispatch() {
      throw new Error("unused");
    },
  };
  return fixture;
}

function terminal<
  T extends
    | { status: "completed"; value: unknown }
    | { status: "failed"; failureCode: string }
    | { status: "canceled" },
>(outcome: T) {
  return {
    status: "terminalCandidate" as const,
    terminalStatus: outcome.status,
    modelTerminal: { candidateId: "candidate-1" },
  };
}

function create(
  store: WorkflowRuntimeStore,
  execute: ConstructorParameters<
    typeof ProductionWorkflowRuntimeDispatcher
  >[0]["agent"]["execute"],
  agentStore: WorkflowRuntimeStore = store,
  reconcile: ConstructorParameters<
    typeof ProductionWorkflowRuntimeDispatcher
  >[0]["agent"]["reconcile"] = async () => ({
    kind: "terminal",
    outcome: { status: "unknown" },
  }),
  resume: ConstructorParameters<
    typeof ProductionWorkflowRuntimeDispatcher
  >[0]["agent"]["resume"] = async () => ({ status: "unknown" }),
) {
  return new ProductionWorkflowRuntimeDispatcher({
    versions: {
      async loadWorkflowVersion() {
        return {
          schemaVersion: "crewon.workflow-version-asset.v0",
          tenantId: "t",
          workflowId: "wf",
          workflowVersionId: "v1",
          contentDigest: workflow.contentDigest,
          definitionJson: serializeCompiledWorkflowVersion(workflow),
          createdAt: "2026-08-12T00:00:00Z",
        };
      },
      async registerWorkflowVersion() {
        throw new Error();
      },
      async listWorkflowVersions() {
        throw new Error();
      },
    },
    store,
    digester: { sha256: digest },
    agent: {
      workflowStore: agentStore,
      execute,
      reconcile,
      resume,
      async resumeToolApproval() {
        throw new Error("not used");
      },
    },
    leaseDurationMs: 30_000,
  });
}

function retrievalRecovery(): WorkflowNodeResponseRecovery {
  const checkpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "responses",
    adapterVersion: "1",
    modelId: "model-1",
    opaquePayload: { responseId: "resp-1" },
  } as const;
  return {
    claim: {
      node: workflow.nodes[0]!,
      claimId: "claim-1",
      claimEpoch: 1,
      gateRequestId: null,
      inputDigest: digest("input"),
    },
    step: { stepId: "a", currentAttemptId: "attempt-1" } as never,
    attempt: {
      attemptId: "attempt-1",
      tenantId: "t",
      runId: "r",
      stepId: "a",
      workItemId: "node-work",
      attemptNumber: 1,
      retryOfAttemptId: null,
      leaseEpoch: 4,
      status: "running",
      checkpointDigest: digest(JSON.stringify(checkpoint)),
      providerCheckpoint: checkpoint,
    } as never,
    inputValue: {
      schemaVersion: "crewon.workflow-execution-value.v0",
      valueId: "value-1",
      valueDigest: digest("input"),
      value: {},
    },
    dispatch: {
      tenantId: "t",
      runId: "r",
      stepId: "a",
      attemptId: "attempt-1",
      operationId: "segment:attempt-1:request:1",
      requestSequence: 1,
      operation: "dispatch",
      workItemId: "node-work",
      leaseEpoch: 4,
      requestDigest: digest("request"),
      provider: {
        agentVersionId: "agent-a",
        adapterName: "responses",
        adapterVersion: "1",
        modelId: "model-1",
      },
      status: "responseObserved",
      revision: 3,
      responseCheckpointDigest: digest(JSON.stringify(checkpoint)),
    } as never,
    priorContinuation: null,
  };
}

function retrievedContinuationPayload() {
  return {
    events: [
      {
        schemaVersion: "crewon.agent-event.v0" as const,
        runId: "r",
        segmentId: "segment:attempt-1",
        sequence: 2,
        type: "tool.requested" as const,
        data: {
          callId: "call-1",
          kind: "function",
          name: "lookup",
          input: "{}",
        },
      },
    ],
    assistantContinuation: null,
    next: {
      schemaVersion: "crewon.workflow-node-continuation.v0" as const,
      segmentId: "segment:attempt-1",
      modelSampleIndex: 0,
      toolRoundsConsumed: 0,
      providerCheckpoint: retrievalRecovery().attempt.providerCheckpoint,
      providerTurnState: null,
      history: [],
    },
  };
}

function continuationResume(): WorkflowNodeContinuationResume {
  const providerCheckpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "responses",
    adapterVersion: "1",
    modelId: "model-1",
    opaquePayload: { responseId: "resp-1" },
  } as const;
  const reconciliationLease = {
    workItemId: "work-claim-1",
    ownerId: "o",
    leaseId: "l",
    leaseEpoch: 1,
  } as const;
  const authority = {
    tenantId: "t",
    runId: "r",
    workItemId: reconciliationLease.workItemId,
    leaseEpoch: reconciliationLease.leaseEpoch,
    nodeId: "a",
    nodeKind: "agent",
    claimId: "claim-1",
    claimEpoch: 1,
    agentVersionId: "agent-a",
    attempt: { stepId: "step-a", attemptId: "attempt-1" },
  } as const;
  return {
    claim: {
      node: workflow.nodes[0]!,
      claimId: "claim-1",
      claimEpoch: 1,
      gateRequestId: null,
      inputDigest: digest("input"),
    },
    reconciliationLease,
    pendingTools: [],
    step: {
      schemaVersion: "crewon.run-step.v0",
      stepId: "step-a",
      tenantId: "t",
      runId: "r",
      kind: "workflowNode",
      status: "running",
      revision: 2,
      currentAttemptId: "attempt-1",
      attemptCount: 1,
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:01.000Z",
      terminalAt: null,
    },
    attempt: {
      schemaVersion: "crewon.run-attempt.v0",
      attemptId: "attempt-1",
      tenantId: "t",
      runId: "r",
      stepId: "step-a",
      workItemId: reconciliationLease.workItemId,
      attemptNumber: 1,
      retryOfAttemptId: null,
      leaseEpoch: reconciliationLease.leaseEpoch,
      status: "running",
      checkpointDigest: digest(canonicalJson(providerCheckpoint)),
      providerCheckpoint,
      providerTurnState: null,
      failure: null,
      startedAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:01.000Z",
      terminalAt: null,
    },
    continuation: {
      schemaVersion: "crewon.workflow-node-continuation.v0",
      authority,
      segmentId: "segment:attempt-1",
      modelSampleIndex: 0,
      toolRoundsConsumed: 0,
      providerCheckpoint,
      providerTurnState: null,
      activeDispatch: null,
      terminalCandidate: null,
      history: [
        { type: "message", role: "user", content: "do work" },
        { type: "message", role: "assistant", content: "continuing" },
      ],
      revision: 2,
      updatedAt: "2026-08-19T00:00:01.000Z",
    },
  };
}
function input(kind: "scheduler" | "node" | "reconcile", claimId = "claim-1") {
  const payload =
    kind === "scheduler"
      ? {
          schemaVersion: "crewon.workflow-scheduler-work-item.v1",
          trigger: "workflowScheduler",
          binding,
          schedulerOperationId: "schedule-1",
          workflowInput: { valueId: "value-1", valueDigest: digest("input") },
        }
      : kind === "node"
        ? {
            schemaVersion: "crewon.workflow-node-work-item.v0",
            trigger: "workflowNode",
            binding,
            nodeId: "a",
            claimId,
            claimEpoch: 1,
            schedulerOperationId: "schedule-1",
          }
        : {
            schemaVersion: "crewon.workflow-reconcile-work-item.v0",
            trigger: "workflowReconcile",
            binding,
            reconciliationOperationId: "reconcile-1",
            nodeId: "a",
            claimId,
            claimEpoch: 1,
          };
  return {
    run: {
      purpose: "workflow",
      workflowVersionBinding: binding,
      tenantId: "t",
      runId: "r",
    } as never,
    claim: {
      workItem: {
        workItemId: `work-${claimId}`,
        tenantId: "t",
        runId: "r",
        payload,
      },
      lease: { ownerId: "o", leaseId: "l", epoch: 1 },
    } as never,
  };
}
function digest(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
