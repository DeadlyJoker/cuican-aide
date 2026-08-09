import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "./application-error.ts";
import { AgentVersionCatalogApplicationService } from "./agent-version-catalog-application-service.ts";
import type {
  ActivateAgentVersionReleaseResult,
  ActiveAgentVersionRelease,
  AgentVersionReleaseBundle,
  AgentVersionReleaseStore,
} from "./agent-version-release-store-port.ts";
import type {
  AgentVersionAsset,
  AgentVersionStore,
  RegisterAgentVersionResult,
} from "./agent-version-store-port.ts";
import type {
  AuthorizationDecision,
  AuthorizationPort,
} from "./authorization-port.ts";

const ACTOR = {
  principalId: "catalog-principal",
  actorId: "catalog-actor",
  tenantId: "tenant-1",
  spaceId: "space-1",
};

test("returns only assets bound to the active release in deployment order", async () => {
  const first = agentVersionAsset("agent-version-1", "a");
  const second = agentVersionAsset("agent-version-2", "b");
  const release = activeRelease([second, first], second.agentVersionId);
  const store = new FakeCatalogStore(release, [first, second]);
  const requests: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  const service = new AgentVersionCatalogApplicationService({
    store,
    authorization: authorization((request) => {
      requests.push(structuredClone(request));
      return { outcome: "allow" };
    }),
  });

  assert.deepEqual(await service.getActive(ACTOR), {
    releaseId: release.bundle.releaseId,
    activatedAt: release.activation.activatedAt,
    defaultAgentVersionId: second.agentVersionId,
    assets: [second, first],
  });
  assert.deepEqual(requests, [
    {
      actor: ACTOR,
      action: "agentVersion:list",
      resource: {
        kind: "agentVersion",
        tenantId: ACTOR.tenantId,
        spaceId: ACTOR.spaceId,
        agentVersionId: null,
      },
    },
  ]);
});

test("fails closed when an active deployment asset is missing or changed", async () => {
  const asset = agentVersionAsset("agent-version-1", "a");
  const release = activeRelease([asset], asset.agentVersionId);
  const missing = new AgentVersionCatalogApplicationService({
    store: new FakeCatalogStore(release, []),
    authorization: authorization(() => ({ outcome: "allow" })),
  });
  await assert.rejects(
    missing.getActive(ACTOR),
    hasApplicationError("internal", "agent_version_release_asset_missing"),
  );

  const changed = new AgentVersionCatalogApplicationService({
    store: new FakeCatalogStore(release, [
      { ...asset, contentDigest: digest("f") },
    ]),
    authorization: authorization(() => ({ outcome: "allow" })),
  });
  await assert.rejects(
    changed.getActive(ACTOR),
    hasApplicationError("internal", "agent_version_release_asset_mismatch"),
  );
});

test("authorizes before reading active release state", async () => {
  const asset = agentVersionAsset("agent-version-1", "a");
  const store = new FakeCatalogStore(
    activeRelease([asset], asset.agentVersionId),
    [asset],
  );
  const service = new AgentVersionCatalogApplicationService({
    store,
    authorization: authorization(() => ({
      outcome: "deny",
      reasonCode: "catalog_denied",
    })),
  });

  await assert.rejects(
    service.getActive(ACTOR),
    hasApplicationError("authorization", "authorization_denied"),
  );
  assert.equal(store.activeReleaseReads, 0);
});

class FakeCatalogStore implements AgentVersionStore, AgentVersionReleaseStore {
  readonly #release: ActiveAgentVersionRelease | null;
  readonly #assets = new Map<string, AgentVersionAsset>();
  activeReleaseReads = 0;

  constructor(
    release: ActiveAgentVersionRelease | null,
    assets: readonly AgentVersionAsset[],
  ) {
    this.#release = release === null ? null : structuredClone(release);
    for (const asset of assets) {
      this.#assets.set(asset.agentVersionId, structuredClone(asset));
    }
  }

  async loadActiveAgentVersionRelease(input: {
    tenantId: string;
  }): Promise<ActiveAgentVersionRelease | null> {
    this.activeReleaseReads += 1;
    return this.#release?.bundle.tenantId === input.tenantId
      ? structuredClone(this.#release)
      : null;
  }

  async loadAgentVersion(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<AgentVersionAsset | null> {
    const asset = this.#assets.get(input.agentVersionId);
    return asset?.tenantId === input.tenantId ? structuredClone(asset) : null;
  }

  async registerAgentVersion(
    asset: AgentVersionAsset,
  ): Promise<RegisterAgentVersionResult> {
    this.#assets.set(asset.agentVersionId, structuredClone(asset));
    return { disposition: "registered", asset: structuredClone(asset) };
  }

  async listAgentVersions(input: {
    tenantId: string;
  }): Promise<readonly AgentVersionAsset[]> {
    return [...this.#assets.values()].filter(
      (asset) => asset.tenantId === input.tenantId,
    );
  }

  async activateAgentVersionRelease(): Promise<ActivateAgentVersionReleaseResult> {
    throw new Error("not implemented");
  }

  async loadAgentVersionReleaseBundle(input: {
    tenantId: string;
    releaseId: string;
  }): Promise<AgentVersionReleaseBundle | null> {
    return this.#release?.bundle.tenantId === input.tenantId &&
      this.#release.bundle.releaseId === input.releaseId
      ? structuredClone(this.#release.bundle)
      : null;
  }

  async loadAgentVersionReleaseActivation(): Promise<null> {
    return null;
  }
}

function activeRelease(
  assets: readonly AgentVersionAsset[],
  defaultAgentVersionId: string,
): ActiveAgentVersionRelease {
  const releaseId = digest("c");
  return {
    bundle: {
      schemaVersion: "crewon.agent-version-release-bundle.v0",
      tenantId: ACTOR.tenantId,
      releaseId,
      manifestDigest: releaseId,
      defaultAgentVersionId,
      deployments: assets.map((asset, index) => ({
        schemaVersion: "crewon.agent-version-deployment.v0",
        tenantId: ACTOR.tenantId,
        agentVersionId: asset.agentVersionId,
        contentDigest: asset.contentDigest,
        materializationDigest: digest(String(index + 1)),
        authorityId: `authority-${index + 1}`,
        workspaceBindingId: null,
      })),
    },
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: ACTOR.tenantId,
      releaseId,
      activationId: "activation-1",
      previousReleaseId: null,
      operator: {
        principalId: ACTOR.principalId,
        actorId: ACTOR.actorId,
        spaceId: ACTOR.spaceId,
      },
      activatedAt: "2026-08-10T01:02:03Z",
    },
  };
}

function agentVersionAsset(
  agentVersionId: string,
  digestCharacter: string,
): AgentVersionAsset {
  return {
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId: ACTOR.tenantId,
    agentVersionId,
    contentDigest: digest(digestCharacter),
    definitionJson: `{\"agentVersionId\":\"${agentVersionId}\"}`,
    createdAt: "2026-08-10T00:00:00Z",
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function authorization(
  decide: (
    request: Parameters<AuthorizationPort["authorize"]>[0],
  ) => AuthorizationDecision,
): AuthorizationPort {
  return { authorize: async (request) => decide(request) };
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
