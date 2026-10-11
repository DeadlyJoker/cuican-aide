import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  ApplicationError,
  PluginInstallationApplicationService,
} from "@crewon/application";
import {
  PLUGIN_COMPOSITION_STATUS_SCHEMA,
  type PluginSelectionListQuery,
} from "@crewon/contracts";
import {
  LocalPluginInstallationHost,
  PluginNodeHost,
  verifyLocalPluginPackage,
} from "@crewon/plugin-host";
import {
  SqliteRunStore,
  type SqlitePluginInstallationProfileOwner,
} from "@crewon/store";
import type { DesktopPluginCompositionMetadataState } from "./desktop-plugin-composition-metadata-owner.ts";
import {
  projectDesktopPluginCompositionStatus,
  type DesktopPluginCompositionStatusObservation,
} from "./desktop-plugin-composition-status-owner.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";

const actor = Object.freeze({
  tenantId: "tenant-status",
  spaceId: "space-status",
  principalId: "principal-status",
  actorId: "actor-status",
});
const scope = Object.freeze({
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "profile-status",
});
const firstPage = Object.freeze({ afterPluginId: null, limit: 20 });
const published = Object.freeze({
  outcome: "published",
  lockDigest: `sha256:${"a".repeat(64)}`,
  revision: 1,
}) satisfies DesktopPluginCompositionMetadataState;
type Source = Awaited<
  ReturnType<Awaited<ReturnType<typeof productionSourceFixture>>["source"]>
>;

/** Real immutable local package bytes, Node lifecycle and held file-backed SQLite claim. */
async function fixture(t: TestContext) {
  let node: PluginNodeHost | undefined;
  let owner: SqlitePluginInstallationProfileOwner | undefined;
  let store: SqliteRunStore | undefined;
  let expectedCleanupFailure = false;
  const leases = new Set<ReturnType<PluginNodeHost["acquire"]>>();
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      for (const lease of leases) lease.release();
      try {
        try {
          await node?.close();
        } catch (error) {
          if (!expectedCleanupFailure) throw error;
          assert.ok(error instanceof AggregateError);
          assert.equal(error.message, "plugin_cleanup_failed");
        }
      } finally {
        await owner?.close();
        await store?.close();
      }
    },
  });
  store = new SqliteRunStore(join(f.root, "control.sqlite"));
  const ledger = store.pluginInstallationStore();
  await ledger.migrate();
  owner = await ledger.acquireProfileOwner({ scope, onOwnershipLost() {} });
  const actualOwner = owner;
  node = new PluginNodeHost({ services: [] });
  const actualNode = node;
  const sources = new Map<string, string>();
  const local = new LocalPluginInstallationHost({
    profile: scope,
    installRoot: f.installRoot,
    nodeHost: actualNode,
    resolveSource: async ({ sourceId }) => {
      const directory = sources.get(sourceId);
      assert.ok(directory);
      return directory;
    },
    authorizeInstallation: async () => "allow",
    authorizeActivation: async () => "allow",
    validateCompatibility: async () => {},
    authorizeCommit: ({ selection }) =>
      JSON.stringify(
        actualOwner.currentSelection({ scope, pluginId: selection.pluginId }),
      ) === JSON.stringify(selection)
        ? "allow"
        : "deny",
  });
  const application = new PluginInstallationApplicationService({
    store: actualOwner.store,
    profiles: { resolve: async () => scope },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    host: local,
    clock: { now: () => "2026-10-11T00:00:00.000Z" },
    digester: {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
  });
  let sequence = 0;
  const install = async (
    source: Source,
    expectedSelectionRevision: number | null = null,
  ) => {
    sources.set(source.sourceId, source.directory);
    return application.install(actor, {
      sourceId: source.sourceId,
      expectedPluginId: source.pluginId,
      expectedPackageDigest: source.packageDigest,
      expectedSelectionRevision,
      idempotencyKey: `install-${++sequence}`,
    });
  };
  const select = (
    source: Source,
    expectedSelectionRevision: number,
    state: "enabled" | "disabled" | "uninstalled" = "enabled",
  ) =>
    application.select(actor, {
      pluginId: source.pluginId,
      state,
      expectedSelectionRevision,
      selectedPackageDigest:
        state === "uninstalled" ? null : source.packageDigest,
      idempotencyKey: `select-${++sequence}`,
    });
  const capture = async (
    query: PluginSelectionListQuery = firstPage,
    metadata: DesktopPluginCompositionMetadataState = published,
  ): Promise<DesktopPluginCompositionStatusObservation> =>
    Object.freeze({
      scope,
      query,
      page: await application.listSelections(actor, query),
      projection: actualOwner.snapshot(),
      nodes: actualNode.snapshot(),
      metadata,
    });
  return {
    ...f,
    application,
    owner: actualOwner,
    node: actualNode,
    local,
    install,
    select,
    capture,
    borrow(source: Source) {
      const lease = actualNode.acquire({
        pluginId: source.pluginId,
        packageDigest: source.packageDigest,
        purpose: "newOperation",
        authorizeBorrow: () => "allow",
      });
      leases.add(lease);
      return lease;
    },
    expectCleanupFailure() {
      expectedCleanupFailure = true;
    },
  };
}

