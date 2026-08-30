import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import {
  AgentVersionApplicationService,
  ApplicationError,
  compileAgentVersionReleaseBundle,
  type ActorContext,
} from "@crewon/application";
import { InMemoryRunStore } from "@crewon/store";

import {
  AdmittedAgentVersionRunRouteResolver,
  NodeSha256ContentDigester,
  StandaloneAuthorization,
  StoreReadiness,
  StoreBackedAgentVersionAdmission,
} from "./standalone-adapters.ts";

test("admits only the exact tenant-scoped durable deployment", async () => {
  const version = versionFixture();
  const store = new InMemoryRunStore();
  const admission = new StoreBackedAgentVersionAdmission(store);
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };

  assert.deepEqual(await admission.evaluate({ actor, version }), {
    outcome: "deny",
    reasonCode: "agent_version_not_deployed",
  });
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: actor.tenantId,
      version,
      createdAt: "2026-08-09T00:00:00Z",
    }),
  );
  await activateRelease(store, actor, version, "authority-1");
  assert.deepEqual(await admission.evaluate({ actor, version }), {
    outcome: "allow",
    authorityId: "authority-1",
    workspaceBindingId: null,
  });
  assert.deepEqual(
    await admission.evaluate({
      actor: { ...actor, tenantId: "tenant-2" },
      version,
    }),
    { outcome: "deny", reasonCode: "agent_version_not_deployed" },
  );
  await store.close();
});

test("resolves the omitted default through the same durable admission", async () => {
  const store = new InMemoryRunStore();
  const version = versionFixture();
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
  const resolver = new AdmittedAgentVersionRunRouteResolver({
    actor,
    defaultAgentVersionId: version.agentVersionId,
    agentVersions: new AgentVersionApplicationService({
      store,
      authorization: new StandaloneAuthorization(actor),
    }),
    digester: new NodeSha256ContentDigester(),
    admission: new StoreBackedAgentVersionAdmission(store),
  });
  const readiness = new StoreReadiness(store, {
    tenantId: actor.tenantId,
    defaultAgentVersionId: version.agentVersionId,
  });

  await assert.rejects(
    readiness.checkReady(),
    (error) =>
      error instanceof Error &&
      error.message === "control_default_agent_version_not_released",
  );
  await assert.rejects(
    resolver.resolveRoute({
      actor,
      threadId: "thread-1",
      agentVersionId: null,
    }),
    (error) =>
      error instanceof ApplicationError &&
      error.code === "agent_version_not_found",
  );
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: actor.tenantId,
      version,
      createdAt: "2026-08-09T00:00:00Z",
    }),
  );
  await activateRelease(store, actor, version, "durable-authority");

  const expected = {
    authorityId: "durable-authority",
    runtimeGeneration: version.runtimeGeneration,
    agentVersionId: version.agentVersionId,
    policySnapshotId: version.policySnapshotId,
    workspaceBindingId: null,
  };
  assert.deepEqual(
    await resolver.resolveRoute({
      actor,
      threadId: "thread-1",
      agentVersionId: null,
    }),
    expected,
  );
  assert.deepEqual(
    await resolver.resolveRoute({
      actor,
      threadId: "thread-1",
      agentVersionId: version.agentVersionId,
    }),
    expected,
  );
  await assert.doesNotReject(readiness.checkReady());
  await store.close();
});

function versionFixture() {
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "agent-version-1",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy-1",
      instructions: null,
      model: {
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "model-1",
        contextWindowTokens: 128_000,
        autoCompactAtTokens: 96_000,
      },
      execution: { streamMaxRetries: 2, maxToolRounds: 16 },
      resources: {
        workspaceRequired: false,
        governedContextDigest: null,
      },
      tools: [],
    },
    { sha256 },
  );
}

async function activateRelease(
  store: InMemoryRunStore,
  actor: ActorContext,
  version: ReturnType<typeof versionFixture>,
  authorityId: string,
): Promise<void> {
  const bundle = compileAgentVersionReleaseBundle(
    {
      tenantId: actor.tenantId,
      defaultAgentVersionId: version.agentVersionId,
      deployments: [
        {
          schemaVersion: "crewon.agent-version-deployment.v0",
          tenantId: actor.tenantId,
          agentVersionId: version.agentVersionId,
          contentDigest: version.contentDigest,
          materializationDigest: `sha256:${"b".repeat(64)}`,
          authorityId,
          workspaceBindingId: null,
        },
      ],
    },
    { sha256 },
  );
  await store.activateAgentVersionRelease({
    bundle,
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: actor.tenantId,
      releaseId: bundle.releaseId,
      activationId: `activation-${authorityId}`,
      previousReleaseId: null,
      operator: {
        principalId: actor.principalId,
        actorId: actor.actorId,
        spaceId: actor.spaceId,
      },
      activatedAt: "2026-08-09T00:00:00Z",
    },
    expectedActiveReleaseId: null,
  });
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
