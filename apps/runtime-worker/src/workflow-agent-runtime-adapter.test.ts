import assert from "node:assert/strict";
import test from "node:test";
import { CrewONAgentKernel } from "@crewon/agent-kernel";
import { DirectResponsesTransport } from "@crewon/agent-responses";
import {
  SharedWorkflowAdmittedAgentExecutionEngine,
  WorkflowAgentRuntimeAdapter,
} from "./workflow-agent-runtime-adapter.ts";

const binding = {
  workflowId: "workflow-1",
  workflowVersionId: "workflow-version-1",
  contentDigest: `sha256:${"a".repeat(64)}`,
} as const;

test("resolves the frozen node runtime and preserves admitted authority and actual input", async () => {
  const runtime = { version: { agentVersionId: "node-agent" } } as never;
  let received:
    | Parameters<
        ConstructorParameters<
          typeof WorkflowAgentRuntimeAdapter
        >[0]["engine"]["execute"]
      >[0]
    | undefined;
  const adapter = new WorkflowAgentRuntimeAdapter({
    runtimes: {
      async resolve(locator) {
        assert.deepEqual(locator, {
          tenantId: "tenant-1",
          agentVersionId: "node-agent",
        });
        return runtime;
      },
    },
    engine: {
      workflowStore: {} as never,
      async reconcile() {
        throw new Error("not used");
      },
      async resumeToolApproval() {
        throw new Error("not used");
      },
      async execute(input) {
        received = input;
        return { status: "completed", value: { answer: 42 } };
      },
    },
  });
  const workItemClaim = { workItem: { workItemId: "node-work" } } as never;
  const inputValue = {
    schemaVersion: "crewon.workflow-execution-value.v0",
    valueId: "value-1",
    value: { task: "run" },
    valueDigest: "sha256:value",
  } as const;
  assert.deepEqual(
    await adapter.execute({
      tenantId: "tenant-1",
      runId: "run-1",
      nodeId: "node-1",
      agentVersionId: "node-agent",
      node: agentNode(),
      inputValue,
      claimId: "claim-1",
      claimEpoch: 2,
      stepId: "step-1",
      attemptId: "attempt-1",
      workItemClaim,
      binding,
    }),
    { status: "completed", value: { answer: 42 } },
  );
  assert.equal(received?.runtime, runtime);
  assert.equal(received?.authority.workItemClaim, workItemClaim);
  assert.equal(received?.inputValue, inputValue);
});

test("fails closed instead of substituting the root Agent runtime", async () => {
  const adapter = new WorkflowAgentRuntimeAdapter({
    runtimes: {
      async resolve() {
        return null;
      },
    },
    engine: {
      workflowStore: {} as never,
      async reconcile() {
        throw new Error("not used");
      },
      async resumeToolApproval() {
        throw new Error("not used");
      },
      async execute() {
        throw new Error("must not execute");
      },
    },
  });
  await assert.rejects(
    adapter.execute({
      tenantId: "tenant-1",
      runId: "run-1",
      nodeId: "node-1",
      agentVersionId: "node-agent",
      node: agentNode(),
      inputValue: {
        schemaVersion: "crewon.workflow-execution-value.v0",
        valueId: "v",
        value: {},
        valueDigest: "d",
      },
      claimId: "c",
      claimEpoch: 1,
      stepId: "s",
      attemptId: "a",
      workItemClaim: {} as never,
      binding,
    }),
    /workflow_node_agent_runtime_unavailable/,
  );
});

