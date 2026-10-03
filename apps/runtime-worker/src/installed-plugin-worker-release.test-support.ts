import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  compileAgentVersion,
  parseAgentVersionAsset,
} from "@crewon/agent-version";
import type { AuthorizationPort } from "@crewon/application";
import { createExtensionConfiguration } from "@crewon/domain";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import {
  activateRuntimeAgentVersionRelease,
  compileRuntimeAgentVersionRelease,
} from "./agent-version-release.ts";
import { developmentAgentRuntimeBindings } from "./development-agent-profiles.ts";
import {
  createAgentVersionRuntimeBindings,
  agentVersionDeploymentCandidates,
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
import { loadInstalledPluginBusinessRegistration } from "./plugins/installed-plugin-business-registration.ts";
import {
  installedPluginAgentRuntimeTarget,
  type InstalledPluginAgentRuntimeEntry,
} from "./plugins/installed-plugin-agent-runtime-factory.ts";
import {
  installedPluginReleaseDigester as digester,
  parseInstalledPluginReleaseDocument,
  type InstalledPluginReleaseEntry,
} from "./plugins/installed-plugin-release-document.ts";
import { loadInstalledPluginRelease } from "./plugins/installed-plugin-release-loader.ts";
import {
  installedProcessActor as actor,
  installedProcessDefaultAgent,
  installedProcessScope as scope,
  type InstalledWorkerProcessFixture,
} from "./installed-plugin-worker-process.test-support.ts";

/** Explicit test release authorization. It does not stand in for the child Worker's HTTPS execution decisions. */
const releaseAuthorization: AuthorizationPort = {
  async authorize(input) {
    assert.deepEqual(input.actor, actor);
    assert.equal(input.resource.tenantId, actor.tenantId);
    assert.ok(
      input.action === "agentVersion:publish" ||
        input.action === "agentVersion:deploy",
    );
    return { outcome: "allow" };
  },
};

/** Real immutable packages, real compiled model materializers, and authorized durable release activation. No grants or quotes. */
export async function prepareInstalledWorkerRelease(
  fixture: InstalledWorkerProcessFixture,
  packageDirectories: readonly string[],
  parameters?: Readonly<{ organization: string; providerBaseUrl: string }>,
) {
  assert.ok(packageDirectories.length >= 1 && packageDirectories.length <= 2);
  await mkdir(fixture.installRoot, { mode: 0o700 });
  const store = new SqliteRunStore(fixture.databasePath);
  const transport = createModelTransport("responses", {}, fixture.environment);
  const toolRuntime = await createConfiguredToolRuntime(fixture.environment);
  try {
    const bootstrap = resolveRuntimeBootstrapAgent(fixture.environment);
    const route = resolveRuntimeBootstrapRoute(fixture.environment);
    const baseConfig = {
      runtimeTenantId: actor.tenantId,
      route,
      transport,
      toolRuntime,
      agentInstructions: bootstrap.instructions,
      streamMaxRetries: bootstrap.streamMaxRetries,
      maxToolRounds: bootstrap.maxToolRounds,
      autoCompactAtTokens: bootstrap.autoCompactAtTokens,
      modelContextWindowTokens: bootstrap.contextWindowTokens,
      nativeWorkspaceReadCatalog: "disabled" as const,
    };
    const asset = await store.loadAgentVersion({
      tenantId: actor.tenantId,
      agentVersionId: installedProcessDefaultAgent,
    });
    assert.ok(
      asset,
      "the original release-main must publish the default Agent first",
    );
    const defaultVersion = parseAgentVersionAsset(asset, digester);
    assert.deepEqual(
      compileRuntimeAgentVersionRelease(baseConfig, digester).bootstrapVersion,
      defaultVersion,
    );
    const {
      schemaVersion: _schema,
      contentDigest: _digest,
      ...defaultSource
    } = defaultVersion;
    const sourceVersion = compileAgentVersion(
      {
        ...defaultSource,
        schemaVersion: "crewon.agent-version-source.v0",
        agentVersionId: "installed-process-model-source",
      },
      digester,
    );
    const bindingConfig = developmentAgentRuntimeBindings({
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
    const sourceDeployment =
      agentVersionDeploymentCandidates(bindingConfig)[0]!;
    const materializer = createAgentVersionRuntimeBindings({
      config: bindingConfig,
      environment: fixture.environment,
    })[0]!;
    const clock = { now: () => "2026-10-03T00:00:00.000Z" };
    // The independent model source uses the actual v0 binding digest, rather than the default Agent's static digest.
    const sourcePlan = compileRuntimeAgentVersionRelease(
      {
        ...baseConfig,
        additionalAgentVersions: [sourceVersion],
        agentVersionDeployments: [sourceDeployment],
      },
      digester,
    );
    await activateRuntimeAgentVersionRelease({
      actor,
      store,
      authorization: releaseAuthorization,
      clock,
      plan: sourcePlan,
      activationId: "installed-process-source-release",
    });
    const extensions = store.extensionStore(),
      installations = store.pluginInstallationStore();
    await extensions.migrate();
    await installations.migrate();
    const entries: InstalledPluginReleaseEntry[] = [];
    for (const [index, directory] of packageDirectories.entries()) {
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
          installedAt: clock.now(),
          installedByPrincipalId: actor.principalId,
          installedByActorId: actor.actorId,
        },
        receipt: {
          idempotencyKey: `installed-process-package-${index}`,
          requestDigest: digester.sha256(`package-${index}`),
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
          parameters:
            parameters ??
            (registration.identity.pluginId === "crewon.comfyui-krea2"
              ? { baseUrl: "https://comfy.metadata-only.example/" }
              : {
                  organization: "Formal Worker test fixture",
                  providerBaseUrl: "https://supplier.metadata-only.example/",
                }),
          credentialBindings: [],
          createdByActorId: actor.actorId,
          createdAt: clock.now(),
        },
        digester,
      );
      await extensions.saveExtensionConfiguration({
        configuration,
        expectedRevision: index,
        receipt: {
          actorId: actor.actorId,
          idempotencyKey: `installed-process-config-${index}`,
          requestDigest: digester.sha256(`configuration-${index}`),
        },
      });
      const version = compileInstalledPluginAgentVersion({
        base: { executionAuthority: "crewonKernel", version: sourceVersion },
        registration,
        agentVersionId: `installed-process-plugin-${index + 1}`,
        runtimeGeneration: `installed-process-generation-${index + 1}`,
        policySnapshotId: `installed-process-policy-${index + 1}`,
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
          deployment: sourceDeployment,
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
          runtimeBinding: bindingConfig.bindings[0]!,
          version: sourceVersion,
          deployment: sourceDeployment,
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
    const loaded = await loadInstalledPluginRelease({
      document,
      installRoot: fixture.installRoot,
      authorizeRead: async () => "allow",
      environment: fixture.environment,
    });
    const plan = compileRuntimeAgentVersionRelease(
      {
        ...baseConfig,
        additionalAgentVersions: loaded.versions,
        agentVersionDeployments: loaded.deployments,
      },
      digester,
    );
    await activateRuntimeAgentVersionRelease({
      actor,
      store,
      authorization: releaseAuthorization,
      clock,
      plan,
      activationId: "installed-process-final-release",
    });
    await writeFile(fixture.releaseDocumentPath, JSON.stringify(document), {
      mode: 0o600,
    });
    await writeFile(
      fixture.configPath,
      JSON.stringify(fixture.configuration()),
      { mode: 0o600 },
    );
    await loaded.close();
    return { document, plan };
  } finally {
    await toolRuntime?.close?.();
    await transport.close?.();
    await store.close();
  }
}

export function installedProcessTables(
  databasePath: string,
): readonly string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => row.name as string);
  } finally {
    database.close();
  }
}

export function installedProcessBusinessRows(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = installedProcessTables(databasePath);
    return Object.fromEntries(
      [
        "run_snapshots",
        "plugin_task_admissions",
        "plugin_query_task_admissions",
        "plugin_credit_accounts",
        "plugin_credit_reservations",
      ]
        .filter((table) => tables.includes(table))
        .map((table) => [
          table,
          Number(
            (
              database
                .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
                .get() as { count: number }
            ).count,
          ),
        ]),
    );
  } finally {
    database.close();
  }
}

export function deliveredInstalledProcessPackage(version: "1.0.0" | "2.0.0") {
  return (
    process.env[
      version === "1.0.0"
        ? "CREWON_TEST_KREA_PLUGIN_V1_DIR"
        : "CREWON_TEST_KREA_PLUGIN_V2_DIR"
    ] ??
    join(
      fileRoot(),
      "output/extensions/installable-plugins/readiness-short-drama-20261003/krea2",
      version,
    )
  );
}
function fileRoot() {
  return new URL("../../..", import.meta.url).pathname;
}
