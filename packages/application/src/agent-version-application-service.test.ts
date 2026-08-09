import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "./application-error.ts";
import { AgentVersionApplicationService } from "./agent-version-application-service.ts";
import type { AgentVersionAsset } from "./agent-version-store-port.ts";
import type {
  AuthorizationPort,
  AuthorizationDecision,
} from "./authorization-port.ts";
import { RunStoreError } from "./run-store-port.ts";

test("authorizes tenant-scoped AgentVersion publication and discovery", async () => {
  const store = new FakeAgentVersionStore();
  const requests: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  const service = new AgentVersionApplicationService({
    store,
    authorization: authorization((request) => {
      requests.push(structuredClone(request));
      return { outcome: "allow" };
    }),
  });
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
  const asset = agentVersionAsset();

  assert.deepEqual(await service.publish(actor, asset), {
    disposition: "registered",
    asset,
  });
  assert.deepEqual(await service.get(actor, asset.agentVersionId), asset);
  assert.deepEqual(
    await service.list(actor, { afterAgentVersionId: null, limit: 10 }),
    [asset],
  );
  assert.deepEqual(
    requests.map(({ action, resource }) => ({ action, resource })),
    [
      {
        action: "agentVersion:publish",
        resource: {
          kind: "agentVersion",
          tenantId: "tenant-1",
          spaceId: "space-1",
          agentVersionId: "agent-version-1",
        },
      },
      {
        action: "agentVersion:read",
        resource: {
          kind: "agentVersion",
          tenantId: "tenant-1",
          spaceId: "space-1",
          agentVersionId: "agent-version-1",
        },
      },
      {
        action: "agentVersion:list",
        resource: {
          kind: "agentVersion",
          tenantId: "tenant-1",
          spaceId: "space-1",
          agentVersionId: null,
        },
      },
    ],
  );
});

test("rejects cross-tenant assets and maps immutable Store conflicts", async () => {
  const store = new FakeAgentVersionStore();
  const service = new AgentVersionApplicationService({
    store,
    authorization: authorization(() => ({ outcome: "allow" })),
  });
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };

  await assert.rejects(
    service.publish(actor, { ...agentVersionAsset(), tenantId: "tenant-2" }),
    hasApplicationError("authorization", "authorization_denied"),
  );
  await service.publish(actor, agentVersionAsset());
  store.conflict = true;
  await assert.rejects(
    service.publish(actor, agentVersionAsset()),
    hasApplicationError("conflict", "agent_version_id_conflict"),
  );
});

function authorization(
  decide: (
    request: Parameters<AuthorizationPort["authorize"]>[0],
  ) => AuthorizationDecision,
): AuthorizationPort {
  return { authorize: async (request) => decide(request) };
}

class FakeAgentVersionStore {
  asset: AgentVersionAsset | null = null;
  conflict = false;

  async registerAgentVersion(asset: AgentVersionAsset) {
    if (this.conflict) {
      throw new RunStoreError("agent_version_id_conflict");
    }
    this.asset = structuredClone(asset);
    return {
      disposition: "registered" as const,
      asset: structuredClone(asset),
    };
  }

  async loadAgentVersion(input: { tenantId: string; agentVersionId: string }) {
    return this.asset?.tenantId === input.tenantId &&
      this.asset.agentVersionId === input.agentVersionId
      ? structuredClone(this.asset)
      : null;
  }

  async listAgentVersions(input: { tenantId: string }) {
    return this.asset?.tenantId === input.tenantId
      ? [structuredClone(this.asset)]
      : [];
  }
}

function agentVersionAsset(): AgentVersionAsset {
  return {
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId: "tenant-1",
    agentVersionId: "agent-version-1",
    contentDigest: `sha256:${"a".repeat(64)}`,
    definitionJson: '{"schemaVersion":"crewon.agent-version.v0"}',
    createdAt: "2026-08-09T00:00:00Z",
  };
}

function hasApplicationError(
  category: ApplicationError["category"],
  code: string,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof ApplicationError &&
    error.category === category &&
    error.code === code;
}
