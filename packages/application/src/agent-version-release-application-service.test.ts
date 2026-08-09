import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ApplicationError } from "./application-error.ts";
import {
  AgentVersionReleaseApplicationService,
  compileAgentVersionReleaseBundle,
} from "./agent-version-release-application-service.ts";
import type {
  ActivateAgentVersionReleaseResult,
  ActiveAgentVersionRelease,
  AgentVersionReleaseBundle,
  AgentVersionReleaseStore,
} from "./agent-version-release-store-port.ts";
import type {
  AuthorizationDecision,
  AuthorizationPort,
} from "./authorization-port.ts";

const ACTOR = {
  principalId: "release-principal",
  actorId: "release-actor",
  tenantId: "tenant-1",
  spaceId: "space-1",
};

test("compiles a stable sorted release manifest and records its operator", async () => {
  const bundle = releaseBundle(["agent-b", "agent-a"]);
  assert.deepEqual(
    bundle.deployments.map((deployment) => deployment.agentVersionId),
    ["agent-a", "agent-b"],
  );
  assert.equal(bundle.releaseId, bundle.manifestDigest);
  const store = new FakeReleaseStore();
  const requests: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  const service = new AgentVersionReleaseApplicationService({
    store,
    authorization: authorization((request) => {
      requests.push(structuredClone(request));
      return { outcome: "allow" };
    }),
    clock: { now: () => "2026-08-10T01:02:03Z" },
    digester: { sha256 },
  });

  const result = await service.activate(ACTOR, bundle, "activation-1");

  assert.equal(result.disposition, "activated");
  assert.deepEqual(result.release.activation, {
    schemaVersion: "crewon.agent-version-release-activation.v0",
    tenantId: ACTOR.tenantId,
    releaseId: bundle.releaseId,
    activationId: "activation-1",
    previousReleaseId: null,
    operator: {
      principalId: ACTOR.principalId,
      actorId: ACTOR.actorId,
      spaceId: ACTOR.spaceId,
    },
    activatedAt: "2026-08-10T01:02:03Z",
  });
  assert.deepEqual(
    requests.map(({ action, resource }) => ({ action, resource })),
    ["agent-a", "agent-b"].map((agentVersionId) => ({
      action: "agentVersion:deploy",
      resource: {
        kind: "agentVersion",
        tenantId: ACTOR.tenantId,
        spaceId: ACTOR.spaceId,
        agentVersionId,
      },
    })),
  );
});

test("rejects a tampered manifest before authorization or storage", async () => {
  const store = new FakeReleaseStore();
  let authorizationCalls = 0;
  const service = new AgentVersionReleaseApplicationService({
    store,
    authorization: authorization(() => {
      authorizationCalls += 1;
      return { outcome: "allow" };
    }),
    clock: { now: () => "2026-08-10T01:02:03Z" },
    digester: { sha256 },
  });

  await assert.rejects(
    service.activate(
      ACTOR,
      {
        ...releaseBundle(["agent-a"]),
        manifestDigest: `sha256:${"f".repeat(64)}`,
      },
      "activation-tampered",
    ),
    hasApplicationError("validation", "agent_version_release_manifest_invalid"),
  );
  assert.equal(authorizationCalls, 0);
  assert.equal(store.activateCalls, 0);
});

test("reactivates an existing bundle as an audited rollback", async () => {
  const first = releaseBundle(["agent-a"]);
  const second = releaseBundle(["agent-b"]);
  const store = new FakeReleaseStore();
  const service = new AgentVersionReleaseApplicationService({
    store,
    authorization: authorization(() => ({ outcome: "allow" })),
    clock: { now: () => "2026-08-10T02:00:00Z" },
    digester: { sha256 },
  });
  await service.activate(ACTOR, first, "activation-first");
  await service.activate(ACTOR, second, "activation-second");
  assert.equal(
    (await service.activate(ACTOR, first, "activation-first")).disposition,
    "replayed",
  );
  assert.equal(
    (await store.loadActiveAgentVersionRelease({ tenantId: ACTOR.tenantId }))
      ?.bundle.releaseId,
    second.releaseId,
  );

  const rollback = await service.activateExisting(
    ACTOR,
    first.releaseId,
    "activation-rollback",
  );

  assert.equal(rollback.release.bundle.releaseId, first.releaseId);
  assert.equal(rollback.release.activation.previousReleaseId, second.releaseId);
  assert.equal(
    (await store.loadActiveAgentVersionRelease({ tenantId: ACTOR.tenantId }))
      ?.bundle.releaseId,
    first.releaseId,
  );
});

