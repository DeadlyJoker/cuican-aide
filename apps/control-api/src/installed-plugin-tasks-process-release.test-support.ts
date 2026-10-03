import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compileAgentVersion } from "@crewon/agent-version";
import { parseExtensionConfiguration } from "@crewon/domain";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import type { PostgresDomainStore } from "@crewon/store";
import { compileRuntimeAgentVersionRelease } from "../../runtime-worker/src/agent-version-release.ts";
import { developmentAgentRuntimeBindings } from "../../runtime-worker/src/development-agent-profiles.ts";
import {
  agentVersionDeploymentCandidates,
  createAgentVersionRuntimeBindings,
} from "../../runtime-worker/src/runtime-binding-config.ts";
import {
  createConfiguredToolRuntime,
  createModelTransport,
} from "../../runtime-worker/src/runtime-process-environment.ts";
import {
  resolveRuntimeBootstrapAgent,
  resolveRuntimeBootstrapRoute,
} from "../../runtime-worker/src/runtime-bootstrap-defaults.ts";
import { compileInstalledPluginAgentVersion } from "../../runtime-worker/src/plugins/installed-plugin-agent-version.ts";
import {
  installedPluginAgentRuntimeTarget,
  type InstalledPluginAgentRuntimeEntry,
} from "../../runtime-worker/src/plugins/installed-plugin-agent-runtime-factory.ts";
import { loadInstalledPluginBusinessRegistration } from "../../runtime-worker/src/plugins/installed-plugin-business-registration.ts";
import {
  installedPluginReleaseDigester as digester,
  parseInstalledPluginReleaseDocument,
  type InstalledPluginReleaseEntry,
} from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import { installedReleaseProcessPackages } from "../../runtime-worker/src/installed-plugin-release-process.test-support.ts";
import {
  installedProcessActor as actor,
  installedProcessScope as scope,
  installedProcessDefaultAgent,
  type InstalledWorkerProcessFixture,
} from "../../runtime-worker/src/installed-plugin-worker-process.test-support.ts";

/** Operator byte installation only: no module import, configuration, activation, Agent or task. */
export async function installTaskProcessPackages(
  input: Readonly<{
    fixture: InstalledWorkerProcessFixture;
    store: PostgresDomainStore;
  }>,
) {
  const { fixture, store } = input;
  await mkdir(fixture.installRoot, { mode: 0o700 });
  const ledger = store.pluginInstallationStore();
  await ledger.migrate();
  const registrations = [];
  for (const [index, directory] of installedReleaseProcessPackages.entries()) {
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
    const current = await ledger.loadSelection({
      scope,
      pluginId: registration.identity.pluginId,
    });
    await ledger.recordInstalledPackage({
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
        idempotencyKey: `named-process-operator-install-${index}`,
        requestDigest: digester.sha256(
          `named-process-operator-install-${index}`,
        ),
      },
    });
    registrations.push(registration);
  }
  return Object.freeze(registrations);
}

/** Compiles a private operator release document from exact HTTP-created and persisted configuration records. Never publishes or saves them. */
export async function prepareTaskProcessReleaseInput(
  input: Readonly<{
    fixture: InstalledWorkerProcessFixture;
    store: PostgresDomainStore;
    registrations: Awaited<ReturnType<typeof installTaskProcessPackages>>;
    configurations: readonly unknown[];
  }>,
) {
  const { fixture, store, registrations } = input;
  assert.equal(input.configurations.length, registrations.length);
  const configurations = input.configurations.map((value) =>
    parseExtensionConfiguration(value, digester),
  );
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
    const entries: InstalledPluginReleaseEntry[] = [];
    for (const [index, registration] of registrations.entries()) {
      const configuration = configurations[index]!;
      assert.deepEqual(
        await store.extensionStore().loadExtensionConfiguration({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          pluginId: registration.identity.pluginId,
          revision: configuration.revision,
        }),
        configuration,
        "CLI inputs must derive from the real HTTP-persisted configuration",
      );
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
          ...entries.map((entry) => entry.version),
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
      { mode: 0o600 },
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
    for (const version of plan.versions) {
      assert.equal(
        await store.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId: version.agentVersionId,
        }),
        null,
      );
      assert.equal(
        await store.loadAgentVersionDeployment({
          tenantId: actor.tenantId,
          agentVersionId: version.agentVersionId,
        }),
        null,
      );
    }
    return { document, plan, bindingsPath };
  } finally {
    await tools?.close?.();
    await transport.close?.();
  }
}