test("status projects actual admission; published metadata, cold reopen and retained leases never invent readiness", async (t) => {
  const f = await fixture(t);
  const source = await f.source("live", { validNode: true });
  await f.install(source);
  assert.deepEqual(
    projectDesktopPluginCompositionStatus(await f.capture()).plugins[0]!.node,
    { state: "inactive" },
  );
  assert.equal((await f.select(source, 1)).projection.outcome, "applied");
  const ready = projectDesktopPluginCompositionStatus(await f.capture());
  assert.equal(ready.schemaVersion, PLUGIN_COMPOSITION_STATUS_SCHEMA);
  assert.deepEqual(ready.plugins[0]!.node, { state: "ready" });
  assert.deepEqual(ready.metadata, {
    state: "published",
    lockDigest: published.lockDigest,
    revision: 1,
  });
  const metadataFailure = projectDesktopPluginCompositionStatus(
    await f.capture(firstPage, {
      outcome: "unavailable",
      code: "plugin_projection_pending",
    }),
  );
  assert.deepEqual(metadataFailure.plugins[0]!.node, { state: "ready" });
  assert.deepEqual(metadataFailure.metadata, {
    state: "failed",
    reasonCode: "plugin_projection_pending",
  });
  const before = await readFile(f.marker, "utf8");
  projectDesktopPluginCompositionStatus(await f.capture());
  assert.equal(await readFile(f.marker, "utf8"), before);
  for (const privateText of [
    scope.tenantId,
    scope.spaceId,
    scope.profileId,
    actor.principalId,
    actor.actorId,
    f.root,
    "borrowers",
  ])
    assert.equal(JSON.stringify(ready).includes(privateText), false);
  assert.ok(Object.isFrozen(ready));
  assert.ok(Object.isFrozen(ready.plugins[0]!.node));

  const cold = new PluginNodeHost({ services: [] });
  try {
    assert.deepEqual(
      projectDesktopPluginCompositionStatus({
        ...(await f.capture()),
        nodes: cold.snapshot(),
      }).plugins[0]!.node,
      { state: "unobserved" },
    );
    assert.equal(await readFile(f.marker, "utf8"), before);
  } finally {
    await cold.close();
  }
  const lease = f.borrow(source);
  f.node.deactivate(source.pluginId);
  assert.deepEqual(
    f.node.snapshot().map((entry) => entry.phase),
    ["retained"],
  );
  assert.deepEqual(
    projectDesktopPluginCompositionStatus(await f.capture()).plugins[0]!.node,
    { state: "unobserved" },
  );
  assert.throws(() => f.borrow(source), /plugin_instance_unavailable/);
  const prepared = await f.node.prepare({
    installRoot: f.installRoot,
    expectedPluginId: source.pluginId,
    expectedPackageDigest: source.packageDigest,
    authorizeActivation: () => "allow",
  });
  assert.deepEqual(
    projectDesktopPluginCompositionStatus(await f.capture()).plugins[0]!.node,
    { state: "preparing" },
  );
  await prepared.abort();
  await f.select(source, 2, "disabled");
  const inactive = projectDesktopPluginCompositionStatus(await f.capture());
  assert.deepEqual(inactive.plugins[0]!.node, { state: "inactive" });
  assert.ok(
    f.node
      .snapshot()
      .some((entry) => entry.phase === "retained" && entry.borrowers === 1),
  );
  lease.release();
  await f.node.drain();
});

