import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import {
  AgentVersionApplicationService,
  compileAgentVersionReleaseBundle,
  type ActorContext,
  type AuthorizationPort,
} from "@crewon/application";
import { InMemoryRunStore } from "@crewon/store";

import {
  ProductionAgentVersionRunRouteResolver,
  ProductionStoreReadiness,
} from "./production-adapters.ts";
import {
  NodeSha256ContentDigester,
  StoreBackedAgentVersionAdmission,
} from "./standalone-adapters.ts";

test("production routing resolves each tenant's active default without a fixed actor", async () => {
  const store = new InMemoryRunStore();
  const version = versionFixture();
  const authorization: AuthorizationPort = {
    async authorize() {
      return { outcome: "allow" };
    },
  };
  const resolver = new ProductionAgentVersionRunRouteResolver({
    agentVersions: new AgentVersionApplicationService({ store, authorization }),
    releases: store,
    digester: new NodeSha256ContentDigester(),
    admission: new StoreBackedAgentVersionAdmission(store),
  });
  const actors = [
    actorFixture("tenant-1", "space-1"),
    actorFixture("tenant-2", "space-2"),
  ];
  for (const actor of actors) {
    await store.registerAgentVersion(
      createAgentVersionAsset({
        tenantId: actor.tenantId,
        version,
        createdAt: "2026-08-09T00:00:00Z",
      }),
    );
    await activateRelease(store, actor, version, `authority-${actor.tenantId}`);
  }

  for (const actor of actors) {
    assert.deepEqual(
      await resolver.resolveRoute({
        actor,
        threadId: `thread-${actor.tenantId}`,
        agentVersionId: null,
      }),
      {
        authorityId: `authority-${actor.tenantId}`,
        runtimeGeneration: version.runtimeGeneration,
        agentVersionId: version.agentVersionId,
        policySnapshotId: version.policySnapshotId,
        workspaceBindingId: null,
      },
    );
  }
  await store.close();
});

test("production readiness checks shared storage without one tenant's release", async () => {
  const store = new InMemoryRunStore();
  await assert.doesNotReject(new ProductionStoreReadiness(store).checkReady());
  await store.close();
});

function actorFixture(tenantId: string, spaceId: string): ActorContext {
  return {
    principalId: `principal-${tenantId}`,
    actorId: `actor-${tenantId}`,
    tenantId,
    spaceId,
  };
}

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
