import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { compileAgentVersion } from "@crewon/agent-version";
import { createExtensionConfiguration } from "@crewon/domain";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { compileRuntimeAgentVersionRelease } from "./agent-version-release.ts";
import { developmentAgentRuntimeBindings } from "./development-agent-profiles.ts";
import {
  agentVersionDeploymentCandidates,
  createAgentVersionRuntimeBindings,
} from "./runtime-binding-config.ts";
import {
  createConfiguredToolRuntime,
  createModelTransport,
} from "./runtime-process-environment.ts";
import {
  resolveRuntimeBootstrapAgent,
  resolveRuntimeBootstrapRoute,
} from "./runtime-bootstrap-defaults.ts";
import { compileInstalledPluginAgentVersion } from "./plugins/installed-plugin-agent-version.ts";
import {
  installedPluginAgentRuntimeTarget,
  type InstalledPluginAgentRuntimeEntry,
} from "./plugins/installed-plugin-agent-runtime-factory.ts";
import { loadInstalledPluginBusinessRegistration } from "./plugins/installed-plugin-business-registration.ts";
import {
  installedPluginReleaseDigester as digester,
  parseInstalledPluginReleaseDocument,
  type InstalledPluginReleaseEntry,
} from "./plugins/installed-plugin-release-document.ts";
import {
  installedProcessActor as actor,
  installedProcessDefaultAgent,
  installedProcessScope as scope,
  type InstalledWorkerProcessFixture,
} from "./installed-plugin-worker-process.test-support.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
export const installedReleaseProcessPackages = ["1.0.0", "2.0.0"].map(
  (version) =>
    process.env[
      version === "1.0.0"
        ? "CREWON_TEST_BUSINESS_PLUGIN_V1_DIR"
        : "CREWON_TEST_BUSINESS_PLUGIN_V2_DIR"
    ] ??
    join(
      repository,
      "output/extensions/installable-plugins/installed-worker-report-20261003",
      version,
    ),
);
export const installedReleaseProcessPackagesMissing =
  installedReleaseProcessPackages.some((path) => !existsSync(path));

