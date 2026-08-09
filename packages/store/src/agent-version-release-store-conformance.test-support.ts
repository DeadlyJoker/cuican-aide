import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";

import {
  RunStoreError,
  type ActiveAgentVersionRelease,
  type AgentVersionReleaseActivation,
  type AgentVersionReleaseBundle,
  type AgentVersionReleaseStore,
  type AgentVersionStore,
  type AgentVersionDeploymentStore,
} from "@crewon/application";

import { agentVersionAsset } from "./agent-version-store-conformance.test-support.ts";

type ReleaseConformanceStore = AgentVersionReleaseStore &
  AgentVersionStore &
  AgentVersionDeploymentStore & { close(): Promise<void> };

/** Registers atomic bundle activation and rollback semantics for every Store. */
export function registerAgentVersionReleaseStoreConformance(
  name: string,
  createStore: () => ReleaseConformanceStore | Promise<ReleaseConformanceStore>,
): void {
  describe(name, () => {
    test("atomically activates a multi-version bundle with operator audit", async (context) => {
      const store = await managedStore(context, createStore);
      const bundle = releaseBundle("1", ["agent-a", "agent-b"]);
      await seedAssets(store, bundle);
      const activation = releaseActivation(bundle, "activation-1", null);

      const activated = await store.activateAgentVersionRelease({
        bundle,
        activation,
        expectedActiveReleaseId: null,
      });
      assert.deepEqual(activated, {
        disposition: "activated",
        release: { bundle, activation },
      });
      assert.deepEqual(
        await store.loadActiveAgentVersionRelease({ tenantId: "tenant-1" }),
        { bundle, activation },
      );
      assert.deepEqual(
        await store.loadAgentVersionReleaseBundle({
          tenantId: bundle.tenantId,
          releaseId: bundle.releaseId,
        }),
        bundle,
      );
      assert.deepEqual(
        await store.loadAgentVersionReleaseActivation({
          tenantId: activation.tenantId,
          activationId: activation.activationId,
        }),
        activation,
      );
      for (const candidate of bundle.deployments) {
        assert.deepEqual(await store.loadAgentVersionDeployment(candidate), {
          ...candidate,
          deployedAt: activation.activatedAt,
        });
      }

      const replay = await store.activateAgentVersionRelease({
        bundle,
        activation,
        expectedActiveReleaseId: null,
      });
      assert.deepEqual(replay, {
        disposition: "replayed",
        release: { bundle, activation },
      });
      (
        replay.release.bundle.deployments[0] as { authorityId: string }
      ).authorityId = "changed";
      assert.deepEqual(
        await store.loadActiveAgentVersionRelease({ tenantId: "tenant-1" }),
        { bundle, activation },
      );
    });

    test("rolls back every write when one release asset is missing", async (context) => {
      const store = await managedStore(context, createStore);
      const bundle = releaseBundle("2", ["agent-a", "agent-missing"]);
      await store.registerAgentVersion(
        agentVersionAsset(bundle.tenantId, "agent-a"),
      );

      await assert.rejects(
        store.activateAgentVersionRelease({
          bundle,
          activation: releaseActivation(bundle, "activation-2", null),
          expectedActiveReleaseId: null,
        }),
        hasStoreCode("agent_version_release_asset_missing"),
      );
      assert.equal(
        await store.loadAgentVersionReleaseBundle({
          tenantId: bundle.tenantId,
          releaseId: bundle.releaseId,
        }),
        null,
      );
      assert.equal(
        await store.loadActiveAgentVersionRelease({
          tenantId: bundle.tenantId,
        }),
        null,
      );
      assert.equal(
        await store.loadAgentVersionDeployment({
          tenantId: bundle.tenantId,
          agentVersionId: "agent-a",
        }),
        null,
      );
    });

    test("fences stale activation and supports audited rollback", async (context) => {
      const store = await managedStore(context, createStore);
      const first = releaseBundle("3", ["agent-a"]);
      const second = releaseBundle("4", ["agent-b"]);
      const stale = releaseBundle("5", ["agent-c"]);
      await seedAssets(store, first);
      await seedAssets(store, second);
      await seedAssets(store, stale);
      const firstActivation = releaseActivation(first, "activation-3", null);
      await store.activateAgentVersionRelease({
        bundle: first,
        activation: firstActivation,
        expectedActiveReleaseId: null,
      });
      const secondActivation = releaseActivation(
        second,
        "activation-4",
        first.releaseId,
      );
      await store.activateAgentVersionRelease({
        bundle: second,
        activation: secondActivation,
        expectedActiveReleaseId: first.releaseId,
      });

      await assert.rejects(
        store.activateAgentVersionRelease({
          bundle: stale,
          activation: releaseActivation(stale, "activation-5", first.releaseId),
          expectedActiveReleaseId: first.releaseId,
        }),
        hasStoreCode("agent_version_release_active_conflict"),
      );
      assert.equal(
        await store.loadAgentVersionReleaseBundle({
          tenantId: stale.tenantId,
          releaseId: stale.releaseId,
        }),
        null,
      );

      const rollback = releaseActivation(
        first,
        "activation-rollback",
        second.releaseId,
      );
      await store.activateAgentVersionRelease({
        bundle: first,
        activation: rollback,
        expectedActiveReleaseId: second.releaseId,
      });
      assert.deepEqual(
        await store.loadActiveAgentVersionRelease({ tenantId: "tenant-1" }),
        { bundle: first, activation: rollback },
      );

      assert.deepEqual(
        await store.activateAgentVersionRelease({
          bundle: second,
          activation: secondActivation,
          expectedActiveReleaseId: first.releaseId,
        }),
        {
          disposition: "replayed",
          release: { bundle: second, activation: secondActivation },
        },
      );
      assert.deepEqual(
        await store.loadActiveAgentVersionRelease({ tenantId: "tenant-1" }),
        { bundle: first, activation: rollback },
      );
      assert.equal(
        await store.loadActiveAgentVersionRelease({ tenantId: "tenant-2" }),
        null,
      );
    });
  });
}

