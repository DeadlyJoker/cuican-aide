import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  compileAgentVersion,
  createAgentVersionAsset,
  parseAgentVersionAsset,
} from "@crewon/agent-version";
import {
  compileAgentVersionReleaseBundle,
  type ActorContext,
  type AgentVersionReleaseStore,
  type AgentVersionStore,
} from "@crewon/application";
import { projectAgentVersion } from "./agent-version-projection.ts";

const digester = {
  sha256: (input: string) =>
    `sha256:${createHash("sha256").update(input).digest("hex")}`,
};
const at = "2026-10-04T00:00:00.000Z";

/** A named, zero-tool catalog fixture for the original App's read-only connect prerequisite.
 * No Worker/model is materialized. The original paid Agent asset, deployment and history stay intact;
 * this catalog is not evidence that either staged generation/query can execute. */
export async function seedOriginalAppCatalog(
  store: AgentVersionStore & AgentVersionReleaseStore,
  actor: ActorContext,
) {
  const previous = await store.loadActiveAgentVersionRelease({
    tenantId: actor.tenantId,
  });
  assert.ok(previous, "the named historical release must already exist");
  const previousAssetLocator = {
    tenantId: actor.tenantId,
    agentVersionId: previous.bundle.defaultAgentVersionId,
  };
  const previousAsset = await store.loadAgentVersion(previousAssetLocator);
  assert.ok(previousAsset);
  const version = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "named-main-original-app-catalog",
      runtimeGeneration: "named-main-original-app-catalog-generation",
      policySnapshotId: "named-main-original-app-catalog-policy",
      instructions:
        "Named read-only UI catalog fixture. No Worker, provider or execution is configured.",
      model: {
        adapterName: "named-ui-catalog-fixture",
        adapterVersion: "1",
        modelId: "named-ui-catalog-no-provider",
        contextWindowTokens: 4096,
        autoCompactAtTokens: null,
      },
      execution: { streamMaxRetries: 0, maxToolRounds: 1 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
  assert.notEqual(version.agentVersionId, previousAsset.agentVersionId);
  const asset = createAgentVersionAsset({
    tenantId: actor.tenantId,
    version,
    createdAt: at,
  });
  const registered = await store.registerAgentVersion(asset);
  assert.deepEqual(parseAgentVersionAsset(registered.asset, digester), version);
  assert.equal(
    projectAgentVersion(registered.asset, digester).contentDigest,
    version.contentDigest,
  );
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
          materializationDigest: digester.sha256(
            JSON.stringify({
              schemaVersion:
                "crewon.named-ui-catalog-fixture-materialization.v1",
              agentVersionId: version.agentVersionId,
              contentDigest: version.contentDigest,
              purpose: "original-app-catalog-read-only-fixture",
            }),
          ),
          authorityId: "named-main-ui-catalog-fixture-authority",
          workspaceBindingId: null,
        },
      ],
    },
    digester,
  );
  const result = await store.activateAgentVersionRelease({
    bundle,
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: actor.tenantId,
      releaseId: bundle.releaseId,
      activationId: "named-main-original-app-catalog-activation",
      previousReleaseId: previous.bundle.releaseId,
      operator: {
        principalId: actor.principalId,
        actorId: actor.actorId,
        spaceId: actor.spaceId,
      },
      activatedAt: at,
    },
    expectedActiveReleaseId: previous.bundle.releaseId,
  });
  assert.equal(result.disposition, "activated");
  assert.deepEqual(result.release.bundle, bundle);
  assert.deepEqual(
    await store.loadAgentVersion(previousAssetLocator),
    previousAsset,
  );
  assert.deepEqual(
    await store.loadAgentVersionReleaseBundle({
      tenantId: actor.tenantId,
      releaseId: previous.bundle.releaseId,
    }),
    previous.bundle,
  );
  assert.deepEqual(
    await store.loadAgentVersionReleaseActivation({
      tenantId: actor.tenantId,
      activationId: previous.activation.activationId,
    }),
    previous.activation,
  );
}
