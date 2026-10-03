import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import {
  PLUGIN_PACKAGE_HOST_API,
  PLUGIN_PACKAGE_SCHEMA_VERSION,
  parseInstalledPluginPeerRequest,
  type InstalledPluginPeerRequest,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import { type ExtensionConfiguration } from "@crewon/domain";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { parseDesktopInstalledPluginActivationConfig } from "./desktop-installed-plugin-activation-environment.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import {
  nativeConfigurationActor as actor,
  nativeConfigurationScope as scope,
  nativeConfigurationHeaders as headers,
  nativeConfigurationManifest as manifest,
  nativeConfigurationSave as save,
} from "./desktop-plugin-configuration.test-support.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";

export { actor, scope, manifest, save };
export const activationTarget = Object.freeze({
  executionAuthority: "crewonKernel" as const,
  agentVersionId: "actual-release-entry-test-fixture",
  agentVersionContentDigest: `sha256:${"1".repeat(64)}`,
  materializationDigest: `sha256:${"2".repeat(64)}`,
  authorityId: "activation-test-authority",
  runtimeGeneration: "activation-test-generation",
  policySnapshotId: "activation-test-policy",
  workspaceBindingId: null,
});
export function activationDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/** Real Native HTTP/SQLite/package path, with a deliberately synthetic peer response boundary.
 * This proves Control guards and receipts only; source-process tests prove actual Worker readiness.
 */