test("responseObserved recovery performs exactly one GET and no dispatch mutation", async () => {
  const methods: string[] = [];
  const checkpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "model",
    opaquePayload: { responseId: "resp-observed" },
  } as const;
  const attempt = {
    attemptId: "attempt-old",
    tenantId: "tenant-1",
    runId: "run-1",
    stepId: "node-1",
    workItemId: "node-work-old",
    attemptNumber: 1,
    retryOfAttemptId: null,
    leaseEpoch: 4,
    status: "running",
    checkpointDigest: `sha256:${"a".repeat(64)}`,
    providerCheckpoint: checkpoint,
    providerTurnState: null,
  } as const;
  const step = {
    stepId: "node-1",
    tenantId: "tenant-1",
    runId: "run-1",
    status: "running",
    currentAttemptId: attempt.attemptId,
  } as const;
  const dispatch = {
    tenantId: "tenant-1",
    runId: "run-1",
    stepId: "node-1",
    attemptId: attempt.attemptId,
    operationId: "segment:attempt-old:request:1",
    requestSequence: 1,
    operation: "dispatch",
    workItemId: attempt.workItemId,
    leaseEpoch: attempt.leaseEpoch,
    requestDigest: `sha256:${"b".repeat(64)}`,
    provider: {
      agentVersionId: "node-agent",
      adapterName: checkpoint.adapterName,
      adapterVersion: checkpoint.adapterVersion,
      modelId: checkpoint.modelId,
    },
    status: "responseObserved",
    revision: 3,
    responseCheckpointDigest: attempt.checkpointDigest,
  } as const;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: checkpoint.modelId,
      storeResponses: true,
    },
    {
      async fetch(input, init) {
        methods.push(init?.method ?? "GET");
        assert.equal(
          String(input),
          "https://provider.example/v1/responses/resp-observed",
        );
        return Response.json({
          id: "resp-observed",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "{}" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
    },
  );
  const claim = {
    workItem: {
      workItemId: "reconcile-work",
      tenantId: "tenant-1",
      runId: "run-1",
    },
    lease: { ownerId: "worker", leaseId: "lease-current", epoch: 2 },
  } as never;
  let renewals = 0;
  const execution = {
    async loadRun() {
      return { cancelRequested: false };
    },
    async recordAgentEvent() {
      throw new Error("reconciliation must not persist Agent events");
    },
    async checkpointModelAttempt() {
      throw new Error("reconciliation must not checkpoint again");
    },
    async recordProviderTurnState() {
      throw new Error("reconciliation must not mutate turn state");
    },
  } as never;
  const store = {
    async loadRunAttempt() {
      return attempt;
    },
    async loadRunStep() {
      return step;
    },
    async loadModelDispatchReceipt() {
      return dispatch;
    },
    async renewWorkItemLease() {
      renewals += 1;
    },
    async prepareModelDispatch() {
      throw new Error("GET recovery must not prepare dispatch evidence");
    },
    async markModelDispatchPossiblySent() {
      throw new Error("GET recovery must not cross a dispatch boundary");
    },
  } as never;
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    execution,
    store,
    leaseDurationMs: 30_000,
  });

  assert.deepEqual(
    await engine.reconcile({
      runtime: {
        version: {
          agentVersionId: "node-agent",
          policySnapshotId: "node-policy",
          execution: { maxToolRounds: 4 },
          tools: [],
        },
        kernel: new CrewONAgentKernel({ transport }),
      } as never,
      claim,
      binding,
      recovery: {
        claim: {
          node: agentNode(),
          claimId: "claim-1",
          claimEpoch: 1,
          gateRequestId: null,
          inputDigest: "sha256:value",
        },
        step,
        attempt,
        inputValue: {
          schemaVersion: "crewon.workflow-execution-value.v0",
          valueId: "value-1",
          value: { task: "run" },
          valueDigest: "sha256:value",
        },
        dispatch,
      } as never,
    }),
    { status: "completed", value: {} },
  );
  assert.deepEqual(methods, ["GET"]);
  assert.ok(renewals > 0);
});

