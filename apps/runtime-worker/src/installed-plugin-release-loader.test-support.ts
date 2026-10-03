import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import {
  AgentVersionReleaseApplicationService,
  compileAgentVersionReleaseBundle,
  type AgentVersionDeploymentCandidate,
} from "@crewon/application";
import { createExtensionConfiguration } from "@crewon/domain";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { createAgentVersionRuntimeBindings } from "./runtime-binding-config.ts";
import {
  installedPluginAgentRuntimeTarget,
  type InstalledPluginAgentRuntimeEntry,
} from "./plugins/installed-plugin-agent-runtime-factory.ts";
import { compileInstalledPluginAgentVersion } from "./plugins/installed-plugin-agent-version.ts";
import { loadInstalledPluginBusinessRegistration } from "./plugins/installed-plugin-business-registration.ts";
import {
  installedPluginReleaseDigester as digester,
  type InstalledPluginReleaseDocument,
  type InstalledPluginReleaseEntry,
} from "./plugins/installed-plugin-release-document.ts";
import { loadInstalledPluginRelease } from "./plugins/installed-plugin-release-loader.ts";

export { digester };
export const releaseActor = {
  tenantId: "release-tenant",
  spaceId: "release-space",
  actorId: "release-actor",
  principalId: "release-principal",
};
export const releaseScope = { ...releaseActor, profileId: "release-profile" };
export const timestamp = "2026-10-03T09:00:00.000Z";
export const pgOptions = {
  skip: !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 60_000,
};

async function removeTree(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory()) await removeTree(join(path, entry.name));
  await rm(path, { recursive: true, force: true });
}

