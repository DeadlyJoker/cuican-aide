import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  compileAgentVersion,
  parseAgentVersionAsset,
} from "@crewon/agent-version";
import {
  compileAgentVersionReleaseBundle,
  sameAgentVersionReleaseBundle,
} from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import { createExtensionConfiguration } from "@crewon/domain";
import { compileRuntimeAgentVersionRelease } from "./agent-version-release.ts";
import {
  loadInstalledPluginRelease,
  verifyInstalledPluginReleaseInputs,
} from "./plugins/installed-plugin-release-loader.ts";
import { createInstalledPluginReleasePublication } from "./plugins/installed-plugin-release-publication.ts";
import { installedPluginAgentRuntimeTarget } from "./plugins/installed-plugin-agent-runtime-factory.ts";
import {
  digester,
  pgOptions,
  releaseActor,
} from "./installed-plugin-release-loader.test-support.ts";
import {
  publicationFixture,
  publicationActivationCount,
} from "./installed-plugin-release-publication.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: fresh source and derived assets activate only the exact main bundle once`,
    backend === "postgres" ? pgOptions : {},
    async (t) => {
      const f = await publicationFixture(t, backend);
      assert.ok(
        !f.runtimePlan.versions.some(
          (entry) => entry.agentVersionId === f.baseVersion.agentVersionId,
        ),
      );
      for (const version of [
        ...f.publisher.plan.sourceVersions,
        ...f.runtimePlan.versions,
      ]) {
        assert.equal(
          await f.store.loadAgentVersion({
            tenantId: releaseActor.tenantId,
            agentVersionId: version.agentVersionId,
          }),
          null,
        );
      }
      f.publicationState.onAuthorization = async () => {
        assert.equal(
          await f.store.loadActiveAgentVersionRelease({
            tenantId: releaseActor.tenantId,
          }),
          null,
        );
      };
      const result = await f.publisher.publish({
        actor: releaseActor,
        activationId: "publication-fresh",
      });
      assert.equal(result.activation.disposition, "activated");
      assert.equal(result.verification.outcome, "verified");
      assert.ok(
        sameAgentVersionReleaseBundle(
          result.activation.release.bundle,
          f.runtimePlan.bundle,
        ),
      );
      assert.equal(
        result.activation.release.bundle.defaultAgentVersionId,
        "publication-bootstrap-agent",
      );
      assert.equal(await publicationActivationCount(f), 1);
      const assets = [
        ...result.plan.sourceVersions,
        ...result.plan.runtime.versions,
      ];
      assert.deepEqual(
        f.publicationState.requests
          .filter((entry) => entry.action === "agentVersion:publish")
          .map((entry) =>
            entry.resource.kind === "agentVersion"
              ? entry.resource.agentVersionId
              : null,
          ),
        assets.map((entry) => entry.agentVersionId),
      );
      for (const version of assets) {
        const asset = await f.store.loadAgentVersion({
          tenantId: releaseActor.tenantId,
          agentVersionId: version.agentVersionId,
        });
        assert.ok(asset);
        assert.deepEqual(parseAgentVersionAsset(asset, digester), version);
      }
      const runtime = await f.release.factory.create({
        tenantId: releaseActor.tenantId,
        version: f.release.versions[0]!,
      });
      await runtime.toolRuntime?.close?.();
      f.publicationState.onAuthorization = null;
      const replay = await f.publisher.publish({
        actor: releaseActor,
        activationId: "publication-fresh",
      });
      assert.equal(replay.activation.disposition, "replayed");
      assert.equal(await publicationActivationCount(f), 1);
    },
  );

  test(
    `${backend}: denied publication cannot activate or materialize and withdrawal after asset writes leaves no active bundle`,
    backend === "postgres" ? pgOptions : {},
    async (t) => {
      const f = await publicationFixture(t, backend);
      f.publicationState.decision = "deny";
      await assert.rejects(
        f.publisher.publish({
          actor: releaseActor,
          activationId: "publication-denied",
        }),
        /authorization_denied/,
      );
      assert.equal(await publicationActivationCount(f), 0);
      assert.equal(
        await f.store.loadAgentVersion({
          tenantId: releaseActor.tenantId,
          agentVersionId: f.baseVersion.agentVersionId,
        }),
        null,
      );
      f.publicationState.decision = "allow";
      const last = f.runtimePlan.versions.at(-1)!.agentVersionId;
      f.publicationState.onAuthorization = async (request) => {
        if (
          request.action === "agentVersion:publish" &&
          request.resource.kind === "agentVersion" &&
          request.resource.agentVersionId === last
        )
          f.state.allowed = false;
      };
      await assert.rejects(
        f.publisher.publish({
          actor: releaseActor,
          activationId: "publication-withdrawn",
        }),
      );
      assert.ok(
        await f.store.loadAgentVersion({
          tenantId: releaseActor.tenantId,
          agentVersionId: last,
        }),
      );
      assert.equal(await publicationActivationCount(f), 0);
      assert.equal(
        await f.store.loadActiveAgentVersionRelease({
          tenantId: releaseActor.tenantId,
        }),
        null,
      );
      await assert.rejects(
        f.release.factory.create({
          tenantId: releaseActor.tenantId,
          version: f.release.versions[0]!,
        }),
        /publication_unverified/,
      );
    },
  );

  test(
    `${backend}: current read permission withdrawn during actual activation preserves its committed receipt`,
    backend === "postgres" ? pgOptions : {},
    async (t) => {
      const f = await publicationFixture(t, backend);
      const last = f.runtimePlan.bundle.deployments.at(-1)!.agentVersionId;
      f.publicationState.onAuthorization = async (request) => {
        if (
          request.action === "agentVersion:deploy" &&
          request.resource.kind === "agentVersion" &&
          request.resource.agentVersionId === last
        )
          f.state.allowed = false;
      };
      const result = await f.publisher.publish({
        actor: releaseActor,
        activationId: "publication-committed-withdrawal",
      });
      assert.equal(result.activation.disposition, "activated");
      assert.equal(result.verification.outcome, "unavailable");
      assert.equal(await publicationActivationCount(f), 1);
      assert.ok(
        sameAgentVersionReleaseBundle(
          (await f.store.loadActiveAgentVersionRelease({
            tenantId: releaseActor.tenantId,
          }))!.bundle,
          f.runtimePlan.bundle,
        ),
      );
      await assert.rejects(
        f.release.factory.create({
          tenantId: releaseActor.tenantId,
          version: f.release.versions[0]!,
        }),
        /publication_unverified/,
      );
    },
  );
}

