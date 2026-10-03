import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import {
  parseExtensionManifest,
  type ExtensionManifest,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  PLUGIN_PACKAGE_HOST_API,
  PLUGIN_PACKAGE_SCHEMA_VERSION,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import {
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
  type DesktopPluginSource,
} from "./desktop-plugin-configuration.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";

export const nativeConfigurationActor = Object.freeze({
  principalId: "native-configuration-principal",
  actorId: "native-configuration-actor",
  tenantId: "native-configuration-tenant",
  spaceId: "native-configuration-space",
});
export const nativeConfigurationScope = Object.freeze({
  tenantId: nativeConfigurationActor.tenantId,
  spaceId: nativeConfigurationActor.spaceId,
  profileId: "native-configuration-physical-profile",
});
export const nativeConfigurationHeaders = Object.freeze({
  "authorization": `Bearer ${"s".repeat(32)}`,
  "origin": "crewon://desktop",
  "x-csrf-token": "c".repeat(32),
});
const schema = {
  type: "object" as const,
  properties: {
    organization: { type: "string" as const, maxLength: 160, enum: null },
  },
  required: ["organization"],
  additionalProperties: false as const,
};
export const nativeConfigurationManifest = parseExtensionManifest({
  schemaVersion: "crewon.extension-manifest.v0",
  hostApi: "crewon.extensions.v0",
  pluginId: "test.native-business",
  version: "1.0.0",
  title: "Native metadata fixture",
  description: "Actual installed metadata; no provider, model or price.",
  task: { instructions: "Use the declared fixture tool.", inputSchema: schema },
  configurationSchema: schema,
  credentialSlots: [],
  tools: [
    {
      operationId: "report",
      adapterId: "test.native.report-api",
      description: "Test-only report operation, never called by configuration.",
      inputSchema: schema,
      outputSchema: schema,
      execution: "serial",
      effect: "mutation",
      recovery: "reconcilable",
      capability: "test.native.report",
    },
  ],
  resultViews: ["text"],
});
export const nativeConfigurationSave = Object.freeze({
  pluginVersion: nativeConfigurationManifest.version,
  expectedRevision: 0,
  parameters: { organization: "Named native configuration test company" },
  credentialBindings: [],
});
type Runtime = Awaited<
  ReturnType<typeof createStandaloneControlApiWithPlugins>
>;
export type NativeConfigurationSource = DesktopPluginSource &
  Readonly<{ manifest: ExtensionManifest }>;

/** Real verified delivery bytes, installer, session gate and file-backed SQLite. */
export async function nativeConfigurationFixture(
  t: TestContext,
  options: Readonly<{ beforeCleanup?: () => Promise<void> }> = {},
) {
  let runtime: Runtime | undefined;
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.app.close();
      await options.beforeCleanup?.();
    },
  });
  const databasePath = join(files.root, "native-business.sqlite");
  async function source(
    sourceId: string,
    options: Readonly<{ version?: string; manifest?: ExtensionManifest }> = {},
  ): Promise<NativeConfigurationSource> {
    const directory = join(files.root, sourceId);
    await mkdir(directory, { mode: 0o700 });
    const manifest = parseExtensionManifest(
      options.manifest ?? {
        ...nativeConfigurationManifest,
        version: options.version ?? "1.0.0",
      },
    );
    const node = Buffer.from(
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(files.marker)},'unexpected-node-import');export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(manifest.pluginId)},setup(){throw new Error('configuration_must_not_execute');}};`,
    );
    const entries = [
      { path: "business.json", bytes: Buffer.from(JSON.stringify(manifest)) },
      { path: "node.mjs", bytes: node },
    ];
    const descriptor: PluginPackageDescriptor = {
      schemaVersion: PLUGIN_PACKAGE_SCHEMA_VERSION,
      hostApi: PLUGIN_PACKAGE_HOST_API,
      pluginId: manifest.pluginId,
      publisherId: "test.native-publisher",
      version: manifest.version,
      title: "Native configuration fixture",
      description:
        "Separately verified business bytes; deliberately no execution host.",
      entrypoints: { node: "node.mjs", ui: null },
      businessManifestPath: "business.json",
      requires: [
        { service: "crewon.execution", apiVersion: "1", optional: false },
      ],
      provides: [],
      contributions: [],
      files: entries.map((entry) => ({
        path: entry.path,
        byteLength: entry.bytes.byteLength,
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
    return Object.freeze({
      sourceId,
      directory,
      pluginId: descriptor.pluginId,
      publisherId: descriptor.publisherId,
      version: descriptor.version,
      packageDigest: verified.packageDigest,
      manifest,
    });
  }
  function configuration(
    sources: readonly NativeConfigurationSource[],
    scope: PluginProfileScope = nativeConfigurationScope,
  ): DesktopPluginConfiguration {
    return parseDesktopPluginConfiguration({
      schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
      actor: nativeConfigurationActor,
      scope,
      authorityEpoch: "native-business-configuration-approved-epoch-01",
      installRoot: files.installRoot,
      sources: sources.map(({ manifest: _manifest, ...source }) => source),
      publications: [],
    });
  }
  const baseConfig = () => ({
    databasePath,
    actor: nativeConfigurationActor,
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
  });
  async function open(
    configuration: DesktopPluginConfiguration,
    extensionWorker?: Readonly<{ origin: string; token: string }>,
  ) {
    assert.equal(
      runtime,
      undefined,
      "previous actual Control must close first",
    );
    runtime = await createStandaloneControlApiWithPlugins({
      ...baseConfig(),
      desktopPlugins: configuration,
      ...(extensionWorker === undefined ? {} : { extensionWorker }),
    });
    return runtime;
  }
  async function close() {
    const current = runtime;
    if (current === undefined) return;
    await current.app.close();
    runtime = undefined;
  }
  const request = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    key?: string,
    changedHeaders: Readonly<Record<string, string>> = {},
  ) => {
    assert.ok(runtime, "actual Control must be open");
    return runtime.app.inject({
      method,
      url,
      headers: {
        ...nativeConfigurationHeaders,
        ...(key === undefined ? {} : { "idempotency-key": key }),
        ...changedHeaders,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  };
  async function install(
    pkg: NativeConfigurationSource,
    revision: number | null = null,
  ) {
    const result = await request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.pluginId,
        expectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: revision,
      },
      `install-${pkg.sourceId}`,
    );
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  }
  async function select(
    pkg: NativeConfigurationSource,
    revision: number,
    state: "disabled" | "uninstalled",
    key: string,
  ) {
    const result = await request(
      "PUT",
      `/api/v1/plugins/selections/${pkg.pluginId}`,
      {
        expectedSelectionRevision: revision,
        state,
        selectedPackageDigest:
          state === "uninstalled" ? null : pkg.packageDigest,
      },
      key,
    );
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().projection.outcome, "applied");
    return result.json().mutation.selection;
  }
  function facts() {
    const database = new DatabaseSync(databasePath);
    try {
      const tables = (
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map(({ name }) => name);
      const counts: Record<string, number> = {};
      for (const table of [
        "threads",
        "run_snapshots",
        "extension_configurations",
        "extension_mutation_receipts",
        "extension_activations",
        "extension_run_bindings",
        "extension_external_operations",
      ])
        if (tables.includes(table))
          counts[table] = Number(
            database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
          );
      return { tables, counts };
    } finally {
      database.close();
    }
  }
  async function assertMetadataOnly() {
    const actual = facts();
    for (const table of [
      "threads",
      "run_snapshots",
      "extension_activations",
      "extension_run_bindings",
      "extension_external_operations",
    ])
      assert.equal(
        actual.counts[table],
        0,
        `configuration must not create ${table}`,
      );
    for (const table of [
      "plugin_task_admissions",
      "extension_credit_admissions",
      "plugin_credit_accounts",
      "plugin_credit_entries",
      "plugin_credit_reservations",
    ])
      assert.ok(
        !actual.tables.includes(table),
        `configuration must not migrate ${table}`,
      );
    await assert.rejects(readFile(files.marker), { code: "ENOENT" });
  }
  return {
    ...files,
    databasePath,
    baseConfig,
    source,
    configuration,
    open,
    close,
    request,
    install,
    select,
    facts,
    assertMetadataOnly,
  };
}