class FakeReleaseStore implements AgentVersionReleaseStore {
  readonly #bundles = new Map<string, AgentVersionReleaseBundle>();
  readonly #activations = new Map<
    string,
    ActiveAgentVersionRelease["activation"]
  >();
  #active: ActiveAgentVersionRelease | null = null;
  activateCalls = 0;

  async activateAgentVersionRelease(input: {
    bundle: AgentVersionReleaseBundle;
    activation: ActiveAgentVersionRelease["activation"];
    expectedActiveReleaseId: string | null;
  }): Promise<ActivateAgentVersionReleaseResult> {
    this.activateCalls += 1;
    const replay = this.#activations.get(input.activation.activationId);
    if (replay !== undefined) {
      const bundle = this.#bundles.get(replay.releaseId);
      assert.ok(bundle !== undefined);
      return {
        disposition: "replayed",
        release: {
          bundle: structuredClone(bundle),
          activation: structuredClone(replay),
        },
      };
    }
    assert.equal(
      this.#active?.bundle.releaseId ?? null,
      input.expectedActiveReleaseId,
    );
    const release = structuredClone({
      bundle: input.bundle,
      activation: input.activation,
    });
    this.#bundles.set(input.bundle.releaseId, structuredClone(input.bundle));
    this.#activations.set(
      input.activation.activationId,
      structuredClone(input.activation),
    );
    this.#active = release;
    return { disposition: "activated", release: structuredClone(release) };
  }

  async loadAgentVersionReleaseBundle(input: {
    tenantId: string;
    releaseId: string;
  }): Promise<AgentVersionReleaseBundle | null> {
    const bundle = this.#bundles.get(input.releaseId);
    return bundle?.tenantId === input.tenantId ? structuredClone(bundle) : null;
  }

  async loadActiveAgentVersionRelease(input: {
    tenantId: string;
  }): Promise<ActiveAgentVersionRelease | null> {
    return this.#active?.bundle.tenantId === input.tenantId
      ? structuredClone(this.#active)
      : null;
  }

  async loadAgentVersionReleaseActivation(input: {
    tenantId: string;
    activationId: string;
  }): Promise<ActiveAgentVersionRelease["activation"] | null> {
    const activation = this.#activations.get(input.activationId);
    return activation?.tenantId === input.tenantId
      ? structuredClone(activation)
      : null;
  }
}

function releaseBundle(
  agentVersionIds: readonly string[],
): AgentVersionReleaseBundle {
  return compileAgentVersionReleaseBundle(
    {
      tenantId: ACTOR.tenantId,
      defaultAgentVersionId: [...agentVersionIds].sort()[0]!,
      deployments: agentVersionIds.map((agentVersionId, index) => ({
        schemaVersion: "crewon.agent-version-deployment.v0",
        tenantId: ACTOR.tenantId,
        agentVersionId,
        contentDigest: `sha256:${"a".repeat(64)}`,
        materializationDigest: `sha256:${String(index + 1).repeat(64)}`,
        authorityId: `authority-${agentVersionId}`,
        workspaceBindingId: null,
      })),
    },
    { sha256 },
  );
}

function authorization(
  decide: (
    request: Parameters<AuthorizationPort["authorize"]>[0],
  ) => AuthorizationDecision,
): AuthorizationPort {
  return { authorize: async (request) => decide(request) };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