export async function desktopActivationFixture(
  t: TestContext,
  options: Readonly<{ mandatoryService?: string }> = {},
) {
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    | undefined;
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.app.close();
    },
  });
  const directory = join(files.root, "business-source");
  await mkdir(directory, { mode: 0o700 });
  const node = Buffer.from(
    `import {appendFileSync} from 'node:fs';const log=(value)=>appendFileSync(${JSON.stringify(files.marker)},value+String.fromCharCode(10));log('load');export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(manifest.pluginId)},setup(){log('setup');return {dispose(){log('dispose');}};}};`,
  );
  const entries = [
    { path: "node.mjs", bytes: node },
    { path: "business.json", bytes: Buffer.from(JSON.stringify(manifest)) },
  ];
  const descriptor: PluginPackageDescriptor = {
    schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
    hostApi: PLUGIN_PACKAGE_HOST_API,
    pluginId: manifest.pluginId,
    publisherId: "test.native-publisher",
    version: manifest.version,
    title: "Actual Control activation fixture",
    description: "Control boundary fixture; no provider or pricing.",
    entrypoints: { node: "node.mjs", ui: null },
    businessManifestPath: "business.json",
    requires: [
      {
        service: options.mandatoryService ?? "crewon.execution",
        apiVersion: "1",
        optional: options.mandatoryService === undefined,
      },
    ],
    provides: [],
    contributions: [],
    files: entries.map((entry) => ({
      path: entry.path,
      byteLength: entry.bytes.length,
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    })),
  };
  for (const entry of entries)
    await writeFile(join(directory, entry.path), entry.bytes);
  await writeFile(
    join(directory, "crewon.plugin.json"),
    JSON.stringify(descriptor),
  );
  const verified = await verifyLocalPluginPackage({ directory });
  const source = {
    sourceId: "activation-business",
    directory,
    pluginId: descriptor.pluginId,
    publisherId: descriptor.publisherId,
    version: descriptor.version,
    packageDigest: verified.packageDigest,
  };
  const bootstrap = parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope,
    authorityEpoch: "actual-activation-test-native-owner-epoch-01",
    installRoot: files.installRoot,
    sources: [source],
    publications: [],
  });
  const databasePath = join(files.root, "activation.sqlite");
  let configuration!: ExtensionConfiguration;
  const policyCalls: Record<string, unknown>[] = [],
    peerCalls: InstalledPluginPeerRequest[] = [];
  const state = {
    policy: { outcome: "allow" } as unknown,
    readiness: { outcome: "ready", target: activationTarget } as unknown,
    candidateResponseStatus: 200,
    beforePolicy: undefined as (() => Promise<void>) | undefined,
    beforeCandidate: undefined as (() => Promise<void>) | undefined,
  };
  const identity = () => ({
    pluginId: source.pluginId,
    publisherId: source.publisherId,
    version: source.version,
    packageDigest: source.packageDigest,
    manifestDigest: configuration.manifestDigest,
    implementationDigest: configuration.implementationDigest,
  });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const destination = new URL(String(url));
    assert.equal(init?.redirect, "error");
    if (destination.protocol === "https:") {
      assert.equal(
        destination.href,
        "https://activation-fixture.example/policy",
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${"a".repeat(32)}`,
      );
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
      policyCalls.push(input);
      assert.deepEqual(input, {
        actor,
        action: "extension:activate",
        resource: {
          kind: "extension",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          pluginId: source.pluginId,
        },
      });
      await state.beforePolicy?.();
      return Response.json(state.policy);
    }
    assert.equal(
      destination.href,
      "http://127.0.0.1:3299/private/v1/installed-plugins",
    );
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${"p".repeat(32)}`,
    );
    const request = parseInstalledPluginPeerRequest(
      JSON.parse(String(init?.body)),
    );
    peerCalls.push(request);
    assert.deepEqual(request.actor, actor);
    assert.deepEqual(request.scope, scope);
    const common = {
      protocol: "crewon.installed-plugin-peer-response.v1",
      requestId: request.requestId,
      operation: request.operation,
      actor,
      scope,
    };
    if (request.operation === "prepareCandidate") {
      await state.beforeCandidate?.();
      if (state.candidateResponseStatus !== 200)
        return Response.json(
          { error: "synthetic_peer_rejected_candidate" },
          { status: state.candidateResponseStatus },
        );
      return Response.json({
        ...common,
        identity: request.identity,
        configurationDigest: request.configuration.contentDigest,
        expectedTarget: request.expectedTarget,
        expectedSelectionRevision: request.expectedSelectionRevision,
        result: state.readiness,
      });
    }
    if (request.operation === "catalog")
      return Response.json({
        ...common,
        entries: [
          {
            identity: identity(),
            manifest,
            configuration,
            configuredTarget: activationTarget,
          },
        ],
      });
    if (request.operation === "readiness")
      return Response.json({
        ...common,
        identity: request.identity,
        configurationDigest: request.configuration.contentDigest,
        expectedTarget: request.expectedTarget,
        result: state.readiness,
      });
    throw new Error("activation_fixture_unexpected_peer_operation");
  };
  t.mock.method(globalThis, "fetch", fetch);
  const open = async (activation = false) => {
    assert.equal(runtime, undefined);
    runtime = await createStandaloneControlApiWithPlugins({
      databasePath,
      actor,
      defaultAgentVersionId: "unavailable-real-model",
      sessionToken: "s".repeat(32),
      csrfToken: "c".repeat(32),
      allowedOrigins: ["crewon://desktop"],
      artifactStore: new InMemoryArtifactStore(),
      artifactEncryptionKeyId: "fixture-key",
      heartbeatIntervalMs: null,
      outboxScanIntervalMs: null,
      outboxRetention: null,
      artifactRetention: null,
      automationScanIntervalMs: null,
      desktopPlugins: bootstrap,
      ...(activation
        ? {
            desktopPluginActivation:
              parseDesktopInstalledPluginActivationConfig(
                {
                  schemaVersion:
                    "crewon.desktop-installed-plugin-activation.v1",
                  actor,
                  scope,
                  installRoot: files.installRoot,
                  peer: {
                    origin: "http://127.0.0.1:3299",
                    tokenEnvironmentVariable:
                      "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
                  },
                  authority: {
                    url: "https://activation-fixture.example/policy",
                    serviceTokenEnvironmentVariable: "TEST_ACTIVATION_TOKEN",
                  },
                  timeoutMs: 2000,
                  entries: [
                    {
                      identity: identity(),
                      configuration,
                      target: activationTarget,
                    },
                  ],
                },
                {
                  CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN: "p".repeat(32),
                  TEST_ACTIVATION_TOKEN: "a".repeat(32),
                },
              ),
          }
        : {}),
    });
    return runtime;
  };
  const close = async () => {
    await runtime?.app.close();
    runtime = undefined;
  };
  const request = (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
    key?: string,
  ) => {
    assert.ok(runtime);
    return runtime.app.inject({
      method,
      url,
      headers: {
        ...headers,
        ...(key === undefined ? {} : { "idempotency-key": key }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  };
  await open();
  const installed = await request(
    "POST",
    "/api/v1/plugins/installations",
    {
      sourceId: source.sourceId,
      expectedPluginId: source.pluginId,
      expectedPackageDigest: source.packageDigest,
      expectedSelectionRevision: null,
    },
    "activation-install",
  );
  assert.equal(installed.statusCode, 200, installed.body);
  const saved = await request(
    "PUT",
    `/api/v1/extensions/${source.pluginId}/configuration`,
    save,
    "activation-first-configuration",
  );
  assert.equal(saved.statusCode, 200, saved.body);
  configuration = saved.json().configuration;
  await close();
  // Store-level deployment fixture only. The synthetic peer above is intentionally not
  // evidence of Node or provider readiness; the real process harness owns that proof.
  const deploymentStore = new SqliteRunStore(databasePath);
  try {
    await deploymentStore.registerAgentVersion({
      schemaVersion: "crewon.agent-version-asset.v0",
      tenantId: actor.tenantId,
      agentVersionId: activationTarget.agentVersionId,
      contentDigest: activationTarget.agentVersionContentDigest,
      createdAt: "2026-10-03T00:00:00.000Z",
      definitionJson: JSON.stringify({
        schemaVersion: "crewon.agent-version.v0",
        agentVersionId: activationTarget.agentVersionId,
        runtimeGeneration: activationTarget.runtimeGeneration,
        policySnapshotId: activationTarget.policySnapshotId,
      }),
    });
    const releaseId = `sha256:${"3".repeat(64)}`;
    await deploymentStore.activateAgentVersionRelease({
      bundle: {
        schemaVersion: "crewon.agent-version-release-bundle.v0",
        tenantId: actor.tenantId,
        releaseId,
        manifestDigest: releaseId,
        defaultAgentVersionId: activationTarget.agentVersionId,
        deployments: [
          {
            schemaVersion: "crewon.agent-version-deployment.v0",
            tenantId: actor.tenantId,
            agentVersionId: activationTarget.agentVersionId,
            contentDigest: activationTarget.agentVersionContentDigest,
            materializationDigest: activationTarget.materializationDigest,
            authorityId: activationTarget.authorityId,
            workspaceBindingId: null,
          },
        ],
      },
      activation: {
        schemaVersion: "crewon.agent-version-release-activation.v0",
        tenantId: actor.tenantId,
        releaseId,
        activationId: "store-boundary-release-fixture",
        previousReleaseId: null,
        operator: {
          principalId: actor.principalId,
          actorId: actor.actorId,
          spaceId: actor.spaceId,
        },
        activatedAt: "2026-10-03T00:00:00.000Z",
      },
      expectedActiveReleaseId: null,
    });
  } finally {
    await deploymentStore.close();
  }
  const enable = (key = "activation-enable") =>
    request(
      "PUT",
      `/api/v1/plugins/selections/${source.pluginId}`,
      {
        state: "enabled",
        selectedPackageDigest: source.packageDigest,
        expectedSelectionRevision: 1,
      },
      key,
    );
  const businessActivation = (key = "activate-business") =>
    request(
      "PUT",
      `/api/v1/extensions/${source.pluginId}/activation`,
      {
        configurationRevision: 1,
        expectedRevision: 0,
        state: "enabled",
        agentVersionId: activationTarget.agentVersionId,
      },
      key,
    );
  const facts = () => {
    const db = new DatabaseSync(databasePath);
    try {
      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      const counts = Object.fromEntries(
        [
          "run_snapshots",
          "extension_activations",
          "extension_mutation_receipts",
          "plugin_installation_receipts",
          "extension_run_bindings",
          "extension_external_operations",
        ].map((table) => [
          table,
          Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),
        ]),
      );
      return { tables, counts };
    } finally {
      db.close();
    }
  };
  const nodeEvents = async () => {
    try {
      return (await readFile(files.marker, "utf8")).trim().split("\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const selection = async () =>
    (
      await request("GET", `/api/v1/plugins/selections/${source.pluginId}`)
    ).json().selection;
  const withdrawDeployment = () => {
    // Actual corruption of this test-owned deployment row; published versions stay immutable.
    const database = new DatabaseSync(databasePath);
    try {
      const result = database
        .prepare(
          "DELETE FROM agent_version_deployments WHERE tenant_id = ? AND agent_version_id = ?",
        )
        .run(actor.tenantId, activationTarget.agentVersionId);
      assert.equal(result.changes, 1);
    } finally {
      database.close();
    }
  };
  return {
    ...files,
    databasePath,
    source,
    configuration,
    identity: identity(),
    bootstrap,
    state,
    open,
    close,
    request,
    enable,
    businessActivation,
    facts,
    selection,
    withdrawDeployment,
    nodeEvents,
    policyCalls,
    peerCalls,
  };
}
