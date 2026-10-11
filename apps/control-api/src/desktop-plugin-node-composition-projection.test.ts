import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createPluginCompositionLock,
  type PluginCompositionLock,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import {
  SqliteRunStore,
  type SqlitePluginInstallationProfileOwner,
} from "@crewon/store";
import {
  installLocalPluginPackage,
  verifyLocalPluginPackage,
} from "@crewon/plugin-host";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { DesktopPluginExecutionServiceOwner } from "./desktop-plugin-execution-service-owner.ts";
import { projectDesktopPluginNodeComposition } from "./desktop-plugin-node-composition-projection.ts";
import { installationSame } from "./desktop-plugin-runtime-support.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";

const actor = {
  tenantId: "projection-tenant",
  spaceId: "projection-space",
  principalId: "projection-owner",
  actorId: "projection-user",
};
const scope = {
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "projection-profile",
};
const compositionScope = {
  ...scope,
  authorityEpoch: "projection-real-native-source-epoch-01",
};
const now = "2026-10-11T00:00:00.000Z";
const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
type Spec = Readonly<{
  id: string;
  uiOnly?: boolean;
  disabled?: boolean;
  requires?: PluginPackageDescriptor["requires"];
  provides?: PluginPackageDescriptor["provides"];
}>;

async function fixture(t: TestContext, specs: readonly Spec[]) {
  let owner: SqlitePluginInstallationProfileOwner | undefined;
  let store: SqliteRunStore | undefined;
  const services = new DesktopPluginExecutionServiceOwner();
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      services.close();
      await owner?.close();
      await store?.close();
    },
  });
  const sources = [];
  for (const spec of specs) {
    const base = await files.source(spec.id, {
      pluginId: `test.${spec.id}`,
      uiOnly: spec.uiOnly,
      validNode: !spec.uiOnly,
      requires: spec.requires,
    });
    const descriptor = { ...base.descriptor, provides: spec.provides ?? [] };
    await writeFile(
      join(base.directory, "crewon.plugin.json"),
      JSON.stringify(descriptor),
    );
    const verified = await verifyLocalPluginPackage({
      directory: base.directory,
    });
    sources.push({
      ...base,
      packageDigest: verified.packageDigest,
      descriptor: verified.descriptor,
      disabled: spec.disabled === true,
    });
  }
  const configuration = parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope,
    authorityEpoch: compositionScope.authorityEpoch,
    installRoot: files.installRoot,
    sources: sources.map(
      ({ descriptor: _descriptor, disabled: _disabled, ...source }) => source,
    ),
    publications: [],
  });
  const registry = await createDesktopPluginSourceRegistry(configuration);
  store = new SqliteRunStore(join(files.root, "projection.sqlite"));
  const ledger = store.pluginInstallationStore();
  await ledger.migrate();
  await ledger.compositionStore().migrate();
  let sequence = 0;
  const receipt = () => {
    const idempotencyKey = `projection-receipt-${++sequence}`;
    return { idempotencyKey, requestDigest: digester.sha256(idempotencyKey) };
  };
  for (const source of sources) {
    await installLocalPluginPackage({
      directory: source.directory,
      installRoot: files.installRoot,
      authorization: async (candidate) => ({
        outcome: registry.authorizeCandidate(candidate),
      }),
    });
    await ledger.recordInstalledPackage({
      scope,
      actor,
      receipt: receipt(),
      expectedSelectionRevision: null,
      package: {
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...scope,
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        version: source.version,
        packageDigest: source.packageDigest,
        installedAt: now,
        installedByPrincipalId: actor.principalId,
        installedByActorId: actor.actorId,
      },
    });
  }
  owner = await ledger.acquireProfileOwner({ scope, onOwnershipLost() {} });
  for (const source of sources) {
    if (source.disabled) continue;
    const selected = owner.currentSelection({
      scope,
      pluginId: source.pluginId,
    });
    assert.ok(selected);
    await owner.store.commitSelection({
      scope,
      actor,
      receipt: receipt(),
      expectedSelectionRevision: selected.revision,
      selection: {
        ...selected,
        revision: selected.revision + 1,
        state: "enabled",
        updatedAt: now,
      },
    });
  }
  const currentOwner = owner;
  const snapshot = currentOwner.snapshot();
  const sourceLock = createPluginCompositionLock(
    {
      schemaVersion: "crewon.plugin-composition-lock.v1",
      scope: compositionScope,
      revision: 1,
      hostServices: services.catalog.metadata,
      nodes: sources
        .filter((source) => !source.disabled)
        .map((source) => ({
          pluginId: source.pluginId,
          publisherId: source.publisherId,
          version: source.version,
          packageDigest: source.packageDigest,
          selectionRevision: snapshot.selections.find(
            (selected) => selected.pluginId === source.pluginId,
          )!.revision,
          hostApi: source.descriptor.hostApi,
          requires: source.descriptor.requires,
          provides: source.descriptor.provides,
        })),
    },
    digester,
  );
  assert.ok(currentOwner.store.compositionStore);
  await currentOwner.store.compositionStore().commit({
    scope: compositionScope,
    actor,
    lock: sourceLock,
    expectedRevision: null,
  });
  const input = {
    sourceLock,
    snapshot,
    scope: compositionScope,
    hostServices: services.catalog.metadata,
    installRoot: files.installRoot,
    registry,
    signal: new AbortController().signal,
    assertCurrent() {
      if (!installationSame(currentOwner.snapshot(), snapshot))
        throw new Error("projection_fixture_current_vector_changed");
    },
  };
  return {
    ...files,
    services,
    sources,
    sourceLock,
    snapshot,
    ledger,
    owner: currentOwner,
    input,
    configuration,
    project: (overrides: Partial<typeof input> = {}) =>
      projectDesktopPluginNodeComposition({ ...input, ...overrides }),
  };
}

