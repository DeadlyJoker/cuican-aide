import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { compileAgentVersion } from "@crewon/agent-version";
import {
  createExtensionConfiguration,
  parseExtensionManifest,
} from "@crewon/domain";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import {
  digester,
  baseSource,
  manifest,
  scope,
} from "./installed-plugin-agent-runtime-factory.test-support.ts";
import { loadInstalledPluginBusinessRegistration } from "./plugins/installed-plugin-business-registration.ts";
import {
  INSTALLED_PLUGIN_NATIVE_PREPARATION_ENV,
  INSTALLED_PLUGIN_NATIVE_PREPARATION_SCHEMA,
} from "./plugins/installed-plugin-native-preparation-config.ts";

export const actor = Object.freeze({
  tenantId: scope.tenantId,
  spaceId: scope.spaceId,
  actorId: "native-preparation-actor",
  principalId: "native-preparation-principal",
});
export { digester, scope };

export async function nativePreparationFixture(t: TestContext) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "crewon-native-preparation-"),
  );
  const sourceDirectory = join(directory, "source");
  await mkdir(sourceDirectory, { mode: 0o700 });
  const marker = join(directory, "unexpected-node-import");
  const artifacts = [
    ["business.json", Buffer.from(JSON.stringify(manifest))],
    [
      "node.mjs",
      Buffer.from(
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');throw new Error('native-preparation-must-not-import-node');`,
      ),
    ],
  ] as const;
  for (const [path, bytes] of artifacts)
    await writeFile(join(sourceDirectory, path), bytes);
  await writeFile(
    join(sourceDirectory, "crewon.plugin.json"),
    JSON.stringify({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: manifest.pluginId,
      publisherId: "example.publisher",
      version: manifest.version,
      title: "Named Native preparation fixture",
      description: "Metadata-only real installed bytes",
      entrypoints: { node: "node.mjs", ui: null },
      businessManifestPath: "business.json",
      requires: [
        { service: "crewon.execution", apiVersion: "1", optional: false },
      ],
      provides: [],
      contributions: [],
      files: artifacts.map(([path, bytes]) => ({
        path,
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })),
    }),
  );
  const dataDirectory = join(directory, "native"),
    installRoot = join(dataDirectory, "plugins");
  await mkdir(dataDirectory, { mode: 0o700 });
  await mkdir(installRoot, { mode: 0o700 });
  const installed = await installLocalPluginPackage({
    directory: sourceDirectory,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const identity = {
    pluginId: manifest.pluginId,
    publisherId: "example.publisher",
    version: manifest.version,
    packageDigest: installed.packageDigest,
  };
  const databasePath = join(dataDirectory, "control.sqlite"),
    store = new SqliteRunStore(databasePath);
  await store.pluginInstallationStore().migrate();
  await store.extensionStore().migrate();
  const at = "2026-10-03T00:00:00.000Z";
  const installation = await store
    .pluginInstallationStore()
    .recordInstalledPackage({
      scope,
      actor,
      package: {
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...scope,
        ...identity,
        installedAt: at,
        installedByPrincipalId: actor.principalId,
        installedByActorId: actor.actorId,
      },
      expectedSelectionRevision: null,
      receipt: {
        idempotencyKey: "native-install",
        requestDigest: digester.sha256("actual-install"),
      },
    });
  const registration = await loadInstalledPluginBusinessRegistration({
    installRoot,
    expectedPluginId: identity.pluginId,
    expectedPublisherId: identity.publisherId,
    expectedVersion: identity.version,
    expectedPackageDigest: identity.packageDigest,
    signal: new AbortController().signal,
    authorizeRead: async () => "allow",
  });
  let configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId: identity.pluginId,
      pluginVersion: identity.version,
      revision: 1,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: {},
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: at,
    },
    digester,
  );
  await store.extensionStore().saveExtensionConfiguration({
    configuration,
    expectedRevision: 0,
    receipt: {
      actorId: actor.actorId,
      idempotencyKey: "native-save-1",
      requestDigest: digester.sha256("actual-configuration-1"),
    },
  });
  const environment: Record<string, string | undefined> = {
    CREWON_CONTROL_DB_PATH: databasePath,
    CREWON_RELEASE_PRINCIPAL_ID: actor.principalId,
    CREWON_RELEASE_ACTOR_ID: actor.actorId,
    CREWON_TENANT_ID: actor.tenantId,
    CREWON_SPACE_ID: actor.spaceId,
    CREWON_MODEL_ADAPTER: "responses",
    CREWON_MODEL_ID: "actual-native-model",
    CREWON_RESPONSES_ENDPOINT: "https://api.openai.com/v1/responses",
    CREWON_RESPONSES_MAX_OUTPUT_TOKENS: "1000",
    CREWON_MODEL_CREDENTIAL_REQUIRED: "1",
    CREWON_MODEL_API_KEY: "named-native-model-secret",
    CREWON_AGENT_VERSION_ID: "original-native-default",
    CREWON_AUTHORITY_ID: "native-model-authority",
    NATIVE_INSTALLED_AUTHORITY_TOKEN: "a".repeat(48),
  };
  const bootstrapVersion = compileAgentVersion(
    {
      ...baseSource(),
      agentVersionId: environment.CREWON_AGENT_VERSION_ID!,
      model: {
        ...baseSource().model,
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: environment.CREWON_MODEL_ID!,
      },
    },
    digester,
  );
  let nextDirectory = 0;
  async function input(overrides: Readonly<Record<string, unknown>> = {}) {
    const directory = join(dataDirectory, `preparation-${++nextDirectory}`);
    await mkdir(directory, { mode: 0o700 });
    const inputPath = join(directory, "preparation.json"),
      workerPath = join(directory, "worker.json");
    const endpoint = (name: string) => ({
      url: `https://native-authority.example/${name}`,
      serviceTokenEnvironmentVariable: "NATIVE_INSTALLED_AUTHORITY_TOKEN",
    });
    const worker = {
      schemaVersion: "crewon.installed-plugin-worker.v1",
      installRoot,
      releaseDocumentPath: join(directory, "release.json"),
      actorAuthority: endpoint("actor"),
      policyAuthority: endpoint("policy"),
      profileAuthority: endpoint("profile"),
      packageAuthority: endpoint("package"),
      networkAuthority: null,
      historicalScope: scope,
      timeoutMs: 2000,
    };
    const preparation = {
      schemaVersion: INSTALLED_PLUGIN_NATIVE_PREPARATION_SCHEMA,
      actor,
      scope,
      approvedPackages: [identity],
      plugins: [{ pluginId: identity.pluginId, approvalRequirement: "none" }],
      workerConfigurationPath: workerPath,
      ...overrides,
    };
    await writeFile(workerPath, JSON.stringify(worker), { mode: 0o600 });
    await writeFile(inputPath, JSON.stringify(preparation), { mode: 0o600 });
    const inputEnvironment: Record<string, string | undefined> = {
      ...environment,
      [INSTALLED_PLUGIN_NATIVE_PREPARATION_ENV]: inputPath,
    };
    return {
      inputPath,
      directory,
      workerPath,
      preparation,
      worker,
      environment: inputEnvironment,
      actor,
      bootstrapVersion,
      defaultAgentVersionId: bootstrapVersion.agentVersionId,
    };
  }
  const state = {
    profile: { ...scope },
    resolvedActor: { ...actor } as typeof actor | null,
    packageAllowed: true,
    policyAllowed: true,
    requests: [] as string[],
    beforeReply: null as ((path: string) => Promise<void>) | null,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(String(url));
    if (endpoint.hostname !== "native-authority.example")
      throw new Error(
        "native_preparation_unexpected_supplier_or_model_request",
      );
    state.requests.push(endpoint.pathname);
    await state.beforeReply?.(endpoint.pathname);
    const request = JSON.parse(String(options?.body));
    let reply: unknown;
    if (endpoint.pathname === "/actor") reply = state.resolvedActor;
    else if (endpoint.pathname === "/profile") reply = state.profile;
    else if (endpoint.pathname === "/package") {
      if (request.purpose !== "read")
        throw new Error("preparation_must_not_request_execution_grant");
      reply = { outcome: state.packageAllowed ? "allow" : "deny" };
    } else if (endpoint.pathname === "/policy") {
      if (request.action !== "extension:read")
        throw new Error("preparation_must_not_request_execution_permission");
      reply = { outcome: state.policyAllowed ? "allow" : "deny" };
    } else throw new Error("unexpected_native_authority");
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await store.close();
    async function writable(path: string): Promise<void> {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true }))
        if (entry.isDirectory()) await writable(join(path, entry.name));
    }
    await writable(installRoot);
    await rm(directory, { recursive: true, force: true });
  });
  async function revise() {
    configuration = createExtensionConfiguration(
      {
        ...configuration,
        revision: configuration.revision + 1,
        createdAt: "2026-10-03T01:00:00.000Z",
      },
      digester,
    );
    await store.extensionStore().saveExtensionConfiguration({
      configuration,
      expectedRevision: configuration.revision - 1,
      receipt: {
        actorId: actor.actorId,
        idempotencyKey: `native-save-${configuration.revision}`,
        requestDigest: digester.sha256(
          `actual-configuration-${configuration.revision}`,
        ),
      },
    });
    return configuration;
  }
  async function select(
    selectionState: "enabled" | "disabled" | "uninstalled",
  ) {
    const selection = await store
      .pluginInstallationStore()
      .loadSelection({ scope, pluginId: identity.pluginId });
    if (selection === null) throw new Error("fixture_selection_missing");
    return store.pluginInstallationStore().commitSelection({
      scope,
      actor,
      expectedSelectionRevision: selection.revision,
      selection: {
        ...selection,
        revision: selection.revision + 1,
        state: selectionState,
        selectedPackageDigest:
          selectionState === "uninstalled" ? null : identity.packageDigest,
        updatedByPrincipalId: actor.principalId,
        updatedByActorId: actor.actorId,
      },
      receipt: {
        idempotencyKey: `select-${selection.revision + 1}`,
        requestDigest: digester.sha256(`select-${selection.revision + 1}`),
      },
    });
  }
  async function removeSource() {
    await rm(sourceDirectory, { recursive: true });
  }
  async function addPlugin(pluginId: string) {
    const business = parseExtensionManifest({ ...manifest, pluginId });
    const sourcePath = join(directory, pluginId);
    await mkdir(sourcePath, { mode: 0o700 });
    const files = [
      ["business.json", Buffer.from(JSON.stringify(business))],
      ["node.mjs", artifacts[1][1]],
    ] as const;
    for (const [path, bytes] of files)
      await writeFile(join(sourcePath, path), bytes);
    await writeFile(
      join(sourcePath, "crewon.plugin.json"),
      JSON.stringify({
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId,
        publisherId: identity.publisherId,
        version: identity.version,
        title: "Named additional Native plugin",
        description: "Actual immutable metadata",
        entrypoints: { node: "node.mjs", ui: null },
        businessManifestPath: "business.json",
        requires: [
          { service: "crewon.execution", apiVersion: "1", optional: false },
        ],
        provides: [],
        contributions: [],
        files: files.map(([path, bytes]) => ({
          path,
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })),
      }),
    );
    const bytes = await installLocalPluginPackage({
      directory: sourcePath,
      installRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    const addedIdentity = {
      ...identity,
      pluginId,
      packageDigest: bytes.packageDigest,
    };
    await store.pluginInstallationStore().recordInstalledPackage({
      scope,
      actor,
      package: {
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...scope,
        ...addedIdentity,
        installedAt: at,
        installedByPrincipalId: actor.principalId,
        installedByActorId: actor.actorId,
      },
      expectedSelectionRevision: null,
      receipt: {
        idempotencyKey: `install-${pluginId}`,
        requestDigest: digester.sha256(`install-${pluginId}`),
      },
    });
    const addedRegistration = await loadInstalledPluginBusinessRegistration({
      installRoot,
      expectedPluginId: pluginId,
      expectedPublisherId: addedIdentity.publisherId,
      expectedVersion: addedIdentity.version,
      expectedPackageDigest: addedIdentity.packageDigest,
      signal: new AbortController().signal,
      authorizeRead: async () => "allow",
    });
    const saved = createExtensionConfiguration(
      {
        ...configuration,
        pluginId,
        revision: 1,
        manifestDigest: addedRegistration.manifestDigest,
        implementationDigest: addedRegistration.implementationDigest,
      },
      digester,
    );
    await store.extensionStore().saveExtensionConfiguration({
      configuration: saved,
      expectedRevision: 0,
      receipt: {
        actorId: actor.actorId,
        idempotencyKey: `save-${pluginId}`,
        requestDigest: digester.sha256(`save-${pluginId}`),
      },
    });
    return { identity: addedIdentity, configuration: saved };
  }
  async function recordCounts() {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const names = [
        "extension_activations",
        "extension_run_bindings",
        "run_snapshots",
        "external_operations",
        "agent_versions",
        "agent_version_deployments",
        "agent_version_release_bundles",
        "agent_version_release_activations",
        "active_agent_version_releases",
        "plugin_credit_accounts",
        "plugin_credit_reservations",
      ];
      return Object.fromEntries(
        names.map((name) => {
          const exists = database
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(name);
          return [
            name,
            exists
              ? database.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()!
                  .count
              : 0,
          ];
        }),
      );
    } finally {
      database.close();
    }
  }
  return {
    input,
    state,
    store,
    identity,
    installation,
    configuration,
    revise,
    select,
    removeSource,
    addPlugin,
    recordCounts,
    dataDirectory,
    marker,
    readFile,
    chmod,
  };
}
