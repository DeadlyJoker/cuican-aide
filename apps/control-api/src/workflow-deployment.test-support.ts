import { sharedAgentVersionRuntimeFactory } from "../../runtime-worker/src/shared-agent-version-runtime-factory.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { PostgresDomainStore } from "@crewon/store";
import { ControlApiClient } from "@crewon/control-client";
import type { WorkflowDeploymentConfiguration } from "@crewon/application";
import type {
  PublishWorkflowVersionRequest,
  WorkflowRunSnapshotResponse,
} from "@crewon/contracts";
import { compositionConfig } from "../../runtime-worker/src/runtime-composition.test-support.ts";
import {
  compileRuntimeAgentVersion,
  compileRuntimeAgentVersionRelease,
} from "../../runtime-worker/src/agent-version-release.ts";
import { activatePostgresRuntimeAgentVersionRelease } from "../../runtime-worker/src/agent-version-release-composition.ts";
import { createPostgresRuntimeWorker } from "../../runtime-worker/src/standalone-composition.ts";
import { createPostgresControlApi } from "./standalone-composition.ts";
import { StandaloneAuthorization } from "./standalone-adapters.ts";

export async function workflowDeploymentFixture(
  t: TestContext,
  options: {
    origin?: string;
    beforeModel?(role: string): Promise<void>;
    output?(
      request: Parameters<
        ReturnType<typeof compositionConfig>["transport"]["stream"]
      >[0],
    ): string;
  } = {},
) {
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL!,
    schema = `workflow_deploy_${randomUUID().replaceAll("-", "_")}`;
  const admin = new Pool({ connectionString }),
    owners: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const close of owners.reverse()) await close();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  const {
    actor,
    authorization,
    clock,
    requests,
    base,
    runtimeConfig,
    workflow,
  } = workflowDeploymentConfiguration(options);
  const activate = async (bootstrapOnly = false) =>
    activatePostgresRuntimeAgentVersionRelease({
      ...(bootstrapOnly
        ? {
            ...runtimeConfig,
            additionalAgentVersions: [],
            agentVersionDeployments: [],
          }
        : runtimeConfig),
      connectionString,
      schema,
      actor,
      authorization,
      clock,
      activationId: bootstrapOnly
        ? "activate-bootstrap-only"
        : "activate-workflow",
    });
  await activate();
  const store = await PostgresDomainStore.open({ connectionString, schema });
  owners.push(() => store.close());
  const token = "workflow-production-composition-token-with-32-bytes",
    origin = options.origin ?? "http://127.0.0.1:5175";
  const control = async (
    configuration: WorkflowDeploymentConfiguration | null = workflow,
  ) => {
    const runtime = await createPostgresControlApi({
      connectionString,
      schema,
      actor,
      defaultAgentVersionId: base.route.agentVersionId,
      workflow: configuration ?? undefined,
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "fixture-key",
      sessionToken: token,
      csrfToken: token,
      allowedOrigins: [origin],
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
      automationScanIntervalMs: null,
      artifactRetention: null,
    });
    owners.push(() => runtime.app.close());
    const baseUrl = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
    await runtime.outboxDispatcher.wake();
    return {
      runtime,
      baseUrl,
      client: new ControlApiClient({
        baseUrl,
        accessToken: token,
        csrfToken: token,
        origin,
      }),
    };
  };
  const worker = async (configuration = workflow, concurrency = 2) => {
    const tools = new InMemoryToolBroker();
    const config = { ...runtimeConfig, toolRuntime: tools };
    const runtime = await createPostgresRuntimeWorker({
      ...config,
      agentVersionRuntimeFactory: sharedAgentVersionRuntimeFactory(
        config,
        tools,
      ),
      connectionString,
      schema,
      workflow: configuration,
      workerConcurrency: concurrency,
    });
    owners.push(() => runtime.close());
    return runtime;
  };
  return {
    connectionString,
    schema,
    sql: `"${schema}"`,
    admin,
    store,
    actor,
    clock,
    authorization,
    workflow,
    runtimeConfig,
    requests,
    activate,
    control,
    worker,
    token,
    origin,
  };
}