test("shared engine consumes the supplied attempt and actual value without beginning another attempt", async () => {
  const calls: string[] = [];
  const claim = {
    workItem: {
      workItemId: "node-work",
      tenantId: "tenant-1",
      runId: "run-1",
    },
    lease: { ownerId: "worker", leaseId: "lease-1", epoch: 3 },
  } as never;
  const execution = {
    async loadRun() {
      return { cancelRequested: false };
    },
    async checkpointModelAttempt() {
      calls.push("checkpoint");
    },
    async recordAgentEvent() {
      calls.push("event");
      return {};
    },
    async recordProviderTurnState() {
      calls.push("turn-state");
    },
    async beginModelAttempt() {
      throw new Error("must not begin a second attempt");
    },
  } as never;
  const store = {
    async loadRunAttempt(locator: unknown) {
      assert.deepEqual(locator, {
        tenantId: "tenant-1",
        runId: "run-1",
        stepId: "step-admitted",
        attemptId: "attempt-admitted",
      });
      return {
        tenantId: "tenant-1",
        runId: "run-1",
        stepId: "step-admitted",
        attemptId: "attempt-admitted",
        workItemId: "node-work",
        leaseEpoch: 3,
        status: "running",
        attemptNumber: 7,
        providerTurnState: null,
      };
    },
    async loadRunStep() {
      return { status: "running", currentAttemptId: "attempt-admitted" };
    },
    async renewWorkItemLease() {
      calls.push("renew");
      return {};
    },
    async prepareModelDispatch() {
      throw new Error("unexpected dispatch evidence");
    },
    async markModelDispatchPossiblySent() {
      throw new Error("unexpected dispatch evidence");
    },
    async loadModelDispatchReceipt() {
      throw new Error("unexpected dispatch evidence");
    },
  } as never;
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    execution,
    store,
    leaseDurationMs: 30_000,
  });
  const node = {
    ...agentNode(),
    outputSchema: {
      type: "object" as const,
      properties: {
        answer: { type: "string" as const, maxLength: 32, enum: null },
      },
      required: ["answer"],
      additionalProperties: false as const,
    },
  };
  const outcome = await engine.execute({
    runtime: {
      version: {
        agentVersionId: "node-agent",
        policySnapshotId: "node-policy",
        execution: { maxToolRounds: 4 },
        tools: [],
      },
      kernel: {
        supportsModelDispatchEvidence: true,
        modelIdentity: {
          adapterName: "test",
          adapterVersion: "1",
          modelId: "model",
        },
        async *runSegment(contract: { history: readonly unknown[] }) {
          const inputContent = contract.history
            .filter(
              (item): item is { type: "message"; content: string } =>
                (item as { type?: string }).type === "message",
            )
            .map(
              (item) =>
                JSON.parse(item.content) as { kind: string; content: string },
            )
            .find((fragment) => fragment.kind === "inputJson")?.content;
          assert.match(inputContent ?? "", /"task":"run"/);
          yield kernelEvent(1, "segment.started", {
            attempt: 7,
            model: "model",
          });
          yield kernelEvent(2, "model.output.delta", {
            delta: '{"answer":"done"}',
          });
          yield kernelEvent(3, "segment.completed", {
            output: '{"answer":"done"}',
          });
        },
      },
      governedContext: { modelItems: () => [] },
    } as never,
    authority: {
      tenantId: "tenant-1",
      runId: "run-1",
      nodeId: "node-1",
      agentVersionId: "node-agent",
      claimId: "claim-1",
      claimEpoch: 1,
      stepId: "step-admitted",
      attemptId: "attempt-admitted",
      workItemClaim: claim,
      binding,
    },
    node,
    inputValue: {
      schemaVersion: "crewon.workflow-execution-value.v0",
      valueId: "value-1",
      value: { task: "run" },
      valueDigest: "sha256:value",
    },
  });
  assert.deepEqual(outcome, { status: "unknown" });
  assert.deepEqual(calls, ["renew", "event", "renew", "renew", "event"]);
});

test("workflow lifecycle renews a stalled segment and aborts it on durable cancel", async () => {
  let renewals = 0;
  let runLoads = 0;
  let kernelAborted = false;
  const dependencies = workflowEngineDependencies({
    loadRun: async () => ({ cancelRequested: ++runLoads >= 3 }),
    renew: async () => {
      renewals += 1;
    },
  });
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    ...dependencies,
    leaseDurationMs: 18,
  });
  const outcome = await engine.execute(
    workflowEngineInput(async function* (_contract, signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            kernelAborted = true;
            resolve();
          },
          { once: true },
        );
      });
    }),
  );
  assert.equal(kernelAborted, true);
  assert.ok(renewals > 0);
  assert.deepEqual(outcome, {
    status: "canceled",
  });
  const settledRenewals = renewals;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(renewals, settledRenewals, "heartbeat timer must be closed");
});

