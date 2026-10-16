import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  compileWorkflowVersion,
  serializeCompiledWorkflowVersion,
  reduceRunLifecycleEvent,
} from "@crewon/domain";
import {
  WorkflowDeploymentPolicy,
  captureWorkflowDeploymentConfiguration,
  type WorkflowDeploymentConfiguration,
  type WorkflowDeploymentReader,
  type WorkflowAgentVersionMetadata,
} from "./workflow-deployment-policy.ts";
import { compileAgentVersionReleaseBundle } from "./agent-version-release-application-service.ts";
import type { AgentVersionAsset } from "./agent-version-store-port.ts";
import type { AgentVersionDeployment } from "./agent-version-deployment-store-port.ts";
import { ApplicationError } from "./application-error.ts";

const digester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
function fixture() {
  const configuration: WorkflowDeploymentConfiguration = {
    schemaVersion: "crewon.workflow-deployment.v1",
    issuer: {
      tenantId: "tenant",
      spaceId: "space",
      actorId: "actor",
      principalId: "principal",
    },
    route: {
      authorityId: "authority",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy",
      workspaceBindingId: null,
      agentVersionId: "root-agent",
    },
    allowedAgentVersionIds: ["root-agent", "agent", "verifier"],
    maximumParallelNodes: 2,
    humanGates: [
      {
        approvalPolicyId: "review",
        approver: {
          tenantId: "tenant",
          spaceId: "space",
          actorId: "actor",
          principalId: "principal",
        },
      },
    ],
  };
  const assets = new Map<string, AgentVersionAsset>(),
    deployments = new Map<string, AgentVersionDeployment>(),
    metadata = new Map<string, WorkflowAgentVersionMetadata>();
  for (const id of configuration.allowedAgentVersionIds) {
    const contentDigest = digester.sha256(id);
    assets.set(id, {
      schemaVersion: "crewon.agent-version-asset.v0",
      tenantId: "tenant",
      agentVersionId: id,
      contentDigest,
      definitionJson: "{}",
      createdAt: "2026-10-16T00:00:00Z",
    });
    deployments.set(id, {
      schemaVersion: "crewon.agent-version-deployment.v0",
      tenantId: "tenant",
      agentVersionId: id,
      contentDigest,
      materializationDigest: digester.sha256(`materialization:${id}`),
      authorityId: "authority",
      workspaceBindingId: null,
      deployedAt: "2026-10-16T00:00:00Z",
    });
    metadata.set(id, {
      agentVersionId: id,
      contentDigest,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy",
      resources: { workspaceRequired: false },
    });
  }
  const bundle = compileAgentVersionReleaseBundle(
    {
      tenantId: "tenant",
      defaultAgentVersionId: "root-agent",
      deployments: [...deployments.values()].map(
        ({ deployedAt: _, ...deployment }) => deployment,
      ),
    },
    digester,
  );
  const active = {
    bundle,
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0" as const,
      tenantId: "tenant",
      releaseId: bundle.releaseId,
      activationId: "activation",
      previousReleaseId: null,
      operator: {
        principalId: "principal",
        actorId: "actor",
        spaceId: "space",
      },
      activatedAt: "2026-10-16T00:00:00Z",
    },
  };
  const reader: WorkflowDeploymentReader = {
    loadActiveRelease: async () => active,
    loadAgentVersion: async (_, id) => assets.get(id) ?? null,
    loadDeployment: async (_, id) => deployments.get(id) ?? null,
  };
  const schema = {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false as const,
  };
  const node = {
    title: "Node",
    instruction: "Return JSON",
    inputSchema: schema,
    outputSchema: schema,
  };
  const workflow = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: "workflow",
      workflowVersionId: "version",
      name: "Workflow",
      description: "Policy test",
      inputSchema: schema,
      outputSchema: schema,
      entryNodeIds: ["agent"],
      outputNodeIds: ["verify"],
      nodes: [
        {
          ...node,
          kind: "agent",
          nodeId: "agent",
          dependsOn: [],
          agentVersionId: "agent",
        },
        {
          ...node,
          kind: "humanGate",
          nodeId: "gate",
          dependsOn: ["agent"],
          approvalPolicyId: "review",
        },
        {
          ...node,
          kind: "verification",
          nodeId: "verify",
          dependsOn: ["gate"],
          verifierAgentVersionId: "verifier",
        },
      ],
    },
    digester,
  );
  const workflowVersion = {
    schemaVersion: "crewon.workflow-version-asset.v0" as const,
    tenantId: "tenant",
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-10-16T00:00:00Z",
  };
  const binding = {
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
  };
  const run = reduceRunLifecycleEvent(null, {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "root" },
    eventId: "created",
    sequence: 1,
    occurredAt: "2026-10-16T00:00:00Z",
    type: "run.created",
    data: {
      tenantId: "tenant",
      spaceId: "space",
      createdByActorId: "actor",
      threadId: "thread",
      ...configuration.route,
      purpose: "workflow",
      workflowVersionBinding: binding,
      collaborationMode: "default",
      goalBinding: null,
    },
  });
  const decode = (asset: AgentVersionAsset) =>
    metadata.get(asset.agentVersionId)!;
  return {
    configuration,
    policy: new WorkflowDeploymentPolicy(configuration, decode, digester),
    reader,
    active,
    assets,
    deployments,
    metadata,
    workflow,
    workflowVersion,
    run,
    decode,
    admission: { tenantId: "tenant", spaceId: "space", workflowVersion },
  };
}