/** This setup never publishes an Agent, deployment, or release. The actual CLI must do all three. */
export async function prepareInstalledReleaseProcessInput(
  fixture: InstalledWorkerProcessFixture,
  parameters: Readonly<{ organization: string; providerBaseUrl: string }> = {
    organization: "Actual publication process fixture",
    providerBaseUrl: "https://supplier.metadata-only.example/",
  },
  storage?: Readonly<{ store: SqliteRunStore | PostgresDomainStore }>,
) {
  await mkdir(fixture.installRoot, { mode: 0o700 });
  const store = storage?.store ?? new SqliteRunStore(fixture.databasePath);
  const transport = createModelTransport("responses", {}, fixture.environment);
  const tools = await createConfiguredToolRuntime(fixture.environment);
  try {
    const bootstrap = resolveRuntimeBootstrapAgent(fixture.environment);
    const route = resolveRuntimeBootstrapRoute(fixture.environment);
    const baseConfig = {
      runtimeTenantId: actor.tenantId,
      route,
      transport,
      toolRuntime: tools,
      agentInstructions: bootstrap.instructions,
      streamMaxRetries: bootstrap.streamMaxRetries,
      maxToolRounds: bootstrap.maxToolRounds,
      autoCompactAtTokens: bootstrap.autoCompactAtTokens,
      modelContextWindowTokens: bootstrap.contextWindowTokens,
      nativeWorkspaceReadCatalog: "disabled" as const,
    };
    const { bootstrapVersion } = compileRuntimeAgentVersionRelease(
      baseConfig,
      digester,
    );
    const {
      schemaVersion: _schema,
      contentDigest: _digest,
      ...source
    } = bootstrapVersion;
    const sourceVersion = compileAgentVersion(
      {
        ...source,
        schemaVersion: "crewon.agent-version-source.v0",
        agentVersionId: "installed-release-process-model-source",
      },
      digester,
    );
    const bindings = developmentAgentRuntimeBindings({
      versions: [sourceVersion],
      profiles: [undefined],
      tenantId: actor.tenantId,
      authorityId: route.authorityId,
      workspaceBindingId: null,
      endpoint: fixture.endpoint,
      requestProfile: "standard",
      sequencePolicy: "required",
      idleTimeoutMs: 5000,
      directApiKeyEnvironment: null,
      toolRuntimeMode: "independent",
    });
    const deployment = agentVersionDeploymentCandidates(bindings)[0]!;
    const materializer = createAgentVersionRuntimeBindings({
      config: bindings,
      environment: fixture.environment,
    })[0]!;
    const extensions = store.extensionStore();
    const installations = store.pluginInstallationStore();
    await extensions.migrate();
    await installations.migrate();
    const entries: InstalledPluginReleaseEntry[] = [];
    for (const [
      index,
      directory,
    ] of installedReleaseProcessPackages.entries()) {
      const installed = await installLocalPluginPackage({
        directory,
        installRoot: fixture.installRoot,
        authorization: async () => ({ outcome: "allow" }),
      });
      const registration = await loadInstalledPluginBusinessRegistration({
        installRoot: fixture.installRoot,
        expectedPluginId: installed.descriptor.pluginId,
        expectedPublisherId: installed.descriptor.publisherId,
        expectedVersion: installed.descriptor.version,
        expectedPackageDigest: installed.packageDigest,
        authorizeRead: async () => "allow",
        signal: new AbortController().signal,
      });
      const current = await installations.loadSelection({
        scope,
        pluginId: registration.identity.pluginId,
      });
      await installations.recordInstalledPackage({
        scope,
        actor,
        expectedSelectionRevision: current?.revision ?? null,
        package: {
          schemaVersion: "crewon.installed-plugin-package.v1",
          ...scope,
          ...registration.identity,
          installedAt: "2026-10-03T00:00:00.000Z",
          installedByPrincipalId: actor.principalId,
          installedByActorId: actor.actorId,
        },
        receipt: {
          idempotencyKey: `release-process-install-${index}`,
          requestDigest: digester.sha256(`install-${index}`),
        },
      });
      const configuration = createExtensionConfiguration(
        {
          schemaVersion: "crewon.extension-configuration.v0",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          pluginId: registration.identity.pluginId,
          pluginVersion: registration.identity.version,
          manifestDigest: registration.manifestDigest,
          implementationDigest: registration.implementationDigest,
          revision: index + 1,
          parameters,
          credentialBindings: [],
          createdByActorId: actor.actorId,
          createdAt: "2026-10-03T00:00:00.000Z",
        },
        digester,
      );
      await extensions.saveExtensionConfiguration({
        configuration,
        expectedRevision: index,
        receipt: {
          actorId: actor.actorId,
          idempotencyKey: `release-process-config-${index}`,
          requestDigest: digester.sha256(`config-${index}`),
        },
      });
      const version = compileInstalledPluginAgentVersion({
        base: { executionAuthority: "crewonKernel", version: sourceVersion },
        registration,
        agentVersionId: `installed-release-process-plugin-${index + 1}`,
        runtimeGeneration: `installed-release-process-generation-${index + 1}`,
        policySnapshotId: `installed-release-process-policy-${index + 1}`,
        digester,
      });
      const entry: InstalledPluginAgentRuntimeEntry = {
        scope,
        registration,
        configuration,
        approvalRequirement: "none",
        base: {
          executionAuthority: "crewonKernel",
          version: sourceVersion,
          deployment,
        },
        version,
        authorityId: route.authorityId,
        workspaceBindingId: null,
        transportOwnership: "request",
        createTransport: materializer.createTransport.bind(materializer),
        createBaseToolRuntime:
          materializer.createToolRuntime.bind(materializer),
      };
      entries.push({
        scope,
        packageIdentity: registration.identity,
        configuration,
        approvalRequirement: "none",
        modelSource: {
          executionAuthority: "crewonKernel",
          runtimeBinding: bindings.bindings[0]!,
          version: sourceVersion,
          deployment,
        },
        version,
        target: installedPluginAgentRuntimeTarget({
          defaultAgentVersionId: installedProcessDefaultAgent,
          entry,
        }),
      });
    }
    const document = parseInstalledPluginReleaseDocument({
      schemaVersion: "crewon.installed-plugin-release.v1",
      tenantId: actor.tenantId,
      defaultAgentVersionId: installedProcessDefaultAgent,
      entries,
    });
    const plan = compileRuntimeAgentVersionRelease(
      {
        ...baseConfig,
        additionalAgentVersions: [
          sourceVersion,
          ...entries.map((e) => e.version),
        ],
        agentVersionDeployments: [
          deployment,
          ...entries.map(({ target }) => ({
            schemaVersion: "crewon.agent-version-deployment.v0" as const,
            tenantId: actor.tenantId,
            agentVersionId: target.agentVersionId,
            contentDigest: target.agentVersionContentDigest,
            materializationDigest: target.materializationDigest,
            authorityId: target.authorityId,
            workspaceBindingId: target.workspaceBindingId,
          })),
        ],
      },
      digester,
    );
    const bindingsPath = join(fixture.directory, "source-bindings.json");
    await writeFile(bindingsPath, JSON.stringify(bindings), { mode: 0o600 });
    await writeFile(fixture.releaseDocumentPath, JSON.stringify(document), {
      mode: 0o600,
    });
    await writeFile(
      fixture.configPath,
      JSON.stringify(fixture.configuration()),
      {
        mode: 0o600,
      },
    );
    fixture.environment.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH =
      bindingsPath;
    fixture.environment.CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH =
      fixture.configPath;
    fixture.environment.CREWON_AGENT_VERSION_ACTIVATION_ID =
      "installed-release-process-activation";
    assert.equal(
      await store.loadActiveAgentVersionRelease({ tenantId: actor.tenantId }),
      null,
    );
    assert.equal(
      await store.loadAgentVersionReleaseBundle({
        tenantId: actor.tenantId,
        releaseId: plan.bundle.releaseId,
      }),
      null,
    );
    for (const version of plan.versions) {
      assert.equal(
        await store.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId: version.agentVersionId,
        }),
        null,
        "test setup cannot publish prerequisites or derived Agents",
      );
      assert.equal(
        await store.loadAgentVersionDeployment({
          tenantId: actor.tenantId,
          agentVersionId: version.agentVersionId,
        }),
        null,
      );
    }
    if (store instanceof SqliteRunStore)
      assert.ok(
        Object.values(
          installedReleaseProcessPublicationRows(fixture.databasePath),
        ).every((count) => count === 0),
      );
    return { document, plan, bindingsPath };
  } finally {
    await tools?.close?.();
    await transport.close?.();
    await store.close();
  }
}

export function installedReleaseProcessPublicationRows(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        "agent_versions",
        "agent_version_deployments",
        "agent_version_release_bundles",
        "agent_version_release_activations",
        "active_agent_version_releases",
      ].map((table) => [
        table,
        (
          database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          }
        ).count,
      ]),
    );
  } finally {
    database.close();
  }
}
