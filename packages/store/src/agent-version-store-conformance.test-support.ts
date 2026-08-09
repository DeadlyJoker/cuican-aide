import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";

import {
  RunStoreError,
  type AgentVersionAsset,
  type AgentVersionStore,
} from "@crewon/application";

type AgentVersionConformanceStore = AgentVersionStore & {
  close(): Promise<void>;
};

/** Registers the immutable, tenant-scoped contract every AgentVersionStore must satisfy. */
export function registerAgentVersionStoreConformance(
  name: string,
  createStore: () =>
    | AgentVersionConformanceStore
    | Promise<AgentVersionConformanceStore>,
): void {
  describe(name, () => {
    test("registers idempotently and returns defensive copies", async (context) => {
      const store = await managedStore(context, createStore);
      const asset = agentVersionAsset("tenant-1", "agent-version-a");

      assert.deepEqual(await store.registerAgentVersion(asset), {
        disposition: "registered",
        asset,
      });
      const replay = await store.registerAgentVersion({
        ...asset,
        createdAt: "2026-08-09T00:00:01.456Z",
      });
      assert.deepEqual(replay, { disposition: "existing", asset });

      (replay.asset as { definitionJson: string }).definitionJson = "{}";
      assert.deepEqual(
        await store.loadAgentVersion({
          tenantId: asset.tenantId,
          agentVersionId: asset.agentVersionId,
        }),
        asset,
      );
    });

    test("rejects every attempt to rebind one AgentVersion ID", async (context) => {
      const store = await managedStore(context, createStore);
      const asset = agentVersionAsset("tenant-1", "agent-version-a");
      await store.registerAgentVersion(asset);

      await assert.rejects(
        store.registerAgentVersion({
          ...asset,
          contentDigest: `sha256:${"b".repeat(64)}`,
        }),
        hasStoreCode("agent_version_id_conflict"),
      );
      assert.deepEqual(
        await store.loadAgentVersion({
          tenantId: asset.tenantId,
          agentVersionId: asset.agentVersionId,
        }),
        asset,
      );
    });

    test("isolates tenants and paginates by stable AgentVersion ID", async (context) => {
      const store = await managedStore(context, createStore);
      const first = agentVersionAsset("tenant-1", "agent-version-a");
      const second = agentVersionAsset("tenant-1", "agent-version-b");
      const otherTenant = agentVersionAsset("tenant-2", "agent-version-a");
      await store.registerAgentVersion(second);
      await store.registerAgentVersion(otherTenant);
      await store.registerAgentVersion(first);

      assert.deepEqual(
        await store.listAgentVersions({
          tenantId: "tenant-1",
          afterAgentVersionId: null,
          limit: 1,
        }),
        [first],
      );
      assert.deepEqual(
        await store.listAgentVersions({
          tenantId: "tenant-1",
          afterAgentVersionId: first.agentVersionId,
          limit: 100,
        }),
        [second],
      );
      assert.equal(
        await store.loadAgentVersion({
          tenantId: "tenant-2",
          agentVersionId: second.agentVersionId,
        }),
        null,
      );
    });

    test("rejects malformed assets and unbounded list requests", async (context) => {
      const store = await managedStore(context, createStore);
      await assert.rejects(
        store.registerAgentVersion({
          ...agentVersionAsset("tenant-1", "agent-version-a"),
          definitionJson: "[]",
        }),
        hasStoreCode("agent_version_definition_invalid"),
      );
      await assert.rejects(
        store.listAgentVersions({
          tenantId: "tenant-1",
          afterAgentVersionId: null,
          limit: 1_001,
        }),
        hasStoreCode("agent_version_limit_invalid"),
      );
    });
  });
}

export function agentVersionAsset(
  tenantId: string,
  agentVersionId: string,
): AgentVersionAsset {
  return {
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId,
    agentVersionId,
    contentDigest: `sha256:${"a".repeat(64)}`,
    definitionJson: JSON.stringify({
      schemaVersion: "crewon.agent-version.v0",
      agentVersionId,
    }),
    createdAt: "2026-08-09T00:00:00.123Z",
  };
}

async function managedStore(
  context: TestContext,
  createStore: () =>
    | AgentVersionConformanceStore
    | Promise<AgentVersionConformanceStore>,
): Promise<AgentVersionConformanceStore> {
  const store = await createStore();
  context.after(() => store.close());
  return store;
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