test("publication validates exact full candidates, original default and source full versions before any mutation", async (t) => {
  const f = await publicationFixture(t);
  const missing = compileRuntimeAgentVersionRelease({
    ...f.config,
    agentVersionDeployments: f.release.deployments,
  });
  assert.throws(
    () =>
      createInstalledPluginReleasePublication({
        ...f.dependencies,
        runtimePlan: missing,
      }),
    /publication_source_deployment_missing/,
  );
  const wrongSource = structuredClone(f.runtimePlan);
  const candidate = wrongSource.deployments.find(
    (entry) => entry.agentVersionId === f.baseVersion.agentVersionId,
  )!;
  Reflect.set(
    candidate,
    "materializationDigest",
    digester.sha256("other-source"),
  );
  Reflect.set(
    wrongSource,
    "bundle",
    compileAgentVersionReleaseBundle(
      {
        tenantId: releaseActor.tenantId,
        defaultAgentVersionId: wrongSource.bootstrapVersion.agentVersionId,
        deployments: wrongSource.deployments,
      },
      digester,
    ),
  );
  assert.throws(
    () =>
      createInstalledPluginReleasePublication({
        ...f.dependencies,
        runtimePlan: wrongSource,
      }),
    /publication_deployment_mismatch/,
  );
  const { contentDigest: _, ...body } = f.baseVersion;
  const changed = compileAgentVersion(
    {
      ...body,
      schemaVersion: "crewon.agent-version-source.v0",
      instructions: "Conflicting source body",
    },
    digester,
  );
  const conflict = structuredClone(f.runtimePlan);
  Reflect.set(conflict, "versions", [...conflict.versions, changed]);
  assert.throws(
    () =>
      createInstalledPluginReleasePublication({
        ...f.dependencies,
        runtimePlan: conflict,
      }),
    /publication_version_mismatch|publication_source_version_conflict/,
  );
  const defaultMismatch = structuredClone(f.runtimePlan);
  Reflect.set(
    defaultMismatch.bundle,
    "defaultAgentVersionId",
    f.baseVersion.agentVersionId,
  );
  assert.throws(
    () =>
      createInstalledPluginReleasePublication({
        ...f.dependencies,
        runtimePlan: defaultMismatch,
      }),
    /publication_plan_mismatch/,
  );
  assert.throws(
    () =>
      createInstalledPluginReleasePublication({
        ...f.dependencies,
        release: { ...f.release },
      }),
    /unverified_document/,
  );
  assert.throws(
    () =>
      createInstalledPluginReleasePublication({
        ...f.dependencies,
        store: {} as SqliteRunStore,
      }),
    /store_invalid/,
  );
  assert.equal(f.publicationState.requests.length, 0);
  assert.equal(await publicationActivationCount(f), 0);
});