function changedLock(
  lock: PluginCompositionLock,
  mutate: (
    nodes: PluginCompositionLock["nodes"],
  ) => PluginCompositionLock["nodes"],
) {
  return createPluginCompositionLock(
    {
      schemaVersion: lock.schemaVersion,
      scope: lock.scope,
      revision: lock.revision,
      hostServices: lock.hostServices,
      nodes: mutate(lock.nodes),
    },
    digester,
  );
}

test("actual full saved graph retains UI-only assets and historical lock while private Node planning preserves exact dependencies", async (t) => {
  const f = await fixture(t, [
    { id: "provider", provides: [{ service: "test.shared", apiVersion: "1" }] },
    {
      id: "consumer",
      requires: [
        { service: "test.shared", apiVersion: "1", optional: false },
        { service: "crewon.execution", apiVersion: "1", optional: false },
      ],
    },
    {
      id: "ui",
      uiOnly: true,
      requires: [
        { service: "crewon.project-texts", apiVersion: "1", optional: true },
      ],
    },
  ]);
  const before = JSON.stringify(f.sourceLock);
  const result = await f.project();
  assert.equal(result.sourceLockDigest, f.sourceLock.lockDigest);
  assert.notEqual(result.privateLock.lockDigest, f.sourceLock.lockDigest);
  assert.deepEqual(
    result.privateLock.nodes.map((node) => node.pluginId),
    ["test.consumer", "test.provider"],
  );
  assert.deepEqual(
    result.privateLock.edges,
    f.sourceLock.edges.filter((edge) => edge.consumerPluginId !== "test.ui"),
  );
  assert.deepEqual(result.privateLock.scope, f.sourceLock.scope);
  assert.deepEqual(result.privateLock.hostServices, f.sourceLock.hostServices);
  assert.equal(result.privateLock.revision, f.sourceLock.revision);
  assert.equal(JSON.stringify(f.sourceLock), before);
  assert.deepEqual(
    await f.ledger.compositionStore().loadCurrent({ scope }),
    f.sourceLock,
  );
  assert.deepEqual(
    await f.ledger.compositionStore().loadLock({
      scope,
      lockDigest: result.sourceLockDigest,
    }),
    f.sourceLock,
  );
  assert.equal(
    await f.ledger.compositionStore().loadLock({
      scope,
      lockDigest: result.privateLock.lockDigest,
    }),
    null,
  );
  assert.deepEqual(f.owner.snapshot(), f.snapshot);
  assert.ok(
    Object.isFrozen(result) && Object.isFrozen(result.privateLock.nodes),
  );
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
});

test("all Node graphs preserve their exact digest and absent optional dependency identities", async (t) => {
  const f = await fixture(t, [
    {
      id: "node",
      requires: [
        { service: "optional.absent", apiVersion: "1", optional: true },
      ],
    },
  ]);
  const result = await f.project();
  assert.deepEqual(result.privateLock, f.sourceLock);
  assert.deepEqual(result.privateLock.edges[0]?.provider, { kind: "absent" });
});

