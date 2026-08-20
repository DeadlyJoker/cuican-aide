import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectResponsesTransport } from "@crewon/agent-responses";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import {
  ThreadApplicationService,
  WorkflowRunApplicationService,
} from "@crewon/application";
import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";

import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { createStandaloneRuntimeWorker } from "./standalone-composition.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const schema = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const normalWorkflow = workflowVersion("bootstrap-normal", "normal");
const recoveryWorkflow = workflowVersion("bootstrap-recovery", "recovery");

test("production bootstrap Direct transport completes and retrieves after Worker loss", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-bootstrap-direct-"));
  const databasePath = join(directory, "runtime.sqlite");
  let activeRuntime:
    | Awaited<ReturnType<typeof createStandaloneRuntimeWorker>>
    | undefined;
  t.after(async () => {
    if (activeRuntime !== undefined) await activeRuntime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const methods: string[] = [];
  const verifier = agentVersion("bootstrap-verifier");
  const transport = directTransport(async (_input, init) => {
    methods.push(init?.method ?? "GET");
    return responseStream("normal-response");
  });
  const config = {
    runtimeTenantId: "tenant-1",
    route: {
      authorityId: "bootstrap-authority",
      runtimeGeneration: "ts-v0",
      agentVersionId: "bootstrap-agent",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
    },
    transport,
    agentInstructions: "return an empty JSON object",
    streamMaxRetries: 0,
    maxToolRounds: 1,
    modelContextWindowTokens: 128_000,
    autoCompactAtTokens: null,
    agentVersionDeployments: [
      {
        schemaVersion: "crewon.agent-version-deployment.v0" as const,
        tenantId: "tenant-1",
        agentVersionId: verifier.agentVersionId,
        contentDigest: verifier.contentDigest,
        materializationDigest: digester.sha256(
          "bootstrap-verifier-materialization",
        ),
        authorityId: "bootstrap-verifier-authority",
        workspaceBindingId: null,
      },
    ],
    agentVersionRuntimeFactory: {
      create: ({ version }: { version: { agentVersionId: string } }) =>
        verifierRuntime(version.agentVersionId),
    },
  };
  const initial = new SqliteRunStore(databasePath, {
    workflowDigester: digester,
  });
  await initial.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: "tenant-1",
      version: verifier,
      createdAt: "2026-08-20T00:00:00.000Z",
    }),
  );
  await initial.close();
  await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    databasePath,
    actor: actor(),
    authorization: allow(),
    clock: { now: () => "2026-08-20T00:00:00.000Z" },
    activationId: "activate-bootstrap-direct",
  });

  const setup = new SqliteRunStore(databasePath, {
    workflowDigester: digester,
  });
  await new ThreadApplicationService({
    store: setup,
    authorization: allow(),
    clock: { now: () => "2026-08-20T00:00:00.000Z" },
    ids: { nextId: () => "bootstrap-thread" },
    digester,
  }).createThread(actor(), {
    kind: "thread.create",
    idempotencyKey: "bootstrap-thread",
    title: "Bootstrap",
  });
  for (const workflow of [normalWorkflow, recoveryWorkflow]) {
    await setup.workflowVersionStore(digester).registerWorkflowVersion({
      schemaVersion: "crewon.workflow-version-asset.v0",
      tenantId: "tenant-1",
      workflowId: workflow.workflowId,
      workflowVersionId: workflow.workflowVersionId,
      contentDigest: workflow.contentDigest,
      definitionJson: serializeCompiledWorkflowVersion(workflow),
      createdAt: "2026-08-20T00:00:00.000Z",
    });
  }
  let id = 0;
  const starts = new WorkflowRunApplicationService({
    store: setup,
    authorization: allow(),
    clock: { now: () => "2026-08-20T00:00:01.000Z" },
    workflowDigester: digester,
    ids: { nextId: (kind) => `bootstrap-${kind}-${++id}` },
    routeResolver: { resolveRoute: async () => config.route },
  });
  const normal = await starts.startWorkflowRun(actor(), {
    kind: "workflowRun.start",
    idempotencyKey: "normal",
    workflowVersionId: normalWorkflow.workflowVersionId,
    threadId: "bootstrap-thread",
    input: {},
  });
  await setup.close();

  activeRuntime = await openRuntime(
    config,
    databasePath,
    transport,
    "normal-worker",
  );
  await wakeUntilCompleted(activeRuntime.worker, normal.run.state.runId);
  assert.deepEqual(methods, ["POST"]);
  await activeRuntime.close();
  activeRuntime = undefined;

  const reopened = new SqliteRunStore(databasePath, {
    workflowDigester: digester,
  });
  const recovery = await new WorkflowRunApplicationService({
    store: reopened,
    authorization: allow(),
    clock: { now: () => "2026-08-20T00:00:02.000Z" },
    workflowDigester: digester,
    ids: { nextId: (kind) => `recovery-${kind}-${++id}` },
    routeResolver: { resolveRoute: async () => config.route },
  }).startWorkflowRun(actor(), {
    kind: "workflowRun.start",
    idempotencyKey: "recovery",
    workflowVersionId: recoveryWorkflow.workflowVersionId,
    threadId: "bootstrap-thread",
    input: {},
  });
  await reopened.close();

  let interrupt!: (reason: Error) => void;
  const interrupted = directTransport(async (_input, init) => {
    methods.push(init?.method ?? "GET");
    const pending = hangingCreatedResponse("recoverable-response");
    interrupt = pending.interrupt;
    return pending.response;
  });
  const crashedRuntime = await openRuntime(
    config,
    databasePath,
    interrupted,
    "crashed-worker",
  );
  await crashedRuntime.worker.wake();
  const abandonedWake = crashedRuntime.worker.wake();
  await waitForResponseObserved(databasePath, recovery.run.state.runId);
  expireWorkflowLease(databasePath, recovery.run.state.runId);

  const retrieving = directTransport(async (_input, init) => {
    methods.push(init?.method ?? "GET");
    return completedResponse("recoverable-response");
  });
  activeRuntime = await openRuntime(
    config,
    databasePath,
    retrieving,
    "recovery-worker",
  );
  await wakeUntilCompleted(activeRuntime.worker, recovery.run.state.runId);
  assert.deepEqual(methods, ["POST", "POST", "GET"]);
  interrupt(new Error("simulated crashed provider stream"));
  await abandonedWake;
  await crashedRuntime.close();
});

