import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPluginCompositionLock,
  type PluginCompositionNode,
  type PluginCompositionHostService,
} from "@crewon/contracts/plugins";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";
import {
  PluginCompositionCoordinator,
  type PluginCompositionAuthority,
} from "./plugin-composition-coordinator.ts";

const scope = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  profileId: "profile-1",
  authorityEpoch: "epoch-1",
};
const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
const allow: PluginCompositionAuthority = {
  authorizePreparation: () => "allow",
  authorizePublication: () => "allow",
};
const borrow = (lockDigest: string, pluginId = "example.consumer") => ({
  lockDigest,
  pluginId,
  authorizeBorrow: () => "allow" as const,
});
const service = [{ service: "story.source", apiVersion: "1" }];
async function writable(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await writable(join(directory, entry.name));
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crewon-composition-"));
  await mkdir(join(root, "installed"), { mode: 0o700 });
  const coordinators: PluginCompositionCoordinator[] = [];
  t.after(async () => {
    try {
      for (const coordinator of coordinators) await coordinator.close();
    } finally {
      await writable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
  let sequence = 0;
  const make = async (input: {
    pluginId: string;
    setup: string;
    version?: string;
    requires?: PluginCompositionNode["requires"];
    provides?: PluginCompositionNode["provides"];
  }) => {
    const directory = await mkdtemp(join(root, "source-"));
    const log = join(root, `log-${sequence++}`);
    const bytes = Buffer.from(`import {appendFileSync} from 'node:fs';
const record=(text)=>appendFileSync(${JSON.stringify(log)},text+'\\n'); record('load');
export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(input.pluginId)},async setup(ctx){record('setup');${input.setup};return {dispose(){record('dispose')}}}};`);
    await writeFile(join(directory, "entry.mjs"), bytes);
    await writeFile(
      join(directory, "crewon.plugin.json"),
      JSON.stringify({
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId: input.pluginId,
        version: input.version ?? "1.0.0",
        title: "Fixture",
        description: "Actual composition fixture",
        publisherId: "example",
        entrypoints: { node: "entry.mjs", ui: null },
        businessManifestPath: null,
        requires: input.requires ?? [],
        provides: input.provides ?? [],
        contributions: [],
        files: [
          {
            path: "entry.mjs",
            byteLength: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      }),
    );
    const installed = await installLocalPluginPackage({
      directory,
      installRoot: join(root, "installed"),
      authorization: async () => ({ outcome: "allow" }),
    });
    const descriptor = installed.descriptor;
    const node: PluginCompositionNode = {
      pluginId: descriptor.pluginId,
      publisherId: descriptor.publisherId,
      version: descriptor.version,
      packageDigest: installed.packageDigest,
      hostApi: descriptor.hostApi,
      selectionRevision: 1,
      requires: descriptor.requires,
      provides: descriptor.provides,
    };
    return {
      node,
      async records() {
        try {
          return (await readFile(log, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      },
    };
  };
  const source = await make({
    pluginId: "example.source",
    provides: service,
    setup: `ctx.services.provide('story.source','1',{read:()=>1})`,
  });
  const consumer = await make({
    pluginId: "example.consumer",
    requires: [{ ...service[0]!, optional: false }],
    provides: [{ service: "story.consumer", apiVersion: "1" }],
    setup: `const source=ctx.services.get('story.source','1');ctx.services.provide('story.consumer','1',{read:()=>source.read()})`,
  });
  const independent = await make({
    pluginId: "example.independent",
    setup: "",
  });
  const nodes = [source.node, consumer.node, independent.node];
  const lock = (
    revision = 1,
    selected = nodes,
    hostServices: readonly PluginCompositionHostService[] = [],
  ) =>
    createPluginCompositionLock(
      {
        schemaVersion: "crewon.plugin-composition-lock.v1",
        scope,
        revision,
        nodes: selected,
        hostServices,
      },
      digester,
    );
  const coordinator = new PluginCompositionCoordinator({
    scope,
    installRoot: join(root, "installed"),
    services: [],
  });
  coordinators.push(coordinator);
  return {
    make,
    source,
    consumer,
    independent,
    nodes,
    lock,
    coordinator,
    installRoot: join(root, "installed"),
    ownCoordinator(value: PluginCompositionCoordinator) {
      coordinators.push(value);
    },
  };
}

test("real scoped composition upgrades only the affected subtree and retains old provider until the original lease releases", async (t) => {
  const f = await fixture(t),
    original = f.lock();
  assert.deepEqual(
    (await f.coordinator.synchronize({ lock: original, authority: allow }))
      .failures,
    [],
  );
  const old = f.coordinator.acquireCurrent(borrow(original.lockDigest));
  assert.equal(
    old.getService<{ read(): number }>("story.consumer", "1").read(),
    1,
  );
  const upgraded = await f.make({
    pluginId: "example.source",
    version: "2.0.0",
    provides: service,
    setup: `ctx.services.provide('story.source','1',{read:()=>2})`,
  });
  const next = f.lock(2, [
    { ...upgraded.node, selectionRevision: 2 },
    f.consumer.node,
    f.independent.node,
  ]);
  assert.deepEqual(
    (await f.coordinator.synchronize({ lock: next, authority: allow }))
      .failures,
    [],
  );
  const current = f.coordinator.acquireCurrent(borrow(next.lockDigest));
  assert.equal(
    current.getService<{ read(): number }>("story.consumer", "1").read(),
    2,
  );
  assert.equal(
    old.getService<{ read(): number }>("story.consumer", "1").read(),
    1,
  );
  assert.deepEqual(await f.independent.records(), ["load", "setup"]);
  assert.ok(!(await f.source.records()).includes("dispose"));
  current.release();
  old.release();
  await f.coordinator.drain();
  assert.equal(
    (await f.source.records()).filter((value) => value === "dispose").length,
    1,
  );
  assert.throws(
    () => f.coordinator.acquireCurrent(borrow(original.lockDigest)),
    /current_unavailable/,
  );
});

test("publication denial isolates a consumer; explicit fresh authorization restores it without restarting the provider", async (t) => {
  const f = await fixture(t),
    lock = f.lock();
  const denied = await f.coordinator.synchronize({
    lock,
    authority: {
      ...allow,
      authorizePublication: ({ node }) =>
        node.pluginId === "example.consumer" ? "deny" : "allow",
    },
  });
  assert.deepEqual(denied.activePluginIds, [
    "example.independent",
    "example.source",
  ]);
  assert.deepEqual(denied.failures, [
    {
      pluginId: "example.consumer",
      code: "plugin_composition_publication_denied",
    },
  ]);
  assert.throws(
    () => f.coordinator.acquireCurrent(borrow(lock.lockDigest)),
    /instance_unavailable/,
  );
  assert.deepEqual(
    (await f.coordinator.synchronize({ lock, authority: allow })).failures,
    [],
  );
  assert.equal(
    (await f.source.records()).filter((value) => value === "setup").length,
    1,
  );
  const lease = f.coordinator.acquireCurrent(borrow(lock.lockDigest));
  lease.release();
});

test("synchronous revocation withdraws consumers; an old lease survives and restoration requires explicit new host authorization", async (t) => {
  const f = await fixture(t),
    lock = f.lock();
  await f.coordinator.synchronize({ lock, authority: allow });
  const old = f.coordinator.acquireCurrent(borrow(lock.lockDigest));
  f.coordinator.revoke("example.source");
  assert.throws(
    () => f.coordinator.acquireCurrent(borrow(lock.lockDigest)),
    /instance_unavailable/,
  );
  assert.equal(
    old.getService<{ read(): number }>("story.consumer", "1").read(),
    1,
  );
  const denied = await f.coordinator.synchronize({
    lock,
    authority: {
      ...allow,
      authorizePreparation: ({ node }) =>
        node.pluginId === "example.source" ? "deny" : "allow",
    },
  });
  assert.ok(!denied.activePluginIds.includes("example.source"));
  assert.ok(!denied.activePluginIds.includes("example.consumer"));
  assert.deepEqual(await f.independent.records(), ["load", "setup"]);
  await f.coordinator.synchronize({ lock, authority: allow });
  const restored = f.coordinator.acquireCurrent(borrow(lock.lockDigest));
  restored.release();
  await assert.rejects(f.coordinator.close(), /live_leases/);
  old.release();
  await f.coordinator.close();
});

test("revocation during asynchronous setup prevents late publication and joins cleanup", async (t) => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const metadata = {
    service: "host.gate",
    apiVersion: "1",
    implementationId: "gate",
    implementationRevision: 1,
  };
  const pkg = await f.make({
    pluginId: "example.waiting",
    requires: [{ service: "host.gate", apiVersion: "1", optional: false }],
    setup: `await ctx.services.get('host.gate','1').wait()`,
  });
  const coordinator = new PluginCompositionCoordinator({
    scope,
    installRoot: f.installRoot,
    services: [
      {
        metadata,
        implementation: {
          service: "host.gate",
          apiVersion: "1",
          value: {
            wait() {
              entered();
              return gate;
            },
          },
        },
      },
    ],
  });
  f.ownCoordinator(coordinator);
  const lock = f.lock(1, [pkg.node], [metadata]);
  const pending = coordinator.synchronize({ lock, authority: allow });
  const rejected = assert.rejects(pending, /superseded/);
  await started;
  coordinator.revoke(pkg.node.pluginId);
  release();
  await rejected;
  await coordinator.drain();
  assert.deepEqual(await pkg.records(), ["load", "setup", "dispose"]);
  assert.throws(
    () =>
      coordinator.acquireCurrent(borrow(lock.lockDigest, pkg.node.pluginId)),
    /instance_unavailable/,
  );
});

test("reentrant publication revocation cannot be hidden by an allow callback", async (t) => {
  const f = await fixture(t),
    lock = f.lock();
  await assert.rejects(
    f.coordinator.synchronize({
      lock,
      authority: {
        ...allow,
        authorizePublication: ({ node }) => {
          f.coordinator.revoke(node.pluginId);
          return "allow";
        },
      },
    }),
    /superseded/,
  );
  await f.coordinator.drain();
  assert.throws(
    () =>
      f.coordinator.acquireCurrent(
        borrow(lock.lockDigest, "example.independent"),
      ),
    /instance_unavailable/,
  );
  assert.ok((await f.source.records()).includes("dispose"));
  assert.deepEqual(await f.independent.records(), []);
});

test("tampered scope, host metadata, stale revisions and false package declarations cannot load plugin code", async (t) => {
  const f = await fixture(t),
    original = f.lock();
  const foreign = createPluginCompositionLock(
    {
      schemaVersion: original.schemaVersion,
      scope: { ...scope, profileId: "other" },
      revision: 2,
      nodes: original.nodes,
      hostServices: [],
    },
    digester,
  );
  await assert.rejects(
    f.coordinator.synchronize({ lock: foreign, authority: allow }),
    /scope_conflict/,
  );
  await assert.rejects(
    f.coordinator.synchronize({
      lock: { ...original, lockDigest: `sha256:${"0".repeat(64)}` },
      authority: allow,
    }),
    /digest_mismatch/,
  );
  const extraHost = f.lock(1, f.nodes, [
    {
      service: "host.unapproved",
      apiVersion: "1",
      implementationId: "unapproved",
      implementationRevision: 1,
    },
  ]);
  await assert.rejects(
    f.coordinator.synchronize({ lock: extraHost, authority: allow }),
    /host_service_conflict/,
  );
  await assert.rejects(
    f.coordinator.synchronize({
      lock: original,
      authority: {} as PluginCompositionAuthority,
    }),
    /authority_missing/,
  );
  assert.deepEqual(await f.source.records(), []);
  assert.deepEqual(await f.consumer.records(), []);
  const fake = f.lock(2, [
    { ...f.source.node, publisherId: "forged" },
    f.consumer.node,
    f.independent.node,
  ]);
  const result = await f.coordinator.synchronize({
    lock: fake,
    authority: allow,
  });
  assert.ok(
    result.failures.some(
      (entry) =>
        entry.pluginId === "example.source" &&
        entry.code === "plugin_composition_package_conflict",
    ),
  );
  assert.deepEqual(
    await f.source.records(),
    [],
    "actual descriptor is checked before import and setup",
  );
  await assert.rejects(
    f.coordinator.synchronize({ lock: original, authority: allow }),
    /revision_conflict/,
  );
});

test("queued older snapshots are superseded, while the captured latest graph is immune to caller mutation", async (t) => {
  const f = await fixture(t),
    first = f.lock(),
    second = f.lock(2);
  const older = assert.rejects(
    f.coordinator.synchronize({ lock: first, authority: allow }),
    /superseded/,
  );
  const mutable = JSON.parse(JSON.stringify(second));
  const latest = f.coordinator.synchronize({ lock: mutable, authority: allow });
  mutable.nodes.length = 0;
  await older;
  assert.equal((await latest).activePluginIds.length, 3);
  assert.equal(
    (await f.source.records()).filter((value) => value === "setup").length,
    1,
  );
  const current = f.coordinator.acquireCurrent(borrow(second.lockDigest));
  current.release();
});

test("a reentrant desired-head change during borrowing cannot issue a lease against the old graph", async (t) => {
  const f = await fixture(t),
    first = f.lock(),
    second = f.lock(2);
  await f.coordinator.synchronize({ lock: first, authority: allow });
  let next: ReturnType<PluginCompositionCoordinator["synchronize"]> | undefined;
  assert.throws(
    () =>
      f.coordinator.acquireCurrent({
        ...borrow(first.lockDigest),
        authorizeBorrow: () => {
          next = f.coordinator.synchronize({ lock: second, authority: allow });
          return "allow";
        },
      }),
    /superseded/,
  );
  assert.ok(next);
  await next;
  // No leaked borrower: full physical close completes without releasing an old lease.
  await f.coordinator.close();
});

test("unchanged retained instances require fresh authorization and a denial immediately withdraws their consumers", async (t) => {
  const f = await fixture(t),
    lock = f.lock();
  await f.coordinator.synchronize({ lock, authority: allow });
  const old = f.coordinator.acquireCurrent(borrow(lock.lockDigest));
  const denied = await f.coordinator.synchronize({
    lock,
    authority: {
      ...allow,
      authorizePublication: ({ node }) =>
        node.pluginId === "example.source" ? "deny" : "allow",
    },
  });
  assert.deepEqual(denied.activePluginIds, ["example.independent"]);
  assert.ok(
    denied.failures.some(
      (entry) =>
        entry.pluginId === "example.source" &&
        entry.code === "plugin_composition_publication_denied",
    ),
  );
  assert.throws(
    () => f.coordinator.acquireCurrent(borrow(lock.lockDigest)),
    /instance_unavailable/,
  );
  assert.equal(
    old.getService<{ read(): number }>("story.consumer", "1").read(),
    1,
  );
  assert.equal(
    (await f.source.records()).filter((value) => value === "setup").length,
    1,
  );
  assert.equal(
    (await f.independent.records()).filter((value) => value === "setup").length,
    1,
  );
  old.release();
  await f.coordinator.drain();
});

test("actual optional consumer is re-prepared when its provider arrives and disappears, while each old lease keeps its captured service", async (t) => {
  const f = await fixture(t);
  const optional = await f.make({
    pluginId: "example.optional",
    requires: [{ ...service[0]!, optional: true }],
    provides: [{ service: "story.optional", apiVersion: "1" }],
    setup: `const source=ctx.services.getOptional('story.source','1');ctx.services.provide('story.optional','1',{read:()=>source?.read()??0})`,
  });
  const absent = f.lock(1, [optional.node, f.independent.node]);
  await f.coordinator.synchronize({ lock: absent, authority: allow });
  const oldAbsent = f.coordinator.acquireCurrent(
    borrow(absent.lockDigest, optional.node.pluginId),
  );
  const present = f.lock(2, [optional.node, f.source.node, f.independent.node]);
  assert.deepEqual(
    (await f.coordinator.synchronize({ lock: present, authority: allow }))
      .failures,
    [],
  );
  const oldPresent = f.coordinator.acquireCurrent(
    borrow(present.lockDigest, optional.node.pluginId),
  );
  const removed = f.lock(3, [optional.node, f.independent.node]);
  assert.deepEqual(
    (await f.coordinator.synchronize({ lock: removed, authority: allow }))
      .failures,
    [],
  );
  const current = f.coordinator.acquireCurrent(
    borrow(removed.lockDigest, optional.node.pluginId),
  );
  assert.equal(
    oldAbsent.getService<{ read(): number }>("story.optional", "1").read(),
    0,
  );
  assert.equal(
    oldPresent.getService<{ read(): number }>("story.optional", "1").read(),
    1,
  );
  assert.equal(
    current.getService<{ read(): number }>("story.optional", "1").read(),
    0,
  );
  assert.equal(
    (await f.independent.records()).filter((value) => value === "setup").length,
    1,
  );
  oldAbsent.release();
  oldPresent.release();
  current.release();
  await f.coordinator.drain();
  assert.equal(
    (await f.source.records()).filter((value) => value === "dispose").length,
    1,
  );
});

test("physical cleanup failure cannot become a successful empty composition or reactivate the failed owner", async (t) => {
  const f = await fixture(t);
  const broken = await f.make({
    pluginId: "example.broken",
    setup: `ctx.onDispose(()=>{throw new Error('fixture-cleanup-failure')})`,
  });
  const coordinator = new PluginCompositionCoordinator({
    scope,
    installRoot: f.installRoot,
    services: [],
  });
  t.after(() => assert.rejects(coordinator.close(), /plugin_cleanup_failed/));
  const first = f.lock(1, [broken.node]);
  await coordinator.synchronize({ lock: first, authority: allow });
  await assert.rejects(
    coordinator.synchronize({ lock: f.lock(2, []), authority: allow }),
    /plugin_cleanup_failed/,
  );
  assert.throws(
    () =>
      coordinator.acquireCurrent(
        borrow(first.lockDigest, broken.node.pluginId),
      ),
    /current_unavailable/,
  );
  await assert.rejects(
    coordinator.synchronize({
      lock: f.lock(3, [broken.node]),
      authority: allow,
    }),
    /plugin_cleanup_failed/,
  );
  assert.equal(
    (await broken.records()).filter((value) => value === "setup").length,
    1,
  );
});