/** Real immutable release/configuration shared by SQLite and PostgreSQL acceptance fixtures. */
export function workflowDeploymentConfiguration(
  options: {
    beforeModel?(role: string): Promise<void>;
    output?(
      request: Parameters<
        ReturnType<typeof compositionConfig>["transport"]["stream"]
      >[0],
    ): string;
  } = {},
) {
  const actor = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    actorId: "operator-1",
    principalId: "principal-1",
  };
  const authorization = new StandaloneAuthorization(actor),
    clock = { now: () => new Date().toISOString() };
  const requests: string[] = [];
  const base = compositionConfig();
  const transport = {
    ...base.transport,
    async *stream(request: Parameters<typeof base.transport.stream>[0]) {
      const value = JSON.stringify(request);
      const role = value.includes("workflow-producer-role")
        ? "agent"
        : value.includes("workflow-verifier-role")
          ? "verifier"
          : "unexpected";
      requests.push(role);
      assert.notEqual(
        role,
        "unexpected",
        "scheduler must never sample a model",
      );
      await options.beforeModel?.(role);
      const output = options.output?.(request) ?? '{"topic":"verified"}';
      const middle = Math.floor(output.length / 2);
      yield { type: "output.delta" as const, delta: output.slice(0, middle) };
      yield { type: "output.delta" as const, delta: output.slice(middle) };
      yield { type: "completed" as const, checkpoint: null };
    },
  };
  const versions = [
    compileRuntimeAgentVersion({
      ...base,
      transport,
      route: { ...base.route, agentVersionId: "agent-1" },
      agentInstructions: "workflow-producer-role",
    }),
    compileRuntimeAgentVersion({
      ...base,
      transport,
      route: { ...base.route, agentVersionId: "verifier-1" },
      agentInstructions: "workflow-verifier-role",
    }),
  ];
  const root = compileRuntimeAgentVersionRelease({ ...base, transport })
    .deployments[0]!;
  const runtimeConfig = {
    ...base,
    transport,
    additionalAgentVersions: versions,
    agentVersionDeployments: versions.map((version) => ({
      ...root,
      agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
    })),
    scanIntervalMs: 25,
    workerConcurrency: 2,
  };
  const workflow: WorkflowDeploymentConfiguration = {
    schemaVersion: "crewon.workflow-deployment.v1",
    issuer: actor,
    route: base.route,
    allowedAgentVersionIds: [
      base.route.agentVersionId,
      "agent-1",
      "verifier-1",
    ],
    maximumParallelNodes: 2,
    humanGates: [{ approvalPolicyId: "review-policy", approver: actor }],
  };
  return {
    actor,
    authorization,
    clock,
    requests,
    base,
    runtimeConfig,
    workflow,
  };
}

export function deploymentWorkflowSource(
  gate = true,
): PublishWorkflowVersionRequest {
  const schema = {
    type: "object" as const,
    properties: {
      topic: { type: "string" as const, maxLength: 128, enum: null },
    },
    required: ["topic"],
    additionalProperties: false as const,
  };
  return {
    schemaVersion: "crewon.workflow-version-source.v0",
    workflowId: gate ? "workflow-gate" : "workflow-direct",
    workflowVersionId: gate ? "workflow-gate-v1" : "workflow-direct-v1",
    name: "Deployment integration",
    description: "Synthetic model, real release and server policy",
    inputSchema: schema,
    outputSchema: schema,
    entryNodeIds: ["agent"],
    outputNodeIds: ["verify"],
    nodes: [
      {
        nodeId: "agent",
        kind: "agent",
        title: "Producer",
        instruction: "Produce JSON",
        agentVersionId: "agent-1",
        dependsOn: [],
        inputSchema: schema,
        outputSchema: schema,
      },
      ...(gate
        ? [
            {
              nodeId: "review",
              kind: "humanGate" as const,
              title: "Review",
              instruction: "Review committed input",
              approvalPolicyId: "review-policy",
              dependsOn: ["agent"],
              inputSchema: schema,
              outputSchema: schema,
            },
          ]
        : []),
      {
        nodeId: "verify",
        kind: "verification",
        title: "Verifier",
        instruction: "Verify JSON",
        verifierAgentVersionId: "verifier-1",
        dependsOn: [gate ? "review" : "agent"],
        inputSchema: schema,
        outputSchema: schema,
      },
    ],
  };
}
export async function waitWorkflow(
  client: ControlApiClient,
  runId: string,
  condition: (snapshot: WorkflowRunSnapshotResponse) => boolean,
): Promise<WorkflowRunSnapshotResponse> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const snapshot = await client.getWorkflowRunSnapshot(runId);
    if (condition(snapshot)) return snapshot;
    await setTimeout(50);
  }
  throw new Error("workflow_deployment_wait_timed_out");
}
