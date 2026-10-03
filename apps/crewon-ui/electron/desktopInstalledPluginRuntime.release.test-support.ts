import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compileAgentVersion,
  parseAgentVersionAsset,
} from "@crewon/agent-version";
import {
  parseExtensionConfiguration,
  type PluginProfileScope,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
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
import { loadInstalledPluginBusinessRegistration } from "../../runtime-worker/src/plugins/installed-plugin-business-registration.ts";
import { installedPluginAgentRuntimeTarget } from "../../runtime-worker/src/plugins/installed-plugin-agent-runtime-factory.ts";
import {
  installedPluginReleaseDigester as digester,
  parseInstalledPluginReleaseDocument,
} from "../../runtime-worker/src/plugins/installed-plugin-release-document.ts";
import { DESKTOP_RUNTIME_OWNER as actor } from "./desktopExtensionRuntime.ts";

/** Compiles operator inputs from actual Native HTTP records and the original published default.
 * It neither installs, selects, saves configuration nor publishes any Agent/release. */
export async function prepareNativeInstalledProcessRelease(
  input: Readonly<{
    dataDirectory: string;
    scope: PluginProfileScope;
    identity: Readonly<{
      pluginId: string;
      publisherId: string;
      version: string;
      packageDigest: string;
    }>;
    configuration: unknown;
    environment: NodeJS.ProcessEnv;
  }>,
) {
  const store = new SqliteRunStore(join(input.dataDirectory, "control.sqlite"));
  const configuration = parseExtensionConfiguration(
    input.configuration,
    digester,
  );
  const environment = input.environment;
  const transport = createModelTransport("responses", {}, environment);
  const tools = await createConfiguredToolRuntime(environment);
  try {
    const active = await store.loadActiveAgentVersionRelease({
      tenantId: actor.tenantId,
    });
    assert.ok(
      active,
      "the ordinary Native Supervisor must publish its original default first",
    );
    const route = resolveRuntimeBootstrapRoute(environment);
    assert.equal(route.agentVersionId, active.bundle.defaultAgentVersionId);
    const bootstrap = resolveRuntimeBootstrapAgent(environment);
    const common = {
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
    const original = parseAgentVersionAsset(
      (await store.loadAgentVersion({
        tenantId: actor.tenantId,
        agentVersionId: route.agentVersionId,
      }))!,
      digester,
    );
    assert.deepEqual(
      compileRuntimeAgentVersionRelease(common, digester).bootstrapVersion,
      original,
    );
    assert.deepEqual(
      await store.extensionStore().loadExtensionConfiguration({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        pluginId: input.identity.pluginId,
        revision: configuration.revision,
      }),
      configuration,
    );
    const selection = await store
      .pluginInstallationStore()
      .loadSelection({ scope: input.scope, pluginId: input.identity.pluginId });
    assert.ok(selection);
    assert.equal(selection.state, "disabled");
    assert.equal(selection.selectedPackageDigest, input.identity.packageDigest);
    const registration = await loadInstalledPluginBusinessRegistration({
      installRoot: join(input.dataDirectory, "plugins"),
      expectedPluginId: input.identity.pluginId,
      expectedPublisherId: input.identity.publisherId,
      expectedVersion: input.identity.version,
      expectedPackageDigest: input.identity.packageDigest,
      authorizeRead: async ({ descriptor, packageDigest }) => {
        assert.deepEqual(
          {
            pluginId: descriptor.pluginId,
            publisherId: descriptor.publisherId,
            version: descriptor.version,
            packageDigest,
          },
          input.identity,
        );
        return "allow";
      },
      signal: new AbortController().signal,
    });
    assert.equal(configuration.manifestDigest, registration.manifestDigest);
    assert.equal(
      configuration.implementationDigest,
      registration.implementationDigest,
    );
    const {
      schemaVersion: _schema,
      contentDigest: _digest,
      ...source
    } = original;
    const modelSource = compileAgentVersion(
      {
        ...source,
        schemaVersion: "crewon.agent-version-source.v0",
        agentVersionId: "native-installed-operator-model-source-v1",
      },
      digester,
    );
    const bindings = developmentAgentRuntimeBindings({
      versions: [modelSource],
      profiles: [undefined],
      tenantId: actor.tenantId,
      authorityId: route.authorityId,
      workspaceBindingId: null,
      endpoint: environment.CREWON_RESPONSES_ENDPOINT!,
      requestProfile: "standard",
      sequencePolicy: "required",
      idleTimeoutMs: 90_000,
      directApiKeyEnvironment: "CREWON_MODEL_API_KEY",
      toolRuntimeMode: "independent",
    });
    const deployment = agentVersionDeploymentCandidates(bindings)[0]!;
    const materializer = createAgentVersionRuntimeBindings({
      config: bindings,
      environment,
    })[0]!;
    const version = compileInstalledPluginAgentVersion({
      base: { executionAuthority: "crewonKernel", version: modelSource },
      registration,
      agentVersionId: "native-installed-operator-professional-v1",
      runtimeGeneration: "native-installed-operator-generation-v1",
      policySnapshotId: "native-installed-operator-policy-v1",
      digester,
    });
    const target = installedPluginAgentRuntimeTarget({
      defaultAgentVersionId: route.agentVersionId,
      entry: {
        scope: input.scope,
        registration,
        configuration,
        approvalRequirement: "none",
        base: {
          executionAuthority: "crewonKernel",
          version: modelSource,
          deployment,
        },
        version,
        authorityId: route.authorityId,
        workspaceBindingId: null,
        transportOwnership: "request",
        createTransport: materializer.createTransport.bind(materializer),
        createBaseToolRuntime:
          materializer.createToolRuntime.bind(materializer),
      },
    });
    const document = parseInstalledPluginReleaseDocument({
      schemaVersion: "crewon.installed-plugin-release.v1",
      tenantId: actor.tenantId,
      defaultAgentVersionId: route.agentVersionId,
      entries: [
        {
          scope: input.scope,
          packageIdentity: registration.identity,
          configuration,
          approvalRequirement: "none",
          modelSource: {
            executionAuthority: "crewonKernel",
            runtimeBinding: bindings.bindings[0]!,
            version: modelSource,
            deployment,
          },
          version,
          target,
        },
      ],
    });
    const originalAdditional = await Promise.all(
      active.bundle.deployments
        .filter((row) => row.agentVersionId !== route.agentVersionId)
        .map(async (row) =>
          parseAgentVersionAsset(
            (await store.loadAgentVersion({
              tenantId: actor.tenantId,
              agentVersionId: row.agentVersionId,
            }))!,
            digester,
          ),
        ),
    );
    const plan = compileRuntimeAgentVersionRelease(
      {
        ...common,
        additionalAgentVersions: [...originalAdditional, modelSource, version],
        agentVersionDeployments: [
          ...active.bundle.deployments.filter(
            (row) => row.agentVersionId !== route.agentVersionId,
          ),
          deployment,
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
      digester,
    );
    assert.equal(
      await store.loadAgentVersion({
        tenantId: actor.tenantId,
        agentVersionId: modelSource.agentVersionId,
      }),
      null,
    );
    assert.equal(
      await store.loadAgentVersion({
        tenantId: actor.tenantId,
        agentVersionId: version.agentVersionId,
      }),
      null,
    );
    assert.equal(
      await store.loadAgentVersionReleaseBundle({
        tenantId: actor.tenantId,
        releaseId: plan.bundle.releaseId,
      }),
      null,
    );
    const path = join(
      input.dataDirectory,
      "native-installed-operator-release.json",
    );
    await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    return { document, plan, path, previousBundle: active.bundle };
  } finally {
    await tools?.close?.();
    await transport.close?.();
    await store.close();
  }
}
