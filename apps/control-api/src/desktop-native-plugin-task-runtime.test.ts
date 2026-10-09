import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  parseInstalledPluginPeerRequest,
  type PluginPackageDescriptor,
  type DesktopProjectExecutionConfiguration,
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
import { composeDesktopProjectStartup } from "./desktop-project-startup.ts";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import { assertDesktopNativePluginTaskComposition } from "./desktop-native-plugin-task-runtime.ts";
import { installedProjectConversationTaskAuthority } from "./installed-plugin-task-runtime-core.ts";

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
async function fixture(
  t: TestContext,
  retainedApproval?: "approved" | "unapproved",
  options: Readonly<{ modelSiblings?: boolean }> = {},
) {
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
  const sources = [source];
  let retained: typeof source | undefined;
  const oldImportMarker = join(f.root, "retained-node-imported");
  if (retainedApproval !== undefined) {
    const directory = join(f.root, "retained-business");
    await mkdir(directory, { mode: 0o700 });
    const retainedFiles = files.map((file) => ({
      ...file,
      bytes:
        file.path === "business.json"
          ? Buffer.from(JSON.stringify({ ...manifest, version: "0.9.0" }))
          : file.path === "node.mjs"
            ? Buffer.from(
                `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(oldImportMarker)},'unexpected-import');${node}`,
              )
            : file.bytes,
    }));
    for (const file of retainedFiles)
      await writeFile(join(directory, file.path), file.bytes);
    await writeFile(
      join(directory, "crewon.plugin.json"),
      JSON.stringify({
        ...descriptor,
        version: "0.9.0",
        files: retainedFiles.map((file) => ({
          path: file.path,
          byteLength: file.bytes.length,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
        })),
      }),
    );
    const verified = await verifyLocalPluginPackage({ directory });
    retained = {
      ...source,
      directory,
      sourceId: "retained-business",
      version: "0.9.0",
      packageDigest: verified.packageDigest,
    };
    sources.push(retained);
  }
  const modules = sources.map(({ pluginId, packageDigest }) => ({
    pluginId,
    packageDigest,
    contributionId: "workbench",
  }));
  const projects: DesktopProjectExecutionConfiguration = {
    version: "crewon.desktop-project-execution.v1",
    pluginUi: { publications: modules },
    generationReads: { version: "crewon.project-generation-read.v1" },
    pluginGenerations: {
      publications: modules.map((source) => ({
        source,
        target: { ...source, action: "image.generate" },
      })),
    },
    pluginQueries: {
      publications: modules.map((source) => ({
        source,
        target: { ...source, action: "image.query" },
      })),
    },
    uiRecovery: {
      version: "crewon.plugin-ui-recovery.v1",
      publications: modules.map((source) => ({
        ...source,
        actions: [
          "crewon.project-generations.v1.generateConcept",
          "crewon.project-generation-queries.v1.queryConceptGeneration",
        ],
      })),
    },
  };
  const installRoot = join(f.root, "plugins");
  await mkdir(installRoot, { mode: 0o700 });
  const scope = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "native-task-original-profile",
  };
  const raw = {
    schemaVersion: retained
      ? "crewon.desktop-plugin-bootstrap.v3"
      : "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope,
    authorityEpoch: "native-task-original-epoch-0000000001",
    installRoot,
    sources,
    publications: sources.map(({ pluginId, publisherId, packageDigest }) => ({
      pluginId,
      publisherId,
      packageDigest,
      publicAssets: ["ui.mjs"],
    })),
    ...(retained ? { projects } : {}),
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
  const packageApprovals = sources
    .filter((entry) => retainedApproval !== "unapproved" || entry === source)
    .map(({ pluginId, publisherId, version, packageDigest }) => ({
      pluginId,
      publisherId,
      version,
      packageDigest,
    }));
  const approvalPath = join(f.root, "plugin-approvals.json"),
    profilePath = join(f.root, "plugin-profile.json"),
    policyPath = join(f.root, "plugin-native-policy.json");
  await writeFile(
    approvalPath,
    JSON.stringify({
      schemaVersion: "crewon.desktop-plugin-approval.v1",
      sources,
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
      packages: packageApprovals.map((pkg) => ({
        ...pkg,
        approvalRequirement: "none",
      })),
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
      packages: packageApprovals,
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
      schemaVersion: options.modelSiblings
        ? "crewon.desktop-native-plugin-control.v2"
        : "crewon.desktop-native-plugin-control.v1",
      authorityPath,
      peer: {
        origin: "http://127.0.0.1:3299",
        tokenEnvironmentVariable: "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
      },
      entries: options.modelSiblings
        ? [
            entry,
            {
              ...entry,
              configuredTarget: {
                ...target,
                agentVersionId: "named-second-published-model",
              },
            },
          ]
        : [entry],
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
  const startup = retained
    ? composeDesktopProjectStartup({
        configuration: bootstrap,
        actor,
        nativeControl,
      })
    : undefined;
  const prepared = startup
    ? await prepareCreativeProjects(originalStore, startup.creativeProjects, {
        financialMode: "unmetered",
      })
    : undefined;
  runtime = await createDesktopPluginRuntime(
    {
      configuration: bootstrap,
      nativeControl,
      ...(startup?.uiRecovery ? { uiRecovery: startup.uiRecovery } : {}),
    },
    {
      store: originalStore,
      identity,
      clock,
      digester: sha,
      fetch,
      ...(prepared ? { creativeProjects: prepared } : {}),
    },
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
    retained,
    oldImportMarker,
    bootstrap,
    nativeControl,
    startup,
    scope,
    command,
  };
}
test(
  "Native multi-model publication activates its prepared default and retains sibling targets without duplicate plugin authority",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t, undefined, { modelSiblings: true });
    assert.equal(f.nativeControl.publication.entries.length, 2);
    assert.equal(
      f.nativeControl.publication.entries[0]!.target.agentVersionId,
      target.agentVersionId,
    );
    assert.equal(
      f.nativeControl.publication.entries[1]!.target.agentVersionId,
      "named-second-published-model",
    );
    await assert.rejects(
      () =>
        f.actual.configuration.requests.run(
          { request: request(), actor, preparation: "configuration" },
          () =>
            f.actual.configuration.extensions.setActivation(actor, {
              pluginId: f.source.pluginId,
              configurationRevision:
                f.nativeControl.publication.entries[0]!.configuration.revision,
              expectedRevision: 1,
              idempotencyKey: "cannot-replace-prepared-default-with-sibling",
              state: "enabled",
              agentVersionId: "named-second-published-model",
            }),
        ),
      { code: "extension_execution_target_mismatch" },
    );
    const first = (await f.invoke()) as Record<string, unknown>;
    assert.equal(first.disposition, "committed");
    assert.deepEqual(await f.invoke(), { ...first, disposition: "replayed" });
    assert.equal(f.facts().runs, 1);
    await writeFile(f.policyPath, "{}");
    await assert.rejects(async () => f.invoke());
    assert.equal(f.facts().runs, 1);
  },
);

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

test(
  "retained approved generation/query mappings survive startup, but an unprepared old version cannot import Node or commit a Run",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "approved");
    assert.ok(f.retained);
    assert.equal(f.nativeControl.authority.packages.length, 2);
    assert.equal(f.nativeControl.publication.entries.length, 1);
    assert.equal(
      f.startup?.creativeProjects?.pluginGenerations?.publications.length,
      2,
    );
    assert.equal(
      f.startup?.creativeProjects?.pluginQueries?.publications.length,
      2,
    );
    assert.ok(f.actual.tasks?.projectGenerations);
    assert.ok(f.actual.tasks?.projectQueries);
    const first = (await f.invoke()) as Record<string, unknown>;
    assert.equal(first.disposition, "committed");
    const before = f.facts();
    assert.equal(before.runs, 1);

    // Exercise the real execution callbacks used by project generation/query
    // owners: retained bytes remain readable, but cannot obtain submit authority.
    const authority = installedProjectConversationTaskAuthority(
      f.actual.tasks!,
    );
    const candidate = await verifyLocalPluginPackage({
      directory: f.retained.directory,
    });
    for (const purpose of ["read", "submit"] as const) {
      const decision = await authority.requests.run(
        { request: request(), actor, preparation: "configuration" },
        () =>
          authority.authorizePackage(
            {
              actor,
              scope: f.scope,
              candidate: {
                descriptor: candidate.descriptor,
                packageDigest: candidate.packageDigest,
              },
              purpose,
            },
            new AbortController().signal,
          ),
      );
      assert.equal(decision, purpose === "read" ? "allow" : "deny");
    }
    // Older clients also cannot enable it against a different prepared package.
    const installed = await f.actual.installation.install(actor, {
      sourceId: f.retained.sourceId,
      expectedPluginId: f.retained.pluginId,
      expectedPackageDigest: f.retained.packageDigest,
      expectedSelectionRevision: 2,
      idempotencyKey: "native-retained-install",
    });
    const peerBefore = [...f.peerOperations];
    await assert.rejects(
      () =>
        f.actual.installation.select(actor, {
          pluginId: f.retained!.pluginId,
          selectedPackageDigest: f.retained!.packageDigest,
          state: "enabled",
          expectedSelectionRevision: installed.selection!.revision,
          idempotencyKey: "native-retained-select",
        }),
      /desktop_plugin_candidate_selection_changed/,
    );
    await assert.rejects(() => stat(f.oldImportMarker), { code: "ENOENT" });
    assert.deepEqual(f.peerOperations, peerBefore);
    assert.deepEqual(f.facts(), before);
    assert.ok(
      await f.originalStore.loadRunInSpace({
        ...actor,
        runId: String(first.runId),
      }),
    );
  },
);

test(
  "retained mappings still require exact native target approval at startup",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    await assert.rejects(
      () => fixture(t, "unapproved"),
      /desktop_native_plugin_project_mapping_unapproved/,
    );
  },
);

test(
  "retained mappings cannot introduce an unapproved source or substitute another target digest",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await fixture(t, "approved");
    for (const lane of ["pluginGenerations", "pluginQueries"] as const) {
      for (const side of ["source", "target"] as const) {
        const mapping = f.startup!.creativeProjects![lane]!.publications[0]!;
        assert.throws(
          () =>
            assertDesktopNativePluginTaskComposition({
              configuration: f.bootstrap,
              nativeControl: f.nativeControl,
              creativeProjects: {
                [lane]: {
                  publications: [
                    {
                      ...mapping,
                      [side]: {
                        ...mapping[side],
                        packageDigest: sha.sha256("unapproved-package"),
                      },
                    },
                  ],
                },
              },
            }),
          /desktop_native_plugin_project_mapping_unapproved/,
        );
      }
    }
  },
);