test("workflow heartbeat failure aborts a stalled segment without becoming canceled", async () => {
  let renewals = 0;
  let kernelAborted = false;
  const dependencies = workflowEngineDependencies({
    loadRun: async () => ({ cancelRequested: false }),
    renew: async () => {
      renewals += 1;
      throw new Error("lease_renewal_failed");
    },
  });
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    ...dependencies,
    leaseDurationMs: 18,
  });
  await assert.rejects(
    engine.execute(
      workflowEngineInput(async function* (_contract, signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              kernelAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      }),
    ),
    /lease_renewal_failed/,
  );
  assert.equal(kernelAborted, true);
  assert.equal(renewals, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(renewals, 1, "failed heartbeat timer must be closed");
});

test("workflow Direct dispatch fails closed before a kernel without evidence capability", async () => {
  let kernelCalls = 0;
  const dependencies = workflowEngineDependencies({
    loadRun: async () => ({ cancelRequested: false }),
    renew: async () => undefined,
  });
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    execution: dependencies.execution,
    store: dependencies.store,
    leaseDurationMs: 30_000,
  });
  const input = workflowEngineInput(async function* () {
    kernelCalls += 1;
  });
  const mutable = input as unknown as {
    runtime: { kernel: { supportsModelDispatchEvidence: boolean } };
  };
  mutable.runtime.kernel.supportsModelDispatchEvidence = false;
  await assert.rejects(
    engine.execute(input),
    /model_dispatch_evidence_unsupported/,
  );
  assert.equal(kernelCalls, 0);
});

test("workflow approval retry reloads unknown receipt and reconciles without executing", async () => {
  let executes = 0;
  let reconciles = 0;
  let transitions = 0;
  const approval = {
    approvalId: "approval-1",
    status: "approved",
    actionDigest: `sha256:${"a".repeat(64)}`,
    policySnapshotId: "node-policy",
    revision: 2,
    decision: {
      decidedAt: "2026-08-12T00:00:01.000Z",
    },
  } as never;
  const adoptedReceipt = {
    ...(toolReceipt("prepared") as unknown as Record<string, unknown>),
    workItemId: "approval-resume",
  };
  const currentReceipt = {
    ...adoptedReceipt,
    status: "unknownOutcome",
    revision: 2,
  };
  const authority = {
    tenantId: "tenant-1",
    runId: "run-1",
    workItemId: "approval-resume",
    leaseEpoch: 2,
    nodeId: "node-1",
    nodeKind: "agent",
    claimId: "claim-1",
    claimEpoch: 1,
    agentVersionId: "node-agent",
    attempt: { stepId: "step-admitted", attemptId: "attempt-admitted" },
  } as const;
  const run = {
    tenantId: "tenant-1",
    runId: "run-1",
    lastSequence: 1,
    cancelRequested: false,
  } as never;
  const store = {
    async loadToolApproval() {
      return approval;
    },
    async consumeWorkflowToolApproval() {
      return {
        disposition: "replay",
        outcome: {
          kind: "approved",
          approval,
          authority,
          receipt: adoptedReceipt,
        },
      };
    },
    async loadToolExecutionReceipt() {
      return currentReceipt;
    },
    async loadWorkflowNodeContinuation() {
      return {
        schemaVersion: "crewon.workflow-node-continuation.v0",
        authority,
        segmentId: "segment:attempt-admitted",
        modelSampleIndex: 0,
        toolRoundsConsumed: 0,
        providerCheckpoint: null,
        providerTurnState: null,
        activeDispatch: null,
        history: [
          {
            type: "tool_call",
            callId: "call-1",
            kind: "function",
            name: "read_file",
            input: "{}",
          },
        ],
        terminalCandidate: null,
        revision: 2,
        updatedAt: "2026-08-12T00:00:00.000Z",
      };
    },
    async listRunEvents() {
      return [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: "run-1" },
          eventId: "requested-1",
          sequence: 1,
          occurredAt: "2026-08-12T00:00:00.000Z",
          type: "tool.requested",
          data: {
            segmentId: "segment:attempt-admitted",
            segmentSequence: 1,
            callId: "call-1",
            kind: "function",
            name: "read_file",
            input: "{}",
          },
        },
      ];
    },
  } as never;
  const execution = {
    async loadRun() {
      return run;
    },
    async beginToolRecovery() {
      return {
        attempt: { stepId: "tool-step-1", attemptId: "tool-attempt-1" },
      };
    },
    async transitionToolExecution() {
      transitions += 1;
      return currentReceipt;
    },
  } as never;
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    execution,
    store,
    leaseDurationMs: 30_000,
  });
  const outcome = await engine.resumeToolApproval({
    runtime: {
      version: {
        agentVersionId: "node-agent",
        policySnapshotId: "node-policy",
        execution: { maxToolRounds: 4 },
        tools: [
          {
            kind: "function",
            name: "read_file",
          },
        ],
      },
      toolRuntime: {
        executionPolicy: () => ({
          approvalRequirement: "perAction",
        }),
        async execute() {
          executes += 1;
          throw new Error("must not execute");
        },
        async reconcile() {
          reconciles += 1;
          return { status: "unknownOutcome", providerReceiptId: null };
        },
      },
    } as never,
    claim: {
      workItem: {
        workItemId: "approval-resume",
        tenantId: "tenant-1",
        runId: "run-1",
      },
      lease: { ownerId: "worker", leaseId: "lease-2", epoch: 2 },
    } as never,
    binding,
    node: agentNode(),
    payload: {
      schemaVersion: "crewon.workflow-tool-approval-resume-work-item.v0",
      trigger: "workflowToolApprovalResume",
      binding,
      nodeId: "node-1",
      claimId: "claim-1",
      claimEpoch: 1,
      stepId: "step-admitted",
      attemptId: "attempt-admitted",
      agentVersionId: "node-agent",
      agentWorkItemId: "node-work",
      agentLeaseEpoch: 1,
      approvalId: "approval-1",
      receiptId: "receipt-1",
      actionDigest: `sha256:${"a".repeat(64)}`,
    },
  });
  assert.deepEqual(outcome, { status: "unknown" });
  assert.deepEqual(
    { executes, reconciles, transitions },
    {
      executes: 0,
      reconciles: 1,
      transitions: 0,
    },
  );
});