test("UI-only and disabled histories never become a Node instance or cause disabled package reads", async (t) => {
  const f = await fixture(t, [
    { id: "ui", uiOnly: true },
    { id: "disabled", disabled: true },
  ]);
  const disabled = f.sources.find((source) => source.disabled)!;
  const path = join(
    f.installRoot,
    "packages",
    disabled.packageDigest.slice(7),
    "node.mjs",
  );
  await chmod(path, 0o600);
  await writeFile(path, "corrupt disabled bytes must not be admitted");
  const result = await f.project();
  assert.deepEqual(result.privateLock.nodes, []);
  assert.equal(f.sourceLock.nodes.length, 1);
  assert.equal(
    (await f.ledger.compositionStore().loadCurrent({ scope }))?.nodes.length,
    1,
  );
});

test("full enabled selection vector rejects omitted nodes, stale revisions, changed identity and forged package audit", async (t) => {
  const f = await fixture(t, [{ id: "node" }, { id: "ui", uiOnly: true }]);
  for (const mutate of [
    (nodes: PluginCompositionLock["nodes"]) =>
      nodes.filter((node) => node.pluginId !== "test.ui"),
    (nodes: PluginCompositionLock["nodes"]) =>
      nodes.map((node) => ({
        ...node,
        selectionRevision: node.selectionRevision + 1,
      })),
    (nodes: PluginCompositionLock["nodes"]) =>
      nodes.map((node) => ({ ...node, publisherId: "test.other-publisher" })),
    (nodes: PluginCompositionLock["nodes"]) =>
      nodes.map((node) => ({ ...node, version: "2.0.0" })),
    (nodes: PluginCompositionLock["nodes"]) =>
      nodes.map((node) => ({
        ...node,
        packageDigest: digester.sha256(node.pluginId),
      })),
  ])
    await assert.rejects(
      f.project({ sourceLock: changedLock(f.sourceLock, mutate) }),
      /desktop_plugin_node_projection_selection_conflict/u,
    );
  await assert.rejects(
    f.project({
      snapshot: {
        ...f.snapshot,
        selectedPackages: f.snapshot.selectedPackages.slice(1),
      },
    }),
    /plugin_installation_selection_package_missing/u,
  );
  await assert.rejects(
    f.project({
      snapshot: {
        ...f.snapshot,
        selections: [...f.snapshot.selections, f.snapshot.selections[0]!],
      },
    }),
    /desktop_plugin_node_projection_vector_conflict/u,
  );
  await assert.rejects(
    f.project({
      snapshot: {
        ...f.snapshot,
        selectedPackages: f.snapshot.selectedPackages.map((pkg) => ({
          ...pkg,
          publisherId: "test.forged-publisher",
        })),
      },
    }),
    /plugin_installation_selection_package_mismatch/u,
  );
});

test("saved declarations cannot replace actual installed requires/provides or a checked lock digest", async (t) => {
  const f = await fixture(t, [{ id: "node" }]);
  for (const mutate of [
    (nodes: PluginCompositionLock["nodes"]) =>
      nodes.map((node) => ({
        ...node,
        requires: [
          { service: "forged.optional", apiVersion: "1", optional: true },
        ],
      })),
    (nodes: PluginCompositionLock["nodes"]) =>
      nodes.map((node) => ({
        ...node,
        provides: [{ service: "forged.provider", apiVersion: "1" }],
      })),
  ])
    await assert.rejects(
      f.project({ sourceLock: changedLock(f.sourceLock, mutate) }),
      /desktop_plugin_node_projection_descriptor_conflict/u,
    );
  await assert.rejects(
    projectDesktopPluginNodeComposition({
      ...f.input,
      sourceLock: { ...f.sourceLock, lockDigest: digester.sha256("forged") },
    }),
    /plugin_composition_digest_mismatch/u,
  );
  await assert.rejects(
    projectDesktopPluginNodeComposition({
      ...f.input,
      sourceLock: {
        ...f.sourceLock,
        nodes: f.sourceLock.nodes.map((node) => ({
          ...node,
          hostApi: "crewon.plugin-host.v2",
        })),
      },
    }),
    /plugin_composition_/u,
  );
});

