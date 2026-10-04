import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  parseInstalledPluginPeerRequest,
  type PluginPackageDescriptor,
  PLUGIN_PACKAGE_SCHEMA_VERSION,
  PLUGIN_PACKAGE_HOST_API,
} from "@crewon/contracts/plugins";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import {
  nativeConfigurationManifest as manifest,
  nativeConfigurationSave as save,
} from "./desktop-plugin-configuration.test-support.ts";
import { activationTarget as target } from "./desktop-installed-plugin-activation.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import {
  parseDesktopPluginConfiguration,
  loadDesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import { createDesktopPluginRuntime } from "./desktop-plugin-runtime.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { loadDesktopNativePluginControlEnvironment } from "./desktop-native-plugin-control-environment.ts";

const actor = {
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "standalone-tenant",
  spaceId: "standalone-space",
};
const sha = {
  sha256: (value: string | Buffer) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const clock = { now: () => "2026-10-04T00:00:00.000Z" };
const session = "s".repeat(32),
  csrf = "c".repeat(32);
const request = () => ({
  method: "POST",
  url: "/api/v1/plugins/ui/mounts/named-local/actions",
  remoteAddress: "127.0.0.1",
  headers: {
    "authorization": `Bearer ${session}`,
    "origin": "crewon://desktop",
    "x-csrf-token": csrf,
  },
});
/** Actual installed Node action and original SQLite commit. Peer readiness/release is a
 * named offline fixture; this is not a live Worker/model/supplier generation acceptance. */
async function fixture(t: TestContext) {
  let runtime:
      | Awaited<ReturnType<typeof createDesktopPluginRuntime>>
      | undefined,
    store: SqliteRunStore | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.close();
      await store?.close();
    },
  });
  const directory = join(f.root, "native-business");
  await mkdir(directory, { mode: 0o700 });
  const node =
    "export default {apiVersion:'crewon.plugin-host.v1',pluginId:'test.native-business',setup(context){const tasks=context.services.getOptional('crewon.tasks','1');context.services.provide('test.native-business','1',{actions:[{contributionId:'workbench',action:'image.generate',kind:'generateTask'}],invoke({input,invocationRef}){return tasks.createTask({...input,invocationRef});}});}};";
  const files = [
    { path: "node.mjs", bytes: Buffer.from(node) },
    {
      path: "ui.mjs",
      bytes: Buffer.from(
        "export default {apiVersion:'crewon.plugin-ui.v1',mount(){return {update(){},dispose(){}};}};",
      ),
    },
    { path: "business.json", bytes: Buffer.from(JSON.stringify(manifest)) },
  ];
  const descriptor: PluginPackageDescriptor = {
    schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
    hostApi: PLUGIN_PACKAGE_HOST_API,
    pluginId: manifest.pluginId,
    publisherId: "test.native-publisher",
    version: manifest.version,
    title: "Named local unmetered task",
    description:
      "Original Control commit with an offline peer; no wallet or live provider",
    entrypoints: {
      node: "node.mjs",
      ui: { path: "ui.mjs", mode: "trustedModule" },
    },
    businessManifestPath: "business.json",
    requires: [
      { service: "crewon.execution", apiVersion: "1", optional: true },
      { service: "crewon.tasks", apiVersion: "1", optional: true },
    ],
    provides: [{ service: manifest.pluginId, apiVersion: "1" }],
    contributions: [
      {
        id: "workbench",
        kind: "module",
        slot: "main.content",
        title: "Named task fixture",
      },
    ],
    files: files.map((file) => ({
      path: file.path,
      byteLength: file.bytes.length,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    })),
  };
  for (const file of files)
    await writeFile(join(directory, file.path), file.bytes);
  await writeFile(
    join(directory, "crewon.plugin.json"),
    JSON.stringify(descriptor),
  );
  const verified = await verifyLocalPluginPackage({ directory });
  const source = {
    sourceId: "native-business",
    directory,
    pluginId: descriptor.pluginId,
    publisherId: descriptor.publisherId,
    version: descriptor.version,
    packageDigest: verified.packageDigest,
  };
  const installRoot = join(f.root, "plugins");
  await mkdir(installRoot, { mode: 0o700 });
  const scope = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "native-task-original-profile",
  };
  const raw = {
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope,
    authorityEpoch: "native-task-original-epoch-0000000001",
    installRoot,
    sources: [source],
    publications: [
      {
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: ["ui.mjs"],
      },
    ],
  };
  const bootstrapBytes = Buffer.from(JSON.stringify(raw)),
    bootstrapPath = join(
      f.root,
      `plugin-bootstrap-${createHash("sha256").update(bootstrapBytes).digest("hex")}.json`,
    );
  await writeFile(bootstrapPath, bootstrapBytes, { mode: 0o600 });
  const bootstrap = await loadDesktopPluginConfiguration(bootstrapPath, {
    actor,
  });
  assert.deepEqual(parseDesktopPluginConfiguration(raw), bootstrap);
  const databasePath = join(f.root, "control.sqlite");
  store = new SqliteRunStore(databasePath);
  const originalStore = store;
  const identity = new StandaloneIdentity({
    actor,
    sessionToken: session,
    csrfToken: csrf,
    allowedOrigins: ["crewon://desktop"],
  });
  runtime = await createDesktopPluginRuntime(
    { configuration: bootstrap },
    { store, identity, clock, digester: sha },
  );
  await runtime.installation.install(actor, {
    sourceId: source.sourceId,
    expectedPluginId: source.pluginId,
    expectedPackageDigest: source.packageDigest,
    expectedSelectionRevision: null,
    idempotencyKey: "native-real-install",
  });
  const metadata = runtime.configuration;
  const saved = await metadata.requests.run(
    { request: request(), actor, preparation: "configuration" },
    () =>
      metadata.extensions.saveConfiguration(actor, {
        ...save,
        pluginId: source.pluginId,
        idempotencyKey: "native-real-config",
      }),
  );
  const configuration = saved.configuration;
  await originalStore.registerAgentVersion({
    schemaVersion: "crewon.agent-version-asset.v0",
    tenantId: actor.tenantId,
    agentVersionId: target.agentVersionId,
    contentDigest: target.agentVersionContentDigest,
    createdAt: clock.now(),
    definitionJson: JSON.stringify({
      schemaVersion: "crewon.agent-version.v0",
      agentVersionId: target.agentVersionId,
      runtimeGeneration: target.runtimeGeneration,
      policySnapshotId: target.policySnapshotId,
    }),
  });
  const releaseId = sha.sha256("named-native-unmetered-release");
  await originalStore.activateAgentVersionRelease({
    bundle: {
      schemaVersion: "crewon.agent-version-release-bundle.v0",
      tenantId: actor.tenantId,
      releaseId,
      manifestDigest: releaseId,
      defaultAgentVersionId: target.agentVersionId,
      deployments: [
        {
          schemaVersion: "crewon.agent-version-deployment.v0",
          tenantId: actor.tenantId,
          agentVersionId: target.agentVersionId,
          contentDigest: target.agentVersionContentDigest,
          materializationDigest: target.materializationDigest,
          authorityId: target.authorityId,
          workspaceBindingId: target.workspaceBindingId,
        },
      ],
    },
    activation: {
      schemaVersion: "crewon.agent-version-release-activation.v0",
      tenantId: actor.tenantId,
      releaseId,
      activationId: "named-native-unmetered-release-activation",
      previousReleaseId: null,
      operator: {
        principalId: actor.principalId,
        actorId: actor.actorId,
        spaceId: actor.spaceId,
      },
      activatedAt: clock.now(),
    },
    expectedActiveReleaseId: null,
  });
  await runtime.close();
  runtime = undefined;
  const packageIdentity = {
    pluginId: source.pluginId,
    publisherId: source.publisherId,
    version: source.version,
    packageDigest: source.packageDigest,
  };
  const approvalPath = join(f.root, "plugin-approvals.json"),
    profilePath = join(f.root, "plugin-profile.json"),
    policyPath = join(f.root, "plugin-native-policy.json");
  await writeFile(
    approvalPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-plugin-approval.v1",
      sources: [source],
      publications: raw.publications,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    profilePath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-plugin-profile.v1",
      actor,
      scope,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    policyPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-native-plugin-policy.v1",
      packages: [{ ...packageIdentity, approvalRequirement: "none" }],
      networkGrants: [],
    }),
    { mode: 0o600 },
  );
  const ownedDirectory = join(f.root, ".native-plugin-authority-test");
  await mkdir(ownedDirectory, { mode: 0o700 });
  const controlDirectory = join(f.root, ".installed-plugin-preparation-test");
  await mkdir(controlDirectory, { mode: 0o700 });
  const authorityPath = join(ownedDirectory, "authority.json"),
    controlPath = join(controlDirectory, "native-control.json");
  await writeFile(
    authorityPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-native-plugin-authority.v1",
      authorityId: "native-actual-file-unmetered-authority",
      actor,
      scope,
      installRoot,
      controlDatabasePath: databasePath,
      bootstrapPath,
      bootstrapDigest: sha.sha256(await readFile(bootstrapPath)),
      approvalPath,
      approvalDigest: sha.sha256(await readFile(approvalPath)),
      profilePath,
      profileDigest: sha.sha256(await readFile(profilePath)),
      policyPath,
      policyDigest: sha.sha256(await readFile(policyPath)),
      packages: [packageIdentity],
      networkGrants: [],
    }),
    { mode: 0o600 },
  );
  const entry = {
    identity: {
      ...packageIdentity,
      manifestDigest: configuration.manifestDigest,
      implementationDigest: configuration.implementationDigest,
    },
    configuration,
    configuredTarget: target,
  };
  await writeFile(
    controlPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-native-plugin-control.v1",
      authorityPath,
      peer: {
        origin: "http://127.0.0.1:3299",
        tokenEnvironmentVariable: "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
      },
      entries: [entry],
    }),
    { mode: 0o600 },
  );
  const nativeControl = loadDesktopNativePluginControlEnvironment(
    {
      CREWON_DESKTOP_NATIVE_PLUGIN_CONTROL_PATH: controlPath,
      CREWON_DESKTOP_NATIVE_PLUGIN_AUTHORITY_PATH: authorityPath,
      CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN: "p".repeat(32),
    },
    {
      securityMode: "standalone",
      desktopBootstrapPath: bootstrapPath,
      databasePath,
    },
  );
  assert.ok(nativeControl);
  const peerOperations: string[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    assert.equal(
      String(url),
      "http://127.0.0.1:3299/private/v1/installed-plugins",
    );
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${"p".repeat(32)}`,
    );
    const input = parseInstalledPluginPeerRequest(
      JSON.parse(String(init?.body)),
    );
    assert.deepEqual(input.actor, actor);
    assert.deepEqual(input.scope, scope);
    peerOperations.push(input.operation);
    const common = {
      protocol: "crewon.installed-plugin-peer-response.v1",
      requestId: input.requestId,
      operation: input.operation,
      actor,
      scope,
    };
    if (input.operation === "catalog")
      return Response.json({ ...common, entries: [{ ...entry, manifest }] });
    if (
      input.operation === "prepareCandidate" ||
      input.operation === "readiness"
    )
      return Response.json({
        ...common,
        identity: input.identity,
        configurationDigest: input.configuration.contentDigest,
        expectedTarget: input.expectedTarget,
        ...(input.operation === "prepareCandidate"
          ? { expectedSelectionRevision: input.expectedSelectionRevision }
          : {}),
        result: { outcome: "ready", target },
      });
    throw new Error("named_native_peer_operation_unexpected");
  };
  runtime = await createDesktopPluginRuntime(
    { configuration: bootstrap, nativeControl },
    { store: originalStore, identity, clock, digester: sha, fetch },
  );
  const actual = runtime;
  assert.ok(actual.tasks);
  const run = <T>(work: () => Promise<T>) =>
    actual.configuration.requests.run(
      { request: request(), actor, preparation: "configuration" },
      work,
    );
  await run(() =>
    actual.configuration.extensions.setActivation(actor, {
      pluginId: source.pluginId,
      configurationRevision: configuration.revision,
      expectedRevision: 0,
      idempotencyKey: "native-real-business-enable",
      state: "enabled",
      agentVersionId: target.agentVersionId,
    }),
  );
  await actual.installation.select(actor, {
    pluginId: source.pluginId,
    selectedPackageDigest: source.packageDigest,
    state: "enabled",
    expectedSelectionRevision: 1,
    idempotencyKey: "native-real-package-enable",
  });
  await seedThread(originalStore, {
    ...actor,
    threadId: "native-real-original-thread",
  });
  const mount = await actual.ui.openMount(actor, {
    pluginId: source.pluginId,
    contributionId: "workbench",
    expectedPackageDigest: source.packageDigest,
    expectedSelectionRevision: 2,
  });
  const command = {
    mountRef: mount.mountRef,
    action: "image.generate",
    input: {
      threadId: "native-real-original-thread",
      expectedThreadRevision: 1,
      idempotencyKey: "native-real-original-task",
      input: { organization: "Named explicit local task" },
    },
  };
  const invoke = () =>
    actual.ui.invokeAuthenticatedRequest!(
      request(),
      actor,
      command,
      new AbortController().signal,
    );
  const facts = () => {
    const db = new DatabaseSync(databasePath);
    try {
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      return {
        runs: Number(
          db.prepare("SELECT COUNT(*) AS n FROM run_snapshots").get()!.n,
        ),
        admissions: Number(
          db.prepare("SELECT COUNT(*) AS n FROM plugin_task_admissions").get()!
            .n,
        ),
        unmetered: Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM plugin_task_unmetered_admissions",
            )
            .get()!.n,
        ),
        financialTables: tables.filter(
          (name) =>
            name.startsWith("plugin_credit_") ||
            name.startsWith("extension_credit_"),
        ),
      };
    } finally {
      db.close();
    }
  };
  return {
    actual,
    originalStore,
    policyPath,
    invoke,
    facts,
    peerOperations,
    source,
  };
}
test(
  "actual local Native task owner commits and replays one original installed task with explicit unmetered provenance and no financial schema",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    assert.deepEqual(f.facts(), {
      runs: 0,
      admissions: 0,
      unmetered: 0,
      financialTables: [],
    });
    const first = await f.invoke();
    const output = first as Record<string, unknown>;
    assert.equal(output.disposition, "committed");
    assert.deepEqual(f.facts(), {
      runs: 1,
      admissions: 1,
      unmetered: 1,
      financialTables: [],
    });
    const admission = await f.originalStore
      .extensionStore()
      .loadPluginTaskUnmeteredAdmission({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: String(output.runId),
      });
    assert.ok(admission);
    assert.equal(
      admission.authorization.authorityId,
      "native-actual-file-unmetered-authority",
    );
    const replay = await f.invoke();
    assert.deepEqual(replay, { ...output, disposition: "replayed" });
    assert.deepEqual(f.facts(), {
      runs: 1,
      admissions: 1,
      unmetered: 1,
      financialTables: [],
    });
    assert.ok(f.peerOperations.includes("prepareCandidate"));
    await writeFile(f.policyPath, "{}");
    await assert.rejects(async () => f.invoke());
    assert.deepEqual(f.facts(), {
      runs: 1,
      admissions: 1,
      unmetered: 1,
      financialTables: [],
    });
  },
);