test("workflow executes a durable Tool sub-attempt and continues the same Agent node", async () => {
  let kernelRound = 0;
  let toolExecutions = 0;
  let committedToolAttempt = "";
  let committedToolOutput: string | null = null;
  let committedToolOutputTruncated: boolean | null = null;
  const dependencies = workflowEngineDependencies({
    loadRun: async () => ({ cancelRequested: false }),
    renew: async () => undefined,
  });
  const execution = {
    ...(dependencies.execution as unknown as Record<string, unknown>),
    async beginToolExecution() {
      return {
        disposition: "prepared",
        attempt: {
          step: {},
          abandonedAttempt: null,
          attempt: {
            stepId: "tool-step-1",
            attemptId: "tool-attempt-1",
          },
        },
        receipt: toolReceipt("prepared"),
      };
    },
    async dispatchToolExecution() {
      return toolReceipt("dispatched");
    },
  } as never;
  const store = {
    ...(dependencies.store as unknown as Record<string, unknown>),
    async commitWorkflowToolContinuation(input: {
      toolAttempt: { attemptId: string };
      receipt: Record<string, unknown>;
      next: Record<string, unknown>;
      completedEvent: {
        data: { output: string; outputTruncated: boolean };
      };
    }) {
      committedToolAttempt = input.toolAttempt.attemptId;
      committedToolOutput = input.completedEvent.data.output;
      committedToolOutputTruncated = input.completedEvent.data.outputTruncated;
      return {
        receipt: { ...input.receipt, status: "completed" },
        continuation: {
          ...input.next,
          revision: 2,
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
      };
    },
  } as never;
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    execution,
    store,
    leaseDurationMs: 30_000,
  });
  const input = workflowEngineInput(async function* (contract: unknown) {
    kernelRound += 1;
    if (kernelRound === 1) {
      yield kernelEvent(1, "segment.started", { attempt: 1, model: "model" });
      yield kernelEvent(2, "tool.requested", {
        callId: "call-1",
        kind: "function",
        name: "read_file",
        input: '{"path":"README.md"}',
      });
      return;
    }
    assert.match(JSON.stringify(contract), /tool_result/);
    const projectedHistory = (
      contract as { history: readonly Record<string, unknown>[] }
    ).history;
    const toolResult = projectedHistory.find(
      (item) => item.type === "tool_result",
    );
    assert.match(
      String(toolResult?.output),
      /bytes omitted from model context/,
    );
    assert.ok(
      projectedHistory.every(
        (item) =>
          new TextEncoder().encode(JSON.stringify(item)).length <= 10_000,
      ),
    );
    yield kernelEvent(1, "segment.started", { attempt: 1, model: "model" });
    yield kernelEvent(2, "model.output.delta", {
      delta: '{"answer":"done"}',
    });
    yield kernelEvent(3, "segment.completed", {
      output: '{"answer":"done"}',
    });
  });
  input.node = {
    ...input.node,
    outputSchema: {
      type: "object" as const,
      properties: {
        answer: { type: "string" as const, maxLength: 32, enum: null },
      },
      required: ["answer"],
      additionalProperties: false as const,
    },
  } as never;
  const baseRuntime = input.runtime as unknown as {
    kernel: unknown;
    version: Record<string, unknown>;
  };
  input.runtime = {
    kernel: baseRuntime.kernel,
    version: {
      ...baseRuntime.version,
      execution: { maxToolRounds: 4 },
      tools: [
        {
          schemaVersion: "crewon.tool-definition.v0",
          kind: "function",
          name: "read_file",
          description: "Read a file",
          execution: "serial",
          inputSchema: { type: "object" },
        },
      ],
    },
    toolRuntime: {
      executionPolicy() {
        return {
          effect: "readOnly",
          recovery: "replaySafe",
          resourceBindingId: null,
          credentialBindingId: null,
          executionTarget: { kind: "control", bindingId: "read-file" },
          capability: "workspace.read",
          approvalRequirement: "none",
          limits: {
            timeoutMs: 1_000,
            maxOutputBytes: 1_024,
            maxArtifactBytes: 1_024,
          },
        };
      },
      async execute() {
        toolExecutions += 1;
        return {
          status: "completed" as const,
          executionId: "tool-execution-1",
          providerReceiptId: "provider-receipt-1",
          result: {
            schemaVersion: "crewon.tool-result.v0" as const,
            callId: "call-1",
            output: `head-${"x".repeat(12 * 1024)}-tail`,
            isError: false,
            artifactRef: null,
          },
        };
      },
    },
  } as never;
  assert.deepEqual(await engine.execute(input), { status: "unknown" });
  assert.equal(kernelRound, 2);
  assert.equal(toolExecutions, 1);
  assert.equal(committedToolAttempt, "tool-attempt-1");
  assert.equal(committedToolOutputTruncated, true);
  assert.match(committedToolOutput ?? "", /^head-/);
  assert.match(committedToolOutput ?? "", /-tail$/);
});