export function releaseBundle(
  digestCharacter: string,
  agentVersionIds: readonly string[],
): AgentVersionReleaseBundle {
  const releaseId = `sha256:${digestCharacter.repeat(64)}`;
  return {
    schemaVersion: "crewon.agent-version-release-bundle.v0",
    tenantId: "tenant-1",
    releaseId,
    manifestDigest: releaseId,
    defaultAgentVersionId: agentVersionIds[0]!,
    deployments: agentVersionIds.map((agentVersionId, index) => ({
      schemaVersion: "crewon.agent-version-deployment.v0",
      tenantId: "tenant-1",
      agentVersionId,
      contentDigest: `sha256:${"a".repeat(64)}`,
      materializationDigest: `sha256:${String(index + 1).repeat(64)}`,
      authorityId: `authority-${agentVersionId}`,
      workspaceBindingId: null,
    })),
  };
}

export function releaseActivation(
  bundle: AgentVersionReleaseBundle,
  activationId: string,
  previousReleaseId: string | null,
): AgentVersionReleaseActivation {
  return {
    schemaVersion: "crewon.agent-version-release-activation.v0",
    tenantId: bundle.tenantId,
    releaseId: bundle.releaseId,
    activationId,
    previousReleaseId,
    operator: {
      principalId: "release-principal",
      actorId: "release-actor",
      spaceId: "release-space",
    },
    activatedAt: "2026-08-10T00:00:00Z",
  };
}

async function seedAssets(
  store: ReleaseConformanceStore,
  bundle: AgentVersionReleaseBundle,
): Promise<void> {
  for (const deployment of bundle.deployments) {
    await store.registerAgentVersion(
      agentVersionAsset(bundle.tenantId, deployment.agentVersionId),
    );
  }
}

async function managedStore(
  context: TestContext,
  createStore: () => ReleaseConformanceStore | Promise<ReleaseConformanceStore>,
): Promise<ReleaseConformanceStore> {
  const store = await createStore();
  context.after(() => store.close());
  return store;
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