test("Workflow policy binds active admission to actual asset, materialization and all node routes", async () => {
  const f = fixture();
  assert.deepEqual(
    await f.policy.resolveAdmissionRoute(f.admission, f.reader),
    f.configuration.route,
  );
  f.deployments.set("agent", {
    ...f.deployments.get("agent")!,
    materializationDigest: digester.sha256("other"),
  });
  await assert.rejects(f.policy.resolveAdmissionRoute(f.admission, f.reader), {
    code: "workflow_agent_not_active",
  });
});
test("retained dispatch does not consult the mutable active release and still checks current host allowlists", async () => {
  const f = fixture();
  const retained = {
    ...f.reader,
    loadActiveRelease: async (): Promise<never> => {
      throw Error("must not reread active pointer");
    },
  };
  assert.deepEqual(
    await f.policy.resolveChildRoute(f.run, f.workflow.nodes[2]!, retained),
    { ...f.configuration.route, agentVersionId: "verifier" },
  );
  const withdrawn = new WorkflowDeploymentPolicy(
    { ...f.configuration, allowedAgentVersionIds: ["root-agent", "agent"] },
    f.decode,
    digester,
  );
  await assert.rejects(
    withdrawn.resolveChildRoute(f.run, f.workflow.nodes[2]!, retained),
    { code: "workflow_agent_not_allowed" },
  );
});
for (const field of [
  "runtimeGeneration",
  "policySnapshotId",
  "workspaceRequired",
] as const)
  test(`Workflow node route refuses mismatched ${field}`, async () => {
    const f = fixture(),
      value = f.metadata.get("agent")!;
    f.metadata.set(
      "agent",
      field === "workspaceRequired"
        ? { ...value, resources: { workspaceRequired: true } }
        : { ...value, [field]: "other" },
    );
    await assert.rejects(
      f.policy.resolveAdmissionRoute(f.admission, f.reader),
      { code: "workflow_agent_route_denied" },
    );
  });
test("gate policy requires exact current principal and root issuer/route rather than same-space membership", async () => {
  const f = fixture();
  const authority = {
    tenantId: "tenant",
    spaceId: "space",
    runId: "root",
    nodeId: "gate",
    binding: f.run.workflowVersionBinding!,
    claimId: "claim",
    gateRequestId: "gate-request",
    approvalPolicyId: "review",
    inputDigest: digester.sha256("input"),
  };
  assert.deepEqual(
    await f.policy.authorizeGate(
      { run: f.run, actor: f.configuration.issuer, authority },
      f.reader,
    ),
    { outcome: "allow" },
  );
  for (const actor of [
    { ...f.configuration.issuer, principalId: "other" },
    { ...f.configuration.issuer, actorId: "other" },
  ])
    await assert.rejects(
      f.policy.authorizeGate({ run: f.run, actor, authority }, f.reader),
      { code: "workflow_gate_authorization_denied" },
    );
  await assert.rejects(
    f.policy.authorizeScheduler(
      { ...f.run, createdByActorId: "other" },
      f.reader,
    ),
    { code: "workflow_deployment_scope_denied" },
  );
});
test("configuration capture is immutable, bounded and does not execute accessor grants", () => {
  const f = fixture(),
    captured = captureWorkflowDeploymentConfiguration(f.configuration);
  assert.ok(Object.isFrozen(captured.route));
  assert.ok(Object.isFrozen(captured.humanGates[0]!.approver));
  (f.configuration.allowedAgentVersionIds as string[]).push("later");
  assert.equal(captured.allowedAgentVersionIds.includes("later"), false);
  for (const value of [
    { ...f.configuration, maximumParallelNodes: 5 },
    { ...f.configuration, allowedAgentVersionIds: [] },
    {
      ...f.configuration,
      humanGates: [
        f.configuration.humanGates[0],
        f.configuration.humanGates[0],
      ],
    },
    { ...f.configuration, permission: "allow" },
  ])
    assert.throws(
      () =>
        captureWorkflowDeploymentConfiguration(
          value as WorkflowDeploymentConfiguration,
        ),
      ApplicationError,
    );
  let calls = 0;
  const unsafe = { ...f.configuration };
  Object.defineProperty(unsafe, "route", {
    get() {
      calls++;
      return f.configuration.route;
    },
  });
  assert.throws(() => captureWorkflowDeploymentConfiguration(unsafe));
  assert.equal(calls, 0);
});
