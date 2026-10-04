import { compileAgentVersion } from "@crewon/agent-version";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
import { seedRunProgressHistory } from "./runtime-run-progress.test-support.ts";
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
  ThreadGoalApplicationService,
  TurnApplicationService,
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
import { RuntimeWorker, type RuntimeWorkerConfig } from "./runtime-worker.ts";
import type { RuntimeWorkerScheduler } from "./runtime-worker-watchers.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

export async function createFixture(
  context: TestContext,
  options: {
    backend: "sqlite" | "postgres";
    pluginCreditSettlement?: import("./plugins/plugin-credit-settlement-runtime-types.ts").PluginCreditSettlementMaintenancePort;
    runIdPrefix?: string;
    beforeInitialRun?: (input: { threadId: string; actor: import("@crewon/application").ActorContext; goals: ThreadGoalApplicationService }) => Promise<void>;
    initialPlan?: boolean;
    decorateStore?: (store: DomainStore) => DomainStore;
    storeAccessTime?: import("./runtime-authority-query.ts").AuthorityTime;
    policy?: import("@crewon/application").RunExecutionPolicyPort;
    preflightTime?: import("./runtime-authority-query.ts").AuthorityTime;
    modelSwitchCompactionResolver?: import("./model-switch-compaction.ts").PriorModelCompactionResolverPort;
    runtimeResolverFactory?: (runtime: import("./agent-version-runtime.ts").AgentVersionRuntime, store: DomainStore, shared: { transport: import("@crewon/agent-kernel").ModelTransportPort; route: import("@crewon/application").RunRoute; endpoint: string }) => import("./agent-version-runtime.ts").AgentVersionRuntimeResolverPort;
    executionBudget?: RuntimeWorkerConfig["executionBudget"];
    maxToolRounds?: number;
    queueYieldFailure?: "beforeCommit" | "afterCommit";
    observeQueueYield?: () => void;
    initialRunEventCount?: number;
    observeRunEventReads?: boolean;
    progressSaveFailure?: "beforeCommit" | "afterCommit";
    progressResetFailure?: "beforeCommit" | "afterCommit";
    afterRunEventRead?: () => Promise<void>;
    storeResponses: boolean;
    maxOutputTokens?: number;
    crashAfterCommit: boolean;
    legacyStore?: boolean;
    legacyProgressStore?: boolean;
    rejectPreviousResponse?: boolean;
    rejectPreviousResponseId?: string;
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
    modelResponseHeaders?: Readonly<Record<string, string>>;
    observeModelHeaders?: (request: { method: string | undefined; headers: import("node:http").IncomingHttpHeaders }) => void;
    modelResponseEvents?: (
      requestNumber: number,
    ) => readonly Record<string, unknown>[];
    interruptFirstStreamAfterEvents?: number;
    beforeFirstStreamInterrupted?: () => Promise<void>;
    retrievedResponse?: Record<string, unknown>;
    streamMaxRetries?: number;
    callPersistenceFailure?:
      | "beginBeforeCommit"
      | "beginAfterCommit"
      | "finishBeforeCommit"
      | "finishAfterCommit";
    usagePersistenceFailure?: "beforeCommit" | "afterCommit";
    firstUsageWithoutResponseIdentity?: boolean;
    beforeUsageRecorded?: () => Promise<void>;
    leaseDurationMs?: number;
    beforeLeaseRenew?: () => Promise<void>;
    beforeRunLoad?: () => Promise<void>;
    afterLeaseRenew?: (lease: import("@crewon/application").QueueLease) => void;
    afterProviderResponseCheckpointed?: () => Promise<void>;
    beforeAssistantSampleCommitted?: () => Promise<void>;
    afterAssistantSampleCommitted?: () => Promise<void>;
    holdFirstStream?: { entered(): void; wait: Promise<void> };
    manualCompaction?: boolean;
    checkpointPersistenceFailure?: "beforeCommit" | "afterCommit";
    beforeCompactionCommit?: () => void;
    instructions?: { value: string };
    contextLimits?: Pick<
      RuntimeWorkerConfig,
      | "maxContextItems"
      | "maxContextBytes"
      | "autoCompactAtContextItems"
      | "autoCompactAtContextBytes"
    >;
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
  const ids = { nextId: (kind: string) => `${kind}-${kind === "run" && options.runIdPrefix ? `${options.runIdPrefix}-` : ""}${++identifier}` };
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
  await options.beforeInitialRun?.({ threadId: thread.state.threadId, actor, goals: new ThreadGoalApplicationService({ store, clock, ids, digester, authorization, routeResolver: { resolveRoute: async () => route } }) });
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
    : options.initialPlan
      ? { state: (await new TurnApplicationService({ store, clock, ids, digester, authorization }).startTurn(actor, {
          kind: "turn.start", executionIntent: "plan", threadId: thread.state.threadId,
          expectedThreadRevision: threadRevision, idempotencyKey: "plan", content: "plan the remaining work",
          requestedAgentVersionId: route.agentVersionId, route, toolPermissionMode: "fullAccess",
        })).runState }
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
  if (options.initialRunEventCount) await seedRunProgressHistory({ store, clock, ids, digester, count: options.initialRunEventCount });
  const runEventReads: { afterSequence: number; limit: number }[] = [];
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
  const requestBodyDigests: string[] = [];
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
    options.observeModelHeaders?.({ method: request.method, headers: request.headers });
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
        .writeHead(200, { "content-type": "application/json", ...options.modelResponseHeaders })
        .end(JSON.stringify(options.retrievedResponse));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(400).end();
      return;
    }
    const requestBody = Buffer.concat(chunks);
    requestBodyDigests.push(createHash("sha256").update(requestBody).digest("hex"));
    requests.push(JSON.parse(requestBody.toString("utf8")));
    if (
      requests.at(-1)?.previous_response_id !== undefined &&
      requests.at(-1)?.previous_response_id ===
        (options.rejectPreviousResponseId ?? (options.rejectPreviousResponse ? "resp-tools" : undefined))
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
    response.writeHead(200, { "content-type": "text/event-stream", ...options.modelResponseHeaders });
    let sent = 0;
    for (const event of options.modelResponseEvents?.(requests.length) ??
      responseEvents(
        requests.length === 1,
        options.toolCount ?? 1,
        options.toolName,
        options.toolInput,
      )) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      if (
        requests.length === 1 &&
        ++sent === options.interruptFirstStreamAfterEvents
      ) {
        if (options.beforeFirstStreamInterrupted !== undefined)
          await options.beforeFirstStreamInterrupted();
        else
          await new Promise((resolve) => setTimeout(resolve, 20));
        response.destroy();
        return;
      }
    }
    if (requests.length === 1 && options.holdFirstStream !== undefined) {
      options.holdFirstStream.entered();
      await options.holdFirstStream.wait;
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
  let queueYieldFailure = options.queueYieldFailure;
  let crash = options.crashAfterCommit;
  let crashAfterResolved = options.crashAfterResolved ?? false;
  let settlementFailure = options.settlementFailure;
  let usagePersistenceFailure = options.usagePersistenceFailure;
  let firstUsageWithoutResponseIdentity =
    options.firstUsageWithoutResponseIdentity;
  let callPersistenceFailure = options.callPersistenceFailure;
  let checkpointPersistenceFailure = options.checkpointPersistenceFailure;
  let progressSaveFailure = options.progressSaveFailure;
  let progressResetFailure = options.progressResetFailure;
  const acknowledge = broker.acknowledgeExecutionResult.bind(broker);
  broker.acknowledgeExecutionResult = (ack) => {
    if (settlementFailure === "beforeAck") {
      settlementFailure = undefined;
      throw new Error("crash_before_result_ack");
    }
    return acknowledge(ack);
  };
  const prepared = new Map<string, PrepareToolExecutionInput["receipt"]>();
  let transport: DirectResponsesTransport;
  let worker: RuntimeWorker;
  let claimQueries = 0;
  const openWorker = () => {
    const interceptedBase = new Proxy(store, {
      get(target, key) {
        if (key === "listRunEvents" && options.observeRunEventReads)
          return async (...args: Parameters<DomainStore["listRunEvents"]>) => {
            runEventReads.push({ afterSequence: args[1], limit: args[2] });
            const events = await target.listRunEvents(...args);
            await options.afterRunEventRead?.();
            return events;
          };
        if (key === "executionProgress") {
          const progress = target.executionProgress;
          if (progress === undefined) return undefined;
          return {
            load: progress.load.bind(progress),
            ...(progress.resetForCancellation === undefined ? {} : {
              resetForCancellation: async (input: Parameters<NonNullable<typeof progress.resetForCancellation>>[0]) => {
                const failure = progressResetFailure; progressResetFailure = undefined;
                if (failure === "beforeCommit") throw new Error("progress_reset_before_commit");
                await progress.resetForCancellation!(input);
                if (failure === "afterCommit") throw new Error("progress_reset_after_commit");
              },
            }),
            save: async (input: Parameters<typeof progress.save>[0]) => {
              const failure = progressSaveFailure; progressSaveFailure = undefined;
              if (failure === "beforeCommit") throw new Error("progress_save_before_commit");
              await progress.save(input);
              if (failure === "afterCommit") throw new Error("progress_save_after_commit");
            },
          };
        }
        if (key === "compactionCheckpoints") {
          const checkpoints = target.compactionCheckpoints;
          if (checkpoints === undefined) return undefined;
          return {
            load: checkpoints.load.bind(checkpoints),
            save: async (input: Parameters<typeof checkpoints.save>[0]) => {
              const fail =
                JSON.parse(input.payload).results.length === 1
                  ? checkpointPersistenceFailure
                  : undefined;
              if (fail !== undefined) checkpointPersistenceFailure = undefined;
              if (fail === "beforeCommit")
                throw new Error("checkpoint_before_commit");
              const revision = await checkpoints.save(input);
              if (fail === "afterCommit")
                throw new Error("checkpoint_after_commit");
              return revision;
            },
          };
        }
        if (key === "commitContextCompaction")
          return (
            input: Parameters<DomainStore["commitContextCompaction"]>[0],
          ) => {
            options.beforeCompactionCommit?.();
            return target.commitContextCompaction(input);
          };
        if (key === "appendRunProgressEvents" && options.legacyProgressStore)
          return undefined;
        if (key === "claimNextWorkItem")
          return (input: Parameters<DomainStore["claimNextWorkItem"]>[0]) => {
            claimQueries++;
            return target.claimNextWorkItem(input);
          };
        if (key === "loadRun")
          return async (input: Parameters<DomainStore["loadRun"]>[0]) => {
            await options.beforeRunLoad?.();
            return target.loadRun(input);
          };
        if (key === "renewWorkItemLease")
          return async (
            input: Parameters<DomainStore["renewWorkItemLease"]>[0],
          ) => {
            await options.beforeLeaseRenew?.();
            const lease = await target.renewWorkItemLease(input);
            options.afterLeaseRenew?.(lease);
            return lease;
          };
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
            const recorded = firstUsageWithoutResponseIdentity
              ? {
                  ...input,
                  record: {
                    ...input.record,
                    observation: {
                      ...input.record.observation,
                      providerResponseId: null,
                    },
                  },
                }
              : input;
            firstUsageWithoutResponseIdentity = false;
            const result = await target.recordModelUsage(recorded);
            if (usagePersistenceFailure === "afterCommit") {
              usagePersistenceFailure = undefined;
              throw new Error("usage_store_response_lost");
            }
            return result;
          };
        if (key === "retryWorkItem")
          return recordRetry(async (input: Parameters<DomainStore["retryWorkItem"]>[0]) => {
            const yielding = input.reasonCode === "run_execution_yield";
            if (yielding) options.observeQueueYield?.();
            if (yielding && queueYieldFailure === "beforeCommit") {
              queueYieldFailure = undefined;
              throw new Error("queue_yield_before_commit");
            }
            await target.retryWorkItem(input);
            if (yielding && queueYieldFailure === "afterCommit") {
              queueYieldFailure = undefined;
              throw new Error("queue_yield_after_commit");
            }
          });
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
    const intercepted = options.decorateStore?.(interceptedBase) ?? interceptedBase;
    transport = new DirectResponsesTransport({
      endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
      model: "fixture-model",
      storeResponses: options.storeResponses,
      maxOutputTokens: options.maxOutputTokens,
    });
    const kernel = new CrewONAgentKernel({
      transport,
      instructions: options.instructions?.value ?? "stable instructions",
      toolCatalog: options.toolRuntime ?? broker,
      streamMaxRetries: options.streamMaxRetries ?? 0,
    });
    const policy = options.policy ?? new PinnedRunExecutionPolicy(route);
    const toolRuntime = options.toolRuntime ?? broker;
    const agentVersionRuntimeResolver = options.runtimeResolverFactory?.({
      version: compileAgentVersion({
        schemaVersion: "crewon.agent-version-source.v0",
        agentVersionId: route.agentVersionId,
        runtimeGeneration: route.runtimeGeneration,
        policySnapshotId: route.policySnapshotId,
        instructions: options.instructions?.value ?? "stable instructions",
        model: { ...kernel.modelIdentity, ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }), contextWindowTokens: 273000, autoCompactAtTokens: 200000 },
        execution: { streamMaxRetries: options.streamMaxRetries ?? 0, maxToolRounds: options.maxToolRounds ?? 32 },
        resources: { workspaceRequired: false, governedContextDigest: options.governedContext === undefined ? null : digester.sha256(JSON.stringify(options.governedContext.modelItems())) },
        tools: toolRuntime.definitions(),
      }, digester),
      executionAuthority: "crewonKernel",
      kernel,
      policy,
      toolRuntime,
      contextCompactor: new KernelContextCompactor(kernel),
      ...(options.governedContext === undefined ? {} : { governedContext: options.governedContext }),
    }, store, { transport, route, endpoint: `http://127.0.0.1:${address.port}/v1/responses` });
    worker = new RuntimeWorker(
      {
        store: intercepted,
        pluginCreditSettlement: options.pluginCreditSettlement,
        storeAccessTime: options.storeAccessTime,
        preflightTime: options.preflightTime,
        execution: new RunExecutionService({
          store: intercepted,
          clock,
          ids,
          digester,
        }),
        kernel,
        toolRuntime,
        policy,
        agentVersionRuntimeResolver,
        modelSwitchCompactionResolver: options.modelSwitchCompactionResolver,
        governedContext: options.governedContext,
        artifacts: options.artifacts,
      },
      {
        ownerId: "worker",
        nextLeaseId: () => ids.nextId("lease"),
        leaseDurationMs: options.leaseDurationMs ?? 10000,
        retryAfterMs: options.retryAfterMs ?? 0,
        cancellationScheduler: options.cancellationScheduler,
        scanIntervalMs: null,
        executionBudget: options.executionBudget,
        maxToolRounds: options.maxToolRounds,
        ...options.contextLimits,
        afterProviderResponseCheckpointed:
          options.afterProviderResponseCheckpointed,
        beforeAssistantSampleCommitted: options.beforeAssistantSampleCommitted,
        afterAssistantSampleCommitted: options.afterAssistantSampleCommitted,
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
    fixtureScope: { actor, route, clock, ids, digester, authorization },
    store: () => store,
    advanceClock: () => { storageTime += 2000; },
    runEventReads,
    executionProgressCount: storage.executionProgressCount,
    corruptExecutionProgress: storage.corruptExecutionProgress,
    encodedToolResultCount: storage.encodedToolResultCount,
    canonicalToolOutputCounts: storage.canonicalToolOutputCounts,
    breakEncodedToolResult: storage.breakEncodedToolResult,
    receiptStorageSummary: storage.receiptStorageSummary,
    compactionCheckpointCount: storage.compactionCheckpointCount,
    failCompactionRetirement: storage.failCompactionRetirement,
    corruptCompactionCheckpoint: storage.corruptCompactionCheckpoint,
    requests,
    requestBodyDigests,
    claimQueries: () => claimQueries,
    accountingReport: () =>
      storage.accountingReport({
        tenantId: actor.tenantId,
        runId: run.state.runId,
      }),
    canRetireArtifact: (candidate: ArtifactRetentionCandidate) =>
      store.canRetireArtifact(candidate),
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
    makeDue: async (target: { runId: string } = { runId: run.state.runId }) => {
      storageTime += 2_000;
      await storage.makePendingWorkDue(target.runId);
    },
    expireLease: async () => {
      storageTime += options.leaseDurationMs ?? 10000;
      await storage.expireWorkItemLease(run.state.runId);
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
      return await new RunApplicationService({
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
import type {
  ArtifactRetentionCandidate,
  ToolOutputArtifactPort,
} from "@crewon/application";