test("workflow Tool round limit counts Tool batches instead of model samples", async () => {
  const pure = await runToolLimitScenario(0, 0);
  assert.equal(pure.outcome.status, "unknown");
  assert.equal(pure.toolBegins, 0);

  const zero = await runToolLimitScenario(0, 1);
  assert.deepEqual(zero.outcome, {
    status: "failed",
    failureCode: "model_tool_round_limit_exceeded",
  });
  assert.equal(zero.toolBegins, 0);

  const one = await runToolLimitScenario(1, 1);
  assert.equal(one.outcome.status, "unknown");
  assert.equal(one.toolBegins, 1);

  const exceeded = await runToolLimitScenario(1, 2);
  assert.deepEqual(exceeded.outcome, {
    status: "failed",
    failureCode: "model_tool_round_limit_exceeded",
  });
  assert.equal(exceeded.toolBegins, 1);
});

test("completed Tool receipt replay performs no recovery, execute, reconcile, or new Attempt", async () => {
  const counters = {
    recovery: 0,
    execute: 0,
    reconcile: 0,
    begins: 0,
  };
  const result = await runToolLimitScenario(1, 1, {
    completedReplay: true,
    counters,
  });
  assert.equal(result.outcome.status, "unknown");
  assert.deepEqual(counters, {
    recovery: 0,
    execute: 0,
    reconcile: 0,
    begins: 0,
  });
});

function agentNode() {
  return {
    nodeId: "node-1",
    title: "Node",
    instruction: "Complete the node.",
    kind: "agent" as const,
    agentVersionId: "node-agent",
    dependsOn: [],
    inputSchema: {
      type: "object" as const,
      properties: {
        task: { type: "string" as const, maxLength: 32, enum: null },
      },
      required: [],
      additionalProperties: false as const,
    },
    outputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
      additionalProperties: false as const,
    },
  };
}