test("scope epoch and actual host implementation identity must match the supplied saved graph", async (t) => {
  const f = await fixture(t, [{ id: "node" }]);
  for (const wrong of [
    { ...compositionScope, authorityEpoch: "another-actual-epoch" },
    { ...compositionScope, profileId: "another-profile" },
  ])
    await assert.rejects(
      f.project({ scope: wrong }),
      /desktop_plugin_node_projection_scope_conflict/u,
    );
  await assert.rejects(
    f.project({
      hostServices: f.input.hostServices.map((host) => ({
        ...host,
        implementationRevision: host.implementationRevision + 1,
      })),
    }),
    /desktop_plugin_node_projection_catalog_conflict/u,
  );
  await assert.rejects(
    f.project({
      snapshot: {
        ...f.snapshot,
        scope: { ...scope, profileId: "another-profile" },
      },
    }),
    /plugin_installation_scope_mismatch/u,
  );
});

test("actual installed byte verification and current approved source registry cannot be bypassed by valid metadata", async (t) => {
  const f = await fixture(t, [{ id: "node" }]);
  const denied = await createDesktopPluginSourceRegistry(
    parseDesktopPluginConfiguration({ ...f.configuration, sources: [] }),
  );
  await assert.rejects(
    f.project({ registry: denied }),
    /plugin_installation_package_unapproved/u,
  );
  const path = join(
    f.installRoot,
    "packages",
    f.sources[0]!.packageDigest.slice(7),
    "node.mjs",
  );
  await chmod(path, 0o600);
  await writeFile(path, "changed installed closure");
  await assert.rejects(f.project(), /plugin_package_/u);
});

test("mandatory and bound optional Node dependencies cannot silently discard a UI-only provider", async (t) => {
  for (const optional of [false, true]) {
    const f = await fixture(t, [
      {
        id: `consumer-${optional}`,
        requires: [{ service: "test.ui-provision", apiVersion: "1", optional }],
      },
      {
        id: `ui-${optional}`,
        uiOnly: true,
        provides: [{ service: "test.ui-provision", apiVersion: "1" }],
      },
    ]);
    // Current UI compatibility already forbids UI service providers. Projection
    // also rejects an original Node->UI edge if that compatibility grows later.
    await assert.rejects(f.project(), /plugin_ui_only_services_unsupported/u);
    assert.equal(
      (await f.ledger.compositionStore().loadCurrent({ scope }))?.nodes.length,
      2,
    );
  }
});

test("required synchronous fences observe actual owner withdrawal after package verification awaits", async (t) => {
  const f = await fixture(t, [{ id: "node" }]);
  let checks = 0;
  let closing: Promise<void> | undefined;
  await assert.rejects(
    f.project({
      assertCurrent() {
        if (++checks === 2) closing = f.owner.close();
        else f.input.assertCurrent();
      },
    }),
    /plugin_profile_owner_unavailable/u,
  );
  await closing;
  assert.equal(checks, 3);
  await assert.rejects(
    projectDesktopPluginNodeComposition({
      ...f.input,
      assertCurrent: undefined as unknown as () => void,
    }),
    /desktop_plugin_node_projection_fence_required/u,
  );
});

test("abort during an actual asynchronous package read cannot return a usable projection", async (t) => {
  const f = await fixture(t, [{ id: "node" }]);
  const controller = new AbortController();
  const result = f.project({ signal: controller.signal });
  const reason = new Error("projection-test-aborted");
  controller.abort(reason);
  await assert.rejects(result, (error) => error === reason);
});

test("caller mutation after verification starts cannot rewrite captured graph or confirmed vector", async (t) => {
  const f = await fixture(t, [{ id: "node" }, { id: "ui", uiOnly: true }]);
  const sourceLock = structuredClone(f.sourceLock);
  const snapshot = {
    ...f.snapshot,
    selections: f.snapshot.selections.map((entry) => ({ ...entry })),
    selectedPackages: f.snapshot.selectedPackages.map((entry) => ({
      ...entry,
    })),
  };
  const result = f.project({ sourceLock, snapshot });
  Object.assign(sourceLock.nodes[0]!, {
    version: "9.0.0",
    selectionRevision: 99,
  });
  snapshot.selections.splice(0);
  const projected = await result;
  assert.equal(projected.sourceLockDigest, f.sourceLock.lockDigest);
  assert.deepEqual(
    projected.privateLock.nodes.map((node) => node.version),
    ["1.0.0"],
  );
  assert.deepEqual(
    await f.ledger.compositionStore().loadCurrent({ scope }),
    f.sourceLock,
  );
});