test("allocation-free publication inputs bind the real parent but cannot authorize a runtime", async (t) => {
  const f = await publicationFixture(t);
  await verifyInstalledPluginReleaseInputs({
    release: f.release,
    store: f.store,
  });
  assert.equal(await publicationActivationCount(f), 0);
  await assert.rejects(
    f.release.factory.create({
      tenantId: releaseActor.tenantId,
      version: f.release.versions[0]!,
    }),
    /publication_unverified/,
  );
  const other = new SqliteRunStore(join(f.directory, "other.sqlite"));
  f.own(other);
  await assert.rejects(
    verifyInstalledPluginReleaseInputs({ release: f.release, store: other }),
    /store_owner_mismatch/,
  );
  const copy = structuredClone(f.document);
  const { contentDigest: _, ...configurationBody } =
    copy.entries[0]!.configuration;
  const configuration = createExtensionConfiguration(
    {
      ...configurationBody,
      parameters: { baseUrl: "https://changed.fixture.example/" },
    },
    digester,
  );
  Reflect.set(copy.entries[0]!, "configuration", configuration);
  Reflect.set(
    copy.entries[0]!,
    "target",
    installedPluginAgentRuntimeTarget({
      defaultAgentVersionId: f.release.document.defaultAgentVersionId,
      entry: {
        scope: copy.entries[0]!.scope,
        registration: f.release.registrations[0]!,
        configuration,
        approvalRequirement: "none",
        base: {
          executionAuthority: "crewonKernel",
          version: f.baseVersion,
          deployment: f.baseDeployment,
        },
        version: copy.entries[0]!.version,
        authorityId: f.baseDeployment.authorityId,
        workspaceBindingId: f.baseDeployment.workspaceBindingId,
        transportOwnership: f.base.transportOwnership,
        createTransport: f.base.createTransport,
        createBaseToolRuntime: f.base.createToolRuntime,
      },
    }),
  );
  const changed = await loadInstalledPluginRelease({
    ...f.loaderInput,
    document: {
      ...copy,
      defaultAgentVersionId: f.release.document.defaultAgentVersionId,
    },
  });
  f.own(changed);
  await assert.rejects(
    verifyInstalledPluginReleaseInputs({ release: changed, store: f.store }),
    /configuration_mismatch/,
  );
  const node = join(
    f.packages[0]!.directory,
    f.packages[0]!.descriptor.entrypoints.node!,
  );
  await chmod(node, 0o600);
  await writeFile(node, "throw new Error('tampered');");
  await assert.rejects(
    verifyInstalledPluginReleaseInputs({ release: f.release, store: f.store }),
  );
});