function kernelEvent(sequence: number, type: string, data: unknown) {
  return {
    schemaVersion: "crewon.agent-event.v0" as const,
    runId: "run-1",
    segmentId: "segment:attempt-admitted",
    sequence,
    type,
    data,
  } as never;
}

function workflowEngineDependencies(input: {
  loadRun: () => Promise<{ cancelRequested: boolean }>;
  renew: () => Promise<void>;
}) {
  return {
    execution: {
      loadRun: input.loadRun,
      async recordAgentEvent() {
        return {};
      },
      async checkpointModelAttempt() {},
      async recordProviderTurnState() {},
    } as never,
    store: {
      async loadRunAttempt() {
        return {
          tenantId: "tenant-1",
          runId: "run-1",
          stepId: "step-admitted",
          attemptId: "attempt-admitted",
          workItemId: "node-work",
          leaseEpoch: 3,
          status: "running",
          attemptNumber: 1,
          providerTurnState: null,
        };
      },
      async loadRunStep() {
        return { status: "running", currentAttemptId: "attempt-admitted" };
      },
      renewWorkItemLease: input.renew,
      async prepareModelDispatch() {},
      async markModelDispatchPossiblySent() {},
      async loadModelDispatchReceipt() {},
      async commitWorkflowAssistantContinuation(input: {
        next: object;
        terminalResult: null | { status: string };
      }) {
        return {
          ...input.next,
          revision: 1,
          terminalCandidate:
            input.terminalResult === null
              ? null
              : {
                  candidateId: `sha256:${"c".repeat(64)}`,
                },
          updatedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      async commitWorkflowToolContinuation(input: {
        receipt: object;
        next: object;
      }) {
        return {
          receipt: { ...input.receipt, status: "completed" },
          continuation: {
            ...input.next,
            revision: 2,
            updatedAt: "2026-08-12T00:00:00.000Z",
          },
        };
      },
    } as never,
  };
}

function workflowEngineInput(
  runSegment: (contract: unknown, signal: AbortSignal) => AsyncIterable<never>,
) {
  return {
    runtime: {
      version: {
        agentVersionId: "node-agent",
        policySnapshotId: "node-policy",
        execution: { maxToolRounds: 4 },
        tools: [],
      },
      kernel: {
        supportsModelDispatchEvidence: true,
        modelIdentity: {
          adapterName: "test",
          adapterVersion: "1",
          modelId: "model",
        },
        runSegment,
      },
    } as never,
    authority: {
      tenantId: "tenant-1",
      runId: "run-1",
      nodeId: "node-1",
      agentVersionId: "node-agent",
      claimId: "claim-1",
      claimEpoch: 1,
      stepId: "step-admitted",
      attemptId: "attempt-admitted",
      workItemClaim: {
        workItem: {
          workItemId: "node-work",
          tenantId: "tenant-1",
          runId: "run-1",
        },
        lease: { ownerId: "worker", leaseId: "lease-1", epoch: 3 },
      } as never,
      binding,
    },
    node: agentNode(),
    inputValue: {
      schemaVersion: "crewon.workflow-execution-value.v0" as const,
      valueId: "value-1",
      value: { task: "run" },
      valueDigest: "sha256:value",
    },
  };
}

function toolReceipt(status: "prepared" | "dispatched") {
  return {
    status,
    receiptId: "receipt-1",
    tenantId: "tenant-1",
    runId: "run-1",
    stepId: "tool-step-1",
    attemptId: "tool-attempt-1",
    workItemId: "node-work",
    executionId: "tool-execution-1",
    idempotencyKey: "tool-key-1",
    actionDigest: `sha256:${"a".repeat(64)}`,
    actionIntent: {
      schemaVersion: "crewon.action-intent.v0",
      runId: "run-1",
      segmentId: "segment:attempt-admitted",
      callId: "call-1",
      tool: {
        kind: "function",
        name: "read_file",
        inputDigest: `sha256:${"b".repeat(64)}`,
      },
      effect: "readOnly",
      recovery: "replaySafe",
      policySnapshotId: "node-policy",
      workspaceBindingId: null,
      resourceBindingId: null,
      credentialBindingId: null,
      executionTarget: { kind: "control", bindingId: "read-file" },
      capability: "workspace.read",
      approvalRequirement: "none",
      limits: {
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
        maxArtifactBytes: 1_024,
      },
    },
    call: {
      segmentId: "segment:attempt-admitted",
      callId: "call-1",
      kind: "function",
      name: "read_file",
    },
  } as never;
}

async function runToolLimitScenario(
  maxToolRounds: number,
  requestedToolRounds: number,
  options?: {
    completedReplay: boolean;
    counters: {
      recovery: number;
      execute: number;
      reconcile: number;
      begins: number;
    };
  },
) {
  let modelSamples = 0;
  let toolBegins = 0;
  const dependencies = workflowEngineDependencies({
    loadRun: async () => ({ cancelRequested: false }),
    renew: async () => undefined,
  });
  const completed = {
    ...(toolReceipt("dispatched") as unknown as Record<string, unknown>),
    status: "completed",
    providerReceiptId: "provider-receipt-1",
    result: {
      output: "tool output",
      isError: false,
      artifactRef: null,
    },
  } as never;
  const execution = {
    ...(dependencies.execution as unknown as Record<string, unknown>),
    async beginToolExecution() {
      if (options?.completedReplay) {
        return {
          disposition: "existing",
          attempt: null,
          receipt: completed,
        };
      }
      toolBegins += 1;
      options && (options.counters.begins += 1);
      return {
        disposition: "prepared",
        attempt: {
          step: {},
          abandonedAttempt: null,
          attempt: {
            stepId: `tool-step-${toolBegins}`,
            attemptId: `tool-attempt-${toolBegins}`,
          },
        },
        receipt: toolReceipt("prepared"),
      };
    },
    async beginToolRecovery() {
      if (options) options.counters.recovery += 1;
      throw new Error("unexpected recovery");
    },
    async dispatchToolExecution() {
      return toolReceipt("dispatched");
    },
  } as never;
  const engine = new SharedWorkflowAdmittedAgentExecutionEngine({
    execution,
    store: dependencies.store,
    leaseDurationMs: 30_000,
  });
  const input = workflowEngineInput(async function* () {
    modelSamples += 1;
    yield kernelEvent(1, "segment.started", { attempt: 1, model: "model" });
    if (modelSamples <= requestedToolRounds) {
      yield kernelEvent(2, "tool.requested", {
        callId: `call-${modelSamples}`,
        kind: "function",
        name: "read_file",
        input: "{}",
      });
      return;
    }
    yield kernelEvent(2, "model.output.delta", { delta: "{}" });
    yield kernelEvent(3, "segment.completed", { output: "{}" });
  });
  const base = input.runtime as unknown as { kernel: unknown };
  input.runtime = {
    kernel: base.kernel,
    version: {
      agentVersionId: "node-agent",
      policySnapshotId: "node-policy",
      execution: { maxToolRounds },
      tools: [
        {
          schemaVersion: "crewon.tool-definition.v0",
          kind: "function",
          name: "read_file",
          description: "Read",
          execution: "serial",
          inputSchema: {},
        },
      ],
    },
    toolRuntime: {
      executionPolicy: () => ({
        effect: "readOnly",
        recovery: "replaySafe",
        resourceBindingId: null,
        credentialBindingId: null,
        executionTarget: { kind: "control", bindingId: "read" },
        capability: "workspace.read",
        approvalRequirement: "none",
        limits: {
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
          maxArtifactBytes: 1_024,
        },
      }),
      async execute() {
        if (options) options.counters.execute += 1;
        return toolResolution();
      },
      async reconcile() {
        if (options) options.counters.reconcile += 1;
        return toolResolution();
      },
    },
  } as never;
  return { outcome: await engine.execute(input), toolBegins };
}

function toolResolution() {
  return {
    status: "completed" as const,
    executionId: "tool-execution-1",
    providerReceiptId: "provider-receipt-1",
    result: {
      schemaVersion: "crewon.tool-result.v0" as const,
      callId: "call-1",
      output: "tool output",
      isError: false,
      artifactRef: null,
    },
  };
}