test("an upgraded selected package is ready only for its exact actual version and digest", async (t) => {
  const f = await fixture(t);
  const first = await f.source("first", { validNode: true });
  await f.install(first);
  await f.select(first, 1);
  const old = f.borrow(first);
  const next = await f.source("next", { validNode: true, version: "2.0.0" });
  await f.install(next, 2);
  await f.select(next, 2);
  assert.ok(
    f.node
      .snapshot()
      .some(
        (entry) =>
          entry.identity.packageDigest === first.packageDigest &&
          entry.phase === "retained",
      ),
  );
  assert.deepEqual(
    projectDesktopPluginCompositionStatus(await f.capture()).plugins[0]!.node,
    { state: "ready" },
  );
  f.node.deactivate(next.pluginId);
  await f.node.drain();
  assert.deepEqual(
    projectDesktopPluginCompositionStatus(await f.capture()).plugins[0]!.node,
    { state: "unobserved" },
  );
  await f.node.activate({
    installRoot: f.installRoot,
    expectedPluginId: next.pluginId,
    expectedPackageDigest: next.packageDigest,
    authorizeActivation: () => "allow",
  });
  const frame = await f.capture();
  assert.deepEqual(
    projectDesktopPluginCompositionStatus({
      ...frame,
      nodes: frame.nodes.map((entry) =>
        entry.phase === "accepting"
          ? { ...entry, identity: { ...entry.identity, version: "3.0.0" } }
          : entry,
      ),
    }).plugins[0]!.node,
    { state: "unobserved" },
  );
  old.release();
  await f.node.drain();
});

test("a real UI-only enabled package stays Node-unobserved and metadata failures remain separate", async (t) => {
  const f = await fixture(t);
  const source = await f.source("ui", { uiOnly: true });
  await f.install(source);
  await f.select(source, 1);
  assert.deepEqual(f.node.snapshot(), []);
  const result = projectDesktopPluginCompositionStatus(await f.capture());
  assert.deepEqual(result.plugins[0]!.node, { state: "unobserved" });
  const pending = projectDesktopPluginCompositionStatus(
    await f.capture(firstPage, {
      outcome: "unavailable",
      code: "plugin_projection_pending",
    }),
  );
  assert.deepEqual(pending.metadata, {
    state: "failed",
    reasonCode: "plugin_projection_pending",
  });
  const failed = projectDesktopPluginCompositionStatus(
    await f.capture(firstPage, {
      outcome: "unavailable",
      code: "desktop_plugin_private_failure",
    }),
  );
  assert.deepEqual(failed.metadata, {
    state: "failed",
    reasonCode: "plugin_composition_metadata_unavailable",
  });
  assert.deepEqual(failed.plugins[0]!.node, { state: "unobserved" });
  assert.equal(
    JSON.stringify(failed).includes("desktop_plugin_private_failure"),
    false,
  );
});