test("publisher snapshots plan, ports and request before asynchronous authorization", async (t) => {
  const f = await publicationFixture(t);
  const plan = structuredClone(f.runtimePlan);
  const authorization = {
    calls: 0,
    async authorize() {
      this.calls++;
      return { outcome: "allow" as const };
    },
  };
  const clock = {
    value: "2026-10-03T09:00:00.000Z",
    now() {
      return this.value;
    },
  };
  const publisher = createInstalledPluginReleasePublication({
    ...f.dependencies,
    runtimePlan: plan,
    authorization,
    clock,
  });
  f.own(publisher);
  const actor = { ...releaseActor };
  const request = { actor, activationId: "publication-captured" };
  const pending = publisher.publish(request);
  Reflect.set(plan.bundle, "defaultAgentVersionId", "forged-default");
  actor.tenantId = "forged-tenant";
  request.activationId = "forged-activation";
  authorization.authorize = async () => {
    throw new Error("replaced-port");
  };
  const result = await pending;
  assert.equal(
    result.activation.release.activation.activationId,
    "publication-captured",
  );
  assert.equal(
    result.activation.release.activation.operator.actorId,
    releaseActor.actorId,
  );
  assert.equal(
    result.activation.release.bundle.defaultAgentVersionId,
    f.runtimePlan.bundle.defaultAgentVersionId,
  );
  assert.ok(authorization.calls > 0);
  assert.ok(Object.isFrozen(result.plan.runtime.versions));
});

test("publication bounds aggregate own data before semantic parsing and never evaluates known getters", async (t) => {
  const f = await publicationFixture(t);
  const oversized = structuredClone(f.runtimePlan);
  Reflect.set(
    oversized,
    "versions",
    Array.from({ length: 40 }, () => ({ malformed: "x".repeat(900_000) })),
  );
  assert.throws(
    () =>
      createInstalledPluginReleasePublication({
        ...f.dependencies,
        runtimePlan: oversized,
      }),
    /publication_plan_limit/,
  );
  let getters = 0;
  const accessor = { ...f.runtimePlan };
  Object.defineProperty(accessor, "versions", {
    enumerable: true,
    get() {
      getters++;
      return f.runtimePlan.versions;
    },
  });
  assert.throws(() =>
    createInstalledPluginReleasePublication({
      ...f.dependencies,
      runtimePlan: accessor,
    }),
  );
  assert.equal(getters, 0);
  assert.equal(f.publicationState.requests.length, 0);
  assert.equal(await publicationActivationCount(f), 0);
});

test("close fences queued work and joins physical authorization without closing the borrowed Store", async (t) => {
  const f = await publicationFixture(t);
  const queued = f.publisher.publish({
    actor: releaseActor,
    activationId: "publication-queued",
  });
  const closing = f.publisher.close();
  assert.equal(f.publisher.close(), closing);
  await assert.rejects(queued, /publication_closed/);
  await closing;
  assert.equal(await publicationActivationCount(f), 0);
  assert.throws(
    () =>
      f.publisher.publish({ actor: releaseActor, activationId: "after-close" }),
    /publication_closed/,
  );
  const second = createInstalledPluginReleasePublication(f.dependencies);
  f.own(second);
  const entered = deferred(),
    release = deferred();
  f.publicationState.onAuthorization = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = second.publish({
    actor: releaseActor,
    activationId: "publication-physical",
  });
  await entered.promise;
  let closed = false;
  const physicalClose = second.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(
    await f.store.loadActiveAgentVersionRelease({
      tenantId: releaseActor.tenantId,
    }),
    null,
  );
  release.resolve();
  await assert.rejects(pending, /publication_closed/);
  await physicalClose;
  assert.ok(
    await f.store.loadAgentVersion({
      tenantId: releaseActor.tenantId,
      agentVersionId: f.baseVersion.agentVersionId,
    }),
  );
  assert.equal(await publicationActivationCount(f), 0);
});

test("close during started activation waits for COMMIT and returns exact committed evidence", async (t) => {
  const f = await publicationFixture(t);
  const entered = deferred(),
    release = deferred();
  f.publicationState.onAuthorization = async (request) => {
    if (request.action === "agentVersion:deploy") {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = f.publisher.publish({
    actor: releaseActor,
    activationId: "publication-late-commit",
  });
  await entered.promise;
  const close = f.publisher.close();
  let settled = false;
  void close.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  release.resolve();
  const result = await pending;
  assert.equal(result.activation.disposition, "activated");
  assert.equal(result.verification.outcome, "unavailable");
  await close;
  assert.equal(await publicationActivationCount(f), 1);
  assert.deepEqual(
    await f.store.loadAgentVersionReleaseActivation({
      tenantId: releaseActor.tenantId,
      activationId: "publication-late-commit",
    }),
    result.activation.release.activation,
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
