import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { type TestContext } from "node:test";
import { CrewONAgentKernel } from "@crewon/agent-kernel";
import { DirectResponsesTransport } from "@crewon/agent-responses";
import type { GovernedContextBundle } from "@crewon/context";
import {
  RunApplicationService,
  RunExecutionService,
  ThreadApplicationService,
  ThreadCompactionApplicationService,
  type CommitToolSampleInput,
  type DomainStore,
  type PrepareToolExecutionInput,
  type TransitionToolExecutionInput,
  type RecordModelUsageInput,
  type RecordModelCallInput,
} from "@crewon/application";
import {
  InMemoryToolBroker,
  ToolResultCapacity,
  ToolExecutionUnknownOutcomeError,
  ToolBrokerError,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import { createContextTestStorage } from "./runtime-model-context.test-support.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import type { RuntimeWorkerScheduler } from "./runtime-worker-watchers.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

export async function createFixture(
  context: TestContext,
  options: {
    backend: "sqlite" | "postgres";
    storeResponses: boolean;
    crashAfterCommit: boolean;
    legacyStore?: boolean;
    rejectPreviousResponse?: boolean;
    resultCapacity?: ToolResultCapacity;
    crashAfterResolved?: boolean;
    unknownOutcome?: boolean;
    toolCount?: number;
    execution?: "serial" | "parallel";
    holdResult?: { entered(): void; wait: Promise<void> };
    output?: string;
    settlementFailure?: "beforeCommit" | "afterCommit" | "beforeAck";
    unknownReconciliationOnce?: boolean;
    toolRuntime?: ToolRuntimePort;
    toolName?: string;
    toolInput?: string;
    afterToolProviderResolved?: () => Promise<void>;
    providerFailure?: boolean;
    retryAfterMs?: number;
    cancellationScheduler?: RuntimeWorkerScheduler;
    modelResponseEvents?: (
      requestNumber: number,
    ) => readonly Record<string, unknown>[];
    interruptFirstStreamAfterEvents?: number;
    retrievedResponse?: Record<string, unknown>;
    streamMaxRetries?: number;
    callPersistenceFailure?:
      | "beginBeforeCommit"
      | "beginAfterCommit"
      | "finishBeforeCommit"
      | "finishAfterCommit";
    usagePersistenceFailure?: "beforeCommit" | "afterCommit";
    beforeUsageRecorded?: () => Promise<void>;
    manualCompaction?: boolean;
    initialMessages?: readonly {
      role: "user" | "assistant";
      content: string;
    }[];
    governedContext?: GovernedContextBundle;
    artifacts?: ToolOutputArtifactPort;
  },
) {
  let storageTime = Date.parse("2026-08-08T01:00:00Z");
  const storage = await createContextTestStorage(context, options.backend, {
    nowEpochMilliseconds: () => storageTime,
  });
  let store: DomainStore = storage.store;
  let identifier = 0;
  let instant = Date.parse("2026-08-08T00:00:00Z");
  const ids = { nextId: (kind: string) => `${kind}-${++identifier}` };
  const clock = { now: () => new Date((instant += 1000)).toISOString() };
  const digester = {
    sha256: (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  const actor = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    actorId: "actor-1",
    principalId: "principal-1",
  };
  const route = {
    authorityId: "standalone-1",
    runtimeGeneration: "ts-v0",
    agentVersionId: "agent-version-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  };
  const threads = new ThreadApplicationService({
    store,
    clock,
    ids,
    digester,
    authorization,
  });
  const thread = await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "create",
    title: null,
  });
  let threadRevision = thread.state.revision;
  for (const [index, message] of (
    options.initialMessages ?? [
      { role: "user", content: "stable user context ".repeat(1000) },
    ]
  ).entries()) {
    const appended = await threads.appendMessage(actor, {
      kind: "thread.message.append",
      threadId: thread.state.threadId,
      idempotencyKey: index === 0 ? "message" : `message-${index}`,
      expectedRevision: threadRevision,
      ...message,
    });
    threadRevision = appended.state.revision;
  }
  const run = options.manualCompaction
    ? await new ThreadCompactionApplicationService({
        store,
        clock,
        ids,
        authorization,
      }).start(actor, {
        kind: "thread.compact",
        threadId: thread.state.threadId,
        expectedThreadRevision: threadRevision,
        idempotencyKey: "compact",
        requestedAgentVersionId: route.agentVersionId,
        route,
      })
    : await new RunApplicationService({
        store,
        clock,
        ids,
        authorization,
      }).createRun(actor, {
        kind: "run.create",
        threadId: thread.state.threadId,
        idempotencyKey: "run",
        route,
        toolPermissionMode: "fullAccess",
      });
  let executed = 0;
  const broker = new InMemoryToolBroker(
    [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "function",
        name: "fixture_tool",
        description: "Fixture",
        execution: options.execution ?? "serial",
        inputSchema: { type: "object" },
      },
    ],
    new Map([
      [
        "function:fixture_tool",
        async () => {
          executed += 1;
          if (options.providerFailure)
            throw new ToolBrokerError("provider_write_failed", {
              cause: "x".repeat(1024 * 1024),
            });
          if (options.unknownOutcome)
            throw new ToolExecutionUnknownOutcomeError();
          return { output: options.output ?? "tool-result" };
        },
      ],
    ]),
    new Map([
      [
        "function:fixture_tool",
        {
          effect: "mutation",
          recovery: "reconcilable",
          resourceBindingId: null,
          credentialBindingId: null,
          executionTarget: {
            kind: "control",
            bindingId: "in-memory-tool-broker",
          },
          capability: "workspace.write",
          approvalRequirement: "none",
          limits: {
            timeoutMs: 30000,
            maxOutputBytes: 256 * 1024,
            maxArtifactBytes: 1024 * 1024,
          },
        },
      ],
    ]),
    { resultCapacity: options.resultCapacity },
  );
  const requests: Record<string, unknown>[] = [];
  let retrievals = 0;
  let unknownReconciliation = options.unknownReconciliationOnce ?? false;
  const reconcile = broker.reconcile.bind(broker);
  broker.reconcile = (command, signal) => {
    if (unknownReconciliation) {
      unknownReconciliation = false;
      return Promise.resolve({
        status: "unknownOutcome",
        executionId: command.executionId,
        providerReceiptId: null,
      });
    }
    return reconcile(command, signal);
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 128 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    if (request.method === "GET" && options.retrievedResponse !== undefined) {
      retrievals += 1;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(options.retrievedResponse));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(400).end();
      return;
    }
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (
      options.rejectPreviousResponse &&
      requests.at(-1)?.previous_response_id === "resp-tools"
    ) {
      response.writeHead(404, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: {
            code: "previous_response_not_found",
            param: "previous_response_id",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    let sent = 0;
    for (const event of options.modelResponseEvents?.(requests.length) ??
      responseEvents(
        requests.length === 1,
        options.toolCount ?? 1,
        options.toolName,
        options.toolInput,
      )) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      if (requests.length === 1 && ++sent === options.interruptFirstStreamAfterEvents) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        response.destroy();
        return;
      }
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const sampleCommits: CommitToolSampleInput[] = [];
  const retryDelays: number[] = [];
  const recordRetry =
    <T extends { retryAfterMs: number }, R>(operation: (input: T) => R) =>
    (input: T): R => {
      retryDelays.push(input.retryAfterMs);
      return operation(input);
    };
  let crash = options.crashAfterCommit;
  let crashAfterResolved = options.crashAfterResolved ?? false;
  let settlementFailure = options.settlementFailure;
  let usagePersistenceFailure = options.usagePersistenceFailure;
  let callPersistenceFailure = options.callPersistenceFailure;
  const acknowledge = broker.acknowledgeExecutionResult.bind(broker);
  broker.acknowledgeExecutionResult = (ack) => {
    if (settlementFailure === "beforeAck") {
      settlementFailure = undefined;
      throw new Error("crash_before_result_ack");
    }
    acknowledge(ack);
  };
  const prepared = new Map<string, PrepareToolExecutionInput["receipt"]>();
  let transport: DirectResponsesTransport;
  let worker: RuntimeWorker;
  const openWorker = () => {
    const intercepted = new Proxy(store, {
      get(target, key) {
        if (key === "recordModelCall")
          return async (input: RecordModelCallInput) => {
            const stage =
              input.record.observation.outcome === "unknown"
                ? "begin"
                : "finish";
            if (callPersistenceFailure === `${stage}BeforeCommit`) {
              callPersistenceFailure = undefined;
              throw new Error("call_store_write_failed");
            }
            const result = await target.recordModelCall(input);
            if (callPersistenceFailure === `${stage}AfterCommit`) {
              callPersistenceFailure = undefined;
              throw new Error("call_store_response_lost");
            }
            return result;
          };
        if (key === "recordModelUsage")
          return async (input: RecordModelUsageInput) => {
            await options.beforeUsageRecorded?.();
            if (usagePersistenceFailure === "beforeCommit") {
              usagePersistenceFailure = undefined;
              throw new Error("usage_store_write_failed");
            }
            const result = await target.recordModelUsage(input);
            if (usagePersistenceFailure === "afterCommit") {
              usagePersistenceFailure = undefined;
              throw new Error("usage_store_response_lost");
            }
            return result;
          };
        if (key === "retryWorkItem")
          return recordRetry(target.retryWorkItem.bind(target));
        if (key === "retryRunAttempt")
          return recordRetry(target.retryRunAttempt.bind(target));
        if (key === "commitToolExecutionUnknownOutcome")
          return recordRetry(
            target.commitToolExecutionUnknownOutcome.bind(target),
          );
        if (key === "transitionToolExecution")
          return async (input: TransitionToolExecutionInput) => {
            if (
              input.transition.kind === "complete" &&
              settlementFailure === "beforeCommit"
            ) {
              settlementFailure = undefined;
              throw new Error("crash_before_cancellation_settlement");
            }
            const receipt = await target.transitionToolExecution(input);
            if (
              input.transition.kind === "complete" &&
              settlementFailure === "afterCommit"
            ) {
              settlementFailure = undefined;
              throw new Error("crash_after_cancellation_settlement");
            }
            return receipt;
          };
        if (key === "prepareToolExecution")
          return async (input: PrepareToolExecutionInput) => {
            const receipt = await target.prepareToolExecution(input);
            prepared.set(receipt.receiptId, receipt);
            return receipt;
          };
        if (key === "commitToolSample" && options.legacyStore) return undefined;
        if (key === "commitToolSample")
          return async (input: CommitToolSampleInput) => {
            assert.ok(target.commitToolSample !== undefined);
            const committed = await target.commitToolSample(input);
            sampleCommits.push(structuredClone(input));
            if (crash) {
              crash = false;
              throw new Error("crash_after_tool_sample_commit");
            }
            return committed;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    transport = new DirectResponsesTransport({
      endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
      model: "fixture-model",
      storeResponses: options.storeResponses,
    });
    worker = new RuntimeWorker(
      {
        store: intercepted,
        execution: new RunExecutionService({
          store: intercepted,
          clock,
          ids,
          digester,
        }),
        kernel: new CrewONAgentKernel({
          transport,
          instructions: "stable instructions",
          toolCatalog: options.toolRuntime ?? broker,
          streamMaxRetries: options.streamMaxRetries ?? 0,
        }),
        toolRuntime: options.toolRuntime ?? broker,
        policy: new PinnedRunExecutionPolicy(route),
        governedContext: options.governedContext,
        artifacts: options.artifacts,
      },
      {
        ownerId: "worker",
        nextLeaseId: () => ids.nextId("lease"),
        leaseDurationMs: 10000,
        retryAfterMs: options.retryAfterMs ?? 0,
        cancellationScheduler: options.cancellationScheduler,
        scanIntervalMs: null,
        afterToolProviderResolved: async () => {
          await options.afterToolProviderResolved?.();
          if (options.holdResult !== undefined) {
            options.holdResult.entered();
            await options.holdResult.wait;
          }
          if (crashAfterResolved) {
            crashAfterResolved = false;
            throw new Error("crash_after_provider_result");
          }
        },
      },
    );
  };
  openWorker();
  context.after(async () => {
    await worker.close();
    transport.releaseRun(run.state.runId);
  });
  return {
    requests,
    accountingReport: () => storage.accountingReport({ tenantId: actor.tenantId, runId: run.state.runId }),
    canRetireArtifact: (candidate: ArtifactRetentionCandidate) => store.canRetireArtifact(candidate),
    callRecords: () =>
      store.listModelCalls({
        tenantId: actor.tenantId,
        runId: run.state.runId,
        afterOrder: 0,
        limit: 128,
      }),
    retrievals: () => retrievals,
    usageRecords: () =>
      store.listModelUsage({
        tenantId: actor.tenantId,
        runId: run.state.runId,
        afterOrder: 0,
        limit: 128,
      }),
    sampleCommits,
    retryDelays,
    broker,
    worker: () => worker,
    executions: () => executed,
    run: () =>
      store.loadRun({ tenantId: actor.tenantId, runId: run.state.runId }),
    history: () =>
      store.listModelHistoryItems(
        { tenantId: actor.tenantId, threadId: thread.state.threadId },
        0,
        100,
      ),
    makeDue: async () => {
      storageTime += 2_000;
      await storage.makePendingWorkDue(run.state.runId);
    },
    receipts: () =>
      Promise.all(
        [...prepared.values()].map((receipt) =>
          store.loadToolExecutionReceipt({
            tenantId: actor.tenantId,
            runId: run.state.runId,
            receiptId: receipt.receiptId,
          }),
        ),
      ),
    toolAttempts: () =>
      Promise.all(
        [...prepared.values()].map((receipt) =>
          store.listRunAttempts(
            {
              tenantId: actor.tenantId,
              runId: run.state.runId,
              stepId: receipt.stepId,
            },
            0,
            100,
          ),
        ),
      ),
    cancel: async () => {
      const current = await store.loadRun({
        tenantId: actor.tenantId,
        runId: run.state.runId,
      });
      assert.ok(current !== null);
      await new RunApplicationService({
        store,
        clock,
        ids,
        authorization,
      }).transitionRun(actor, {
        kind: "run.requestCancel",
        runId: current.runId,
        expectedRevision: current.revision,
        idempotencyKey: "cancel-capacity",
      });
    },
    reopen: async () => {
      await worker.close();
      transport.releaseRun(run.state.runId);
      store = await storage.open();
      openWorker();
    },
    events: () =>
      store.listRunEvents(
        { tenantId: actor.tenantId, runId: run.state.runId },
        0,
        100,
      ),
    nextUserTurn: async () => {
      const state = await store.loadThreadInSpace({
        tenantId: actor.tenantId,
        threadId: thread.state.threadId,
        spaceId: actor.spaceId,
      });
      assert.ok(state !== null);
      await new ThreadApplicationService({
        store,
        clock,
        ids,
        digester,
        authorization,
      }).appendMessage(actor, {
        kind: "thread.message.append",
        threadId: thread.state.threadId,
        idempotencyKey: "next-message",
        expectedRevision: state.revision,
        role: "user",
        content: "next user turn",
      });
      await new RunApplicationService({
        store,
        clock,
        ids,
        authorization,
      }).createRun(actor, {
        kind: "run.create",
        threadId: thread.state.threadId,
        idempotencyKey: "next-run",
        route,
        toolPermissionMode: "fullAccess",
      });
    },
  };
}

function responseEvents(
  tools: boolean,
  toolCount = 1,
  toolName = "fixture_tool",
  toolInput = "{}",
) {
  const id = tools ? "resp-tools" : "resp-answer";
  const text = tools ? "checking" : "done";
  const message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
  const calls = Array.from({ length: toolCount }, (_, index) => ({
    type: "function_call",
    call_id: `call-${index + 1}`,
    name: toolName,
    arguments: toolInput,
  }));
  const events: Record<string, unknown>[] = [
    { type: "response.created", sequence_number: 0, response: { id } },
    { type: "response.output_text.delta", sequence_number: 1, delta: text },
    { type: "response.output_item.done", sequence_number: 2, item: message },
  ];
  if (tools)
    for (const call of calls)
      events.push({
        type: "response.output_item.done",
        sequence_number: events.length,
        item: call,
      });
  events.push({
    type: "response.completed",
    sequence_number: events.length,
    response: {
      id,
      status: "completed",
      output: tools ? [message, ...calls] : [message],
      usage: {
        input_tokens: 2048,
        output_tokens: 2,
        total_tokens: 2050,
        input_tokens_details: { cached_tokens: 1024 },
      },
    },
  });
  return events;
}
import type { ArtifactRetentionCandidate, ToolOutputArtifactPort } from "@crewon/application";