test("an old cleanup failure does not hide new admission, and remains visible after disable and uninstall", async (t) => {
  const f = await fixture(t);
  const source = await f.source("cleanup", { validNode: true });
  const bytes = Buffer.from(
    `export default {apiVersion:'crewon.plugin-host.v1',pluginId:'test.report',setup(){return {dispose(){throw new Error('private-cleanup-path-secret');}};}};`,
  );
  await writeFile(join(source.directory, "node.mjs"), bytes);
  const descriptor = {
    ...source.descriptor,
    files: [
      {
        path: "node.mjs",
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  await writeFile(
    join(source.directory, "crewon.plugin.json"),
    JSON.stringify(descriptor),
  );
  const actual = {
    ...source,
    descriptor,
    packageDigest: (
      await verifyLocalPluginPackage({ directory: source.directory })
    ).packageDigest,
  };
  await f.install(actual);
  await f.select(actual, 1);
  const old = f.borrow(actual);
  const next = await f.source("cleanup-next", {
    validNode: true,
    version: "2.0.0",
  });
  await f.install(next, 2);
  await f.select(next, 2);
  f.expectCleanupFailure();
  old.release();
  await assert.rejects(f.node.drain(), /plugin_cleanup_failed/);
  assert.ok(
    f.node
      .snapshot()
      .some(
        (entry) =>
          entry.identity.packageDigest === actual.packageDigest &&
          entry.phase === "cleanupFailed",
      ),
  );
  assert.deepEqual(
    projectDesktopPluginCompositionStatus(await f.capture()).plugins[0]!.node,
    { state: "ready" },
  );
  await f.select(next, 3, "disabled");
  for (const revision of [4, 5]) {
    if (revision === 5) await f.select(next, 4, "uninstalled");
    const result = projectDesktopPluginCompositionStatus(await f.capture());
    assert.deepEqual(result.plugins[0]!.node, {
      state: "failed",
      reasonCode: "plugin_cleanup_failed",
    });
    assert.equal(
      JSON.stringify(result).includes("private-cleanup-path-secret"),
      false,
    );
  }
});

test("actual owned selection pagination is bounded and cannot omit, reorder or cross profile observations", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 51; index++) {
    const source = await f.source(`page-${index}`, {
      uiOnly: true,
      pluginId: `test.page${String(index).padStart(2, "0")}`,
    });
    await f.install(source);
  }
  const frame = await f.capture(
    { afterPluginId: null, limit: 50 },
    { outcome: "unknown" },
  );
  const result = projectDesktopPluginCompositionStatus(frame);
  assert.equal(result.plugins.length, 50);
  assert.equal(result.next, "test.page49");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024);
  assert.deepEqual(result.metadata, { state: "unobserved" });
  const last = projectDesktopPluginCompositionStatus(
    await f.capture({ afterPluginId: result.next, limit: 50 }),
  );
  assert.equal(last.plugins.length, 1);
  assert.equal(last.next, null);
  const invalidFrames = [
    { ...frame, scope: { ...scope, tenantId: "another-tenant" } },
    { ...frame, query: { afterPluginId: null, limit: 51 } },
    {
      ...frame,
      page: { ...frame.page, selections: frame.page.selections.slice(1) },
    },
    {
      ...frame,
      page: { ...frame.page, selections: [...frame.page.selections].reverse() },
    },
    { ...frame, page: { ...frame.page, next: null } },
    { ...frame, projection: { ...frame.projection, selectedPackages: [] } },
  ];
  for (const invalid of invalidFrames)
    assert.throws(
      () => projectDesktopPluginCompositionStatus(invalid),
      invalidObservation,
    );
});

test("malformed internal frames fail closed without invoking accessors or accepting impossible live state", async (t) => {
  const f = await fixture(t);
  const source = await f.source("strict", { validNode: true });
  await f.install(source);
  await f.select(source, 1);
  const frame = await f.capture();
  const active = frame.nodes.find((entry) => entry.phase === "accepting")!;
  const forbidden = [
    { ...frame, nodes: [active, active] },
    { ...frame, nodes: Array.from({ length: 257 }, () => active) },
    { ...frame, nodes: [{ ...active, phase: "ready" }] },
    {
      ...frame,
      nodes: [
        { ...active, identity: { ...active.identity, privatePath: f.root } },
      ],
    },
    { ...frame, metadata: { ...published, exception: "private" } },
  ];
  for (const invalid of forbidden)
    assert.throws(
      () =>
        projectDesktopPluginCompositionStatus(
          invalid as DesktopPluginCompositionStatusObservation,
        ),
      invalidObservation,
    );
  let getterCalls = 0;
  const getterNode = Object.defineProperty({ ...active }, "identity", {
    enumerable: true,
    get() {
      getterCalls++;
      return active.identity;
    },
  });
  assert.throws(
    () =>
      projectDesktopPluginCompositionStatus({ ...frame, nodes: [getterNode] }),
    invalidObservation,
  );
  const getterArray = [active];
  Object.defineProperty(getterArray, "0", {
    enumerable: true,
    get() {
      getterCalls++;
      return active;
    },
  });
  assert.throws(
    () =>
      projectDesktopPluginCompositionStatus({ ...frame, nodes: getterArray }),
    invalidObservation,
  );
  assert.equal(getterCalls, 0);
  await f.select(source, 2, "disabled");
  const disabled = await f.capture();
  assert.throws(
    () =>
      projectDesktopPluginCompositionStatus({ ...disabled, nodes: [active] }),
    invalidObservation,
  );
});

function invalidObservation(error: unknown): boolean {
  return (
    error instanceof ApplicationError &&
    error.category === "internal" &&
    error.code === "plugin_composition_status_observation_invalid"
  );
}