function workflowVersion(workflowId: string, suffix: string) {
  const agentNodeId = `agent-${suffix}`;
  const verifierNodeId = `verification-${suffix}`;
  return compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId,
      workflowVersionId: `${workflowId}-v1`,
      name: workflowId,
      description: "bootstrap Direct Responses recovery",
      inputSchema: schema,
      outputSchema: schema,
      entryNodeIds: [agentNodeId],
      outputNodeIds: [verifierNodeId],
      nodes: [
        {
          nodeId: agentNodeId,
          title: "agent",
          instruction: "return an empty JSON object",
          kind: "agent",
          agentVersionId: "bootstrap-agent",
          dependsOn: [],
          inputSchema: schema,
          outputSchema: schema,
        },
        {
          nodeId: verifierNodeId,
          title: "verification",
          instruction: "verify the empty JSON object",
          kind: "verification",
          verifierAgentVersionId: "bootstrap-verifier",
          dependsOn: [agentNodeId],
          inputSchema: schema,
          outputSchema: schema,
        },
      ],
    },
    digester,
  );
}

function agentVersion(agentVersionId: string) {
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy-1",
      instructions: null,
      model: {
        adapterName: "test",
        adapterVersion: "1",
        modelId: "model",
        contextWindowTokens: 128_000,
        autoCompactAtTokens: null,
      },
      execution: { streamMaxRetries: 0, maxToolRounds: 1 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
}

function directTransport(fetch: typeof globalThis.fetch) {
  return new DirectResponsesTransport(
    {
      endpoint: "https://provider.example/v1/responses",
      model: "provider-model",
      storeResponses: true,
    },
    { fetch },
  );
}

function verifierRuntime(agentVersionId: string) {
  const version = agentVersion(agentVersionId);
  return {
    version,
    policy: {} as never,
    toolRuntime: {
      definitions: () => [],
      executionPolicy: () => null,
      execute: async () => {
        throw new Error("tool forbidden");
      },
      reconcile: async () => {
        throw new Error("tool forbidden");
      },
    },
    kernel: {
      supportsModelDispatchEvidence: true,
      modelIdentity: {
        adapterName: "test",
        adapterVersion: "1",
        modelId: "model",
      },
      async *runSegment(
        contract: { runId: string; segmentId: string },
        _signal: AbortSignal,
        options: {
          controlSink?: Record<string, (value: unknown) => Promise<void>>;
        },
      ) {
        const evidence = {
          operationId: `${contract.segmentId}:dispatch`,
          requestSequence: 1,
          operation: "dispatch",
          requestDigest: digester.sha256("verification"),
          provider: {
            agentVersionId,
            adapterName: "test",
            adapterVersion: "1",
            modelId: "model",
          },
        };
        await options.controlSink?.modelRequestPrepared?.(evidence);
        await options.controlSink?.dispatchBoundaryCrossed?.(evidence);
        const base = {
          schemaVersion: "crewon.agent-event.v0",
          runId: contract.runId,
          segmentId: contract.segmentId,
        } as const;
        yield {
          ...base,
          sequence: 1,
          type: "segment.started",
          data: { attempt: 1, model: "model" },
        };
        yield {
          ...base,
          sequence: 2,
          type: "segment.provider_response_created",
          data: {
            checkpoint: {
              schemaVersion: "crewon.provider-checkpoint.v0",
              adapterName: "test",
              adapterVersion: "1",
              modelId: "model",
              opaquePayload: { responseId: "verification-response" },
            },
          },
        };
        yield {
          ...base,
          sequence: 3,
          type: "model.output.delta",
          data: { delta: "{}" },
        };
        yield {
          ...base,
          sequence: 4,
          type: "segment.completed",
          data: { output: "{}" },
        };
      },
    },
  } as never;
}

async function openRuntime(
  config: Record<string, unknown>,
  databasePath: string,
  transport: DirectResponsesTransport,
  ownerId: string,
) {
  return createStandaloneRuntimeWorker({
    ...config,
    transport,
    databasePath,
    scanIntervalMs: null,
    retryAfterMs: 0,
    ownerId,
    additionalAgentVersionRuntimes: [
      {
        tenantId: "tenant-1",
        runtime: verifierRuntime("bootstrap-verifier"),
      },
    ],
  } as never);
}

function actor() {
  return {
    principalId: "principal",
    actorId: "actor",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
}

function allow() {
  return { authorize: async () => ({ outcome: "allow" as const }) };
}

function responseStream(responseId: string): Response {
  const body = completedResponseBody(responseId);
  const events = [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: responseId },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 1,
      delta: "{}",
    },
    {
      type: "response.output_item.done",
      sequence_number: 2,
      item: body.output[0],
    },
    {
      type: "response.completed",
      sequence_number: 3,
      response: body,
    },
  ];
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function completedResponse(responseId: string): Response {
  return Response.json(completedResponseBody(responseId));
}

function completedResponseBody(responseId: string) {
  return {
    id: responseId,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "{}" }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function hangingCreatedResponse(responseId: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "response.created",
            sequence_number: 0,
            response: { id: responseId },
          })}\n\n`,
        ),
      );
    },
  });
  return {
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
    interrupt: (reason: Error) => controller.error(reason),
  };
}

async function waitForResponseObserved(databasePath: string, runId: string) {
  const database = new DatabaseSync(databasePath);
  try {
    for (let index = 0; index < 100; index += 1) {
      const row = database
        .prepare("SELECT status FROM model_dispatch_receipts WHERE run_id=?")
        .get(runId) as { status: string } | undefined;
      if (row?.status === "responseObserved") return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    database.close();
  }
  assert.fail("provider response checkpoint was not persisted");
}

function expireWorkflowLease(databasePath: string, runId: string) {
  const database = new DatabaseSync(databasePath);
  try {
    const result = database
      .prepare(
        "UPDATE work_items SET lease_expires_at_ms=0 WHERE run_id=? AND status='leased'",
      )
      .run(runId);
    assert.equal(result.changes, 1);
  } finally {
    database.close();
  }
}

async function wakeUntilCompleted(
  worker: { wake(): Promise<{ kind: string; runId?: string }> },
  runId: string,
) {
  const outcomes = [];
  for (let index = 0; index < 8; index += 1) {
    const outcome = await worker.wake();
    outcomes.push(outcome);
    if (outcome.kind === "completed") {
      assert.equal(outcome.runId, runId);
      return;
    }
  }
  assert.fail(`Workflow did not complete: ${JSON.stringify(outcomes)}`);
}