/** Actual retained SDK distribution bytes; the model is metadata-only and makes no HTTP request. */
export async function installedReleaseFixture(
  t: TestContext,
  backend: "sqlite" | "postgres" = "sqlite",
  options: { versions?: 1 | 2 } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-release-loader-"));
  const installRoot = join(directory, "installed");
  await mkdir(installRoot, { mode: 0o700 });
  const databasePath = join(directory, "runtime.sqlite");
  const schema = `installed_release_${randomUUID().replaceAll("-", "")}`;
  const admin =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
          max: 2,
        })
      : null;
  let store: SqliteRunStore | PostgresDomainStore;
  let closed = false;
  const resources: { close(): void | Promise<void> }[] = [];
  t.after(async () => {
    try {
      for (const owner of resources.reverse()) await owner.close();
      if (!closed) await store?.close();
    } finally {
      if (admin !== null) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
      await removeTree(directory);
    }
  });
  store =
    backend === "postgres"
      ? await PostgresDomainStore.open({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
          schema,
          maxPoolSize: 3,
        })
      : new SqliteRunStore(databasePath);
  const extensions = store.extensionStore();
  await extensions.migrate();
  const installations = store.pluginInstallationStore();
  await installations.migrate();
  const baseVersion = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "release-default-agent",
      runtimeGeneration: "base-generation",
      policySnapshotId: "base-policy",
      instructions: "Original unchanged host instructions.",
      model: {
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "fixture-existing-model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 512,
        autoCompactAtTokens: null,
      },
      execution: { streamMaxRetries: 0, maxToolRounds: 8 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
  const runtimeBinding = {
    tenantId: releaseActor.tenantId,
    agentVersionId: baseVersion.agentVersionId,
    contentDigest: baseVersion.contentDigest,
    authorityId: "release-host-authority",
    workspaceBindingId: null,
    provider: {
      kind: "directResponses" as const,
      endpoint: "https://model.fixture.example/v1/responses",
      apiKeyEnvironment: null,
      storeResponses: false,
      requestProfile: "standard" as const,
      idleTimeoutMs: 1000,
      sequencePolicy: "whenPresent" as const,
    },
    mcpStdioConfigPath: null,
    deviceToolConfigPath: null,
    remoteMcpConfigPath: null,
  };
  const base = createAgentVersionRuntimeBindings({
    config: {
      schemaVersion: "crewon.agent-version-runtime-bindings.v0",
      bindings: [runtimeBinding],
    },
    environment: {},
  })[0]!;
  const baseDeployment: AgentVersionDeploymentCandidate = {
    schemaVersion: "crewon.agent-version-deployment.v0",
    tenantId: base.tenantId,
    agentVersionId: base.agentVersionId,
    contentDigest: base.contentDigest,
    materializationDigest: base.materializationDigest,
    authorityId: base.authorityId,
    workspaceBindingId: base.workspaceBindingId,
  };
  const scope = {
    tenantId: releaseActor.tenantId,
    spaceId: releaseActor.spaceId,
    profileId: releaseScope.profileId,
  };
  const state = { allowed: true, metadataReads: 0 };
  const entries: InstalledPluginReleaseEntry[] = [];
  const packages = [];
  for (const version of options.versions === 2
    ? ["1.0.0", "2.0.0"]
    : ["1.0.0"]) {
    const source =
      version === "1.0.0"
        ? process.env.CREWON_TEST_KREA_PLUGIN_V1_DIR
        : process.env.CREWON_TEST_KREA_PLUGIN_V2_DIR;
    const actualSource =
      source ??
      fileURLToPath(
        new URL(
          `../../../output/extensions/installable-plugins/readiness-short-drama-20261003/krea2/${version}`,
          import.meta.url,
        ),
      );
    const installed = await installLocalPluginPackage({
      directory: actualSource,
      installRoot,
      authorization: async () => ({ outcome: "allow" }),
    });
    const registration = await loadInstalledPluginBusinessRegistration({
      installRoot,
      expectedPluginId: installed.descriptor.pluginId,
      expectedPublisherId: installed.descriptor.publisherId,
      expectedVersion: installed.descriptor.version,
      expectedPackageDigest: installed.packageDigest,
      authorizeRead: async () => "allow",
      signal: new AbortController().signal,
    });
    packages.push(installed);
    const current = await installations.loadSelection({
      scope,
      pluginId: registration.identity.pluginId,
    });
    await installations.recordInstalledPackage({
      scope,
      actor: releaseActor,
      package: {
        schemaVersion: "crewon.installed-plugin-package.v1",
        ...scope,
        ...registration.identity,
        installedAt: timestamp,
        installedByActorId: releaseActor.actorId,
        installedByPrincipalId: releaseActor.principalId,
      },
      expectedSelectionRevision: current?.revision ?? null,
      receipt: {
        idempotencyKey: `install-${version}`,
        requestDigest: digester.sha256(`install-${version}`),
      },
    });
    const configuration = createExtensionConfiguration(
      {
        schemaVersion: "crewon.extension-configuration.v0",
        tenantId: scope.tenantId,
        spaceId: scope.spaceId,
        pluginId: registration.identity.pluginId,
        pluginVersion: version,
        manifestDigest: registration.manifestDigest,
        implementationDigest: registration.implementationDigest,
        revision: entries.length + 1,
        parameters: { baseUrl: "https://vendor.fixture.example/" },
        credentialBindings: [],
        createdByActorId: releaseActor.actorId,
        createdAt: timestamp,
      },
      digester,
    );
    await extensions.saveExtensionConfiguration({
      configuration,
      expectedRevision: entries.length,
      receipt: {
        actorId: releaseActor.actorId,
        idempotencyKey: `configure-${version}`,
        requestDigest: digester.sha256(`configure-${version}`),
      },
    });
    const derivedVersion = compileInstalledPluginAgentVersion({
      base: { executionAuthority: "crewonKernel", version: baseVersion },
      registration,
      agentVersionId: `installed-krea-${version}`,
      runtimeGeneration: `installed-${version}`,
      policySnapshotId: "installed-policy",
      digester,
    });
    const entry: InstalledPluginAgentRuntimeEntry = {
      scope,
      registration,
      configuration,
      approvalRequirement: "none",
      base: {
        executionAuthority: "crewonKernel",
        version: baseVersion,
        deployment: baseDeployment,
      },
      version: derivedVersion,
      authorityId: base.authorityId,
      workspaceBindingId: base.workspaceBindingId,
      transportOwnership: base.transportOwnership,
      createTransport: base.createTransport,
      createBaseToolRuntime: base.createToolRuntime,
    };
    const target = installedPluginAgentRuntimeTarget({
      defaultAgentVersionId: baseVersion.agentVersionId,
      entry,
    });
    entries.push({
      scope,
      packageIdentity: registration.identity,
      configuration,
      approvalRequirement: "none",
      modelSource: {
        executionAuthority: "crewonKernel",
        runtimeBinding,
        version: baseVersion,
        deployment: baseDeployment,
      },
      version: derivedVersion,
      target,
    });
  }
  const document: InstalledPluginReleaseDocument = {
    schemaVersion: "crewon.installed-plugin-release.v1",
    tenantId: scope.tenantId,
    defaultAgentVersionId: baseVersion.agentVersionId,
    entries,
  };
  const loaderInput = {
    document,
    installRoot,
    environment: {},
    async authorizeRead(
      request: { identity: unknown; scope: unknown; purpose: string },
      signal: AbortSignal,
    ): Promise<"allow" | "deny"> {
      signal.throwIfAborted();
      assert.deepEqual(request.scope, scope);
      assert.equal(request.purpose, "read");
      state.metadataReads++;
      return state.allowed ? "allow" : "deny";
    },
  };
  async function publish(
    options: { baseDeployment?: AgentVersionDeploymentCandidate } = {},
  ) {
    for (const version of [
      baseVersion,
      ...entries.map((entry) => entry.version),
    ])
      await store.registerAgentVersion(
        createAgentVersionAsset({
          tenantId: scope.tenantId,
          version,
          createdAt: timestamp,
        }),
      );
    const loaded = await loadInstalledPluginRelease(loaderInput);
    resources.push(loaded);
    const bundle = compileAgentVersionReleaseBundle(
      {
        tenantId: scope.tenantId,
        defaultAgentVersionId: baseVersion.agentVersionId,
        deployments: [
          options.baseDeployment ?? baseDeployment,
          ...loaded.deployments,
        ],
      },
      digester,
    );
    await new AgentVersionReleaseApplicationService({
      store,
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      clock: { now: () => timestamp },
      digester,
    }).activate(releaseActor, bundle, "release-loader-fixture-activation");
    return loaded;
  }
  async function closeStore() {
    if (!closed) {
      closed = true;
      await store.close();
    }
  }
  async function reopenStore() {
    await closeStore();
    store =
      backend === "postgres"
        ? await PostgresDomainStore.open({
            connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
            schema,
            maxPoolSize: 3,
          })
        : new SqliteRunStore(databasePath);
    closed = false;
    return store;
  }
  return {
    directory,
    installRoot,
    databasePath,
    schema,
    document,
    loaderInput,
    state,
    base,
    baseVersion,
    baseDeployment,
    entries,
    packages,
    publish,
    own(owner: { close(): void | Promise<void> }) {
      resources.push(owner);
    },
    get store() {
      return store;
    },
    closeStore,
    reopenStore,
  };
}
