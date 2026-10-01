import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  compileAgentVersion,
  createAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import {
  commitExtensionRecoveryCapsule,
  extensionRecoveryDirectory,
  putExtensionRecoveryFile,
  type ExtensionRecoveryManifest,
  type ExtensionRecoveryInputFile,
} from "@crewon/agent-version/extension-recovery";
import { parseRuntimeBootstrapInputs } from "@crewon/contracts";
import { SqliteRunStore } from "@crewon/store";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";

export function historicalFixtureDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
const digester = { sha256: historicalFixtureDigest };

/** Real immutable capsule IO and compiled definitions; archive is an explicit nonexecuted unit port. */
export async function createDesktopExtensionHistoricalFixture(input: {
  dataRoot: string;
  profiles?: boolean;
  profileCount?: number;
  profileId?: string;
  profileInstructions?: string;
  instructions?: string;
  modelCatalog?: boolean;
  credentialRequired?: boolean;
  complete?: boolean;
  mutate?: (
    documents: Map<ExtensionRecoveryInputFile, unknown>,
    directory: string,
  ) => void;
}) {
  const owner = DESKTOP_RUNTIME_OWNER;
  const selection = {
    dataRoot: input.dataRoot,
    capsuleId: historicalFixtureDigest(`unit-capsule:${input.dataRoot}`),
  };
  const directory = await extensionRecoveryDirectory({
    selection,
    create: true,
  });
  const bootstrap = parseRuntimeBootstrapInputs({
    schemaVersion: "crewon.runtime-bootstrap-inputs.v0",
    model: {
      endpoint: "https://provider.example/v1/responses",
      modelId: "model-a",
      credentialRequired: input.credentialRequired ?? true,
      maxOutputTokens: null,
      storeResponses: false,
      requestProfile: "responsesLite",
      idleTimeoutMs: 60000,
      sequencePolicy: "whenPresent",
      identityPolicy: "terminalAuthoritative",
      outputDeltaFlushBytes: 1024,
      websocket: null,
    },
    agent: {
      instructions: input.instructions ?? "saved bootstrap instructions",
      contextWindowTokens: 273000,
      autoCompactAtTokens: 200000,
      streamMaxRetries: 5,
      maxToolRounds: 32,
    },
    route: {
      authorityId: "standalone-authority",
      runtimeGeneration: "ts-v0",
      agentVersionId: "saved-default",
      policySnapshotId: "standalone-policy-v0",
      workspaceBindingId: null,
    },
    modelCatalog: input.modelCatalog === false ? null : ["model-a", "model-b"],
    profiles:
      input.profiles === false
        ? []
        : Array.from({ length: input.profileCount ?? 1 }, (_, index) => ({
            agentVersionId:
              index === 0
                ? (input.profileId ?? "saved-profile")
                : `${input.profileId ?? "saved-profile"}-${index}`,
            instructions:
              input.profileInstructions ?? "saved profile instructions",
          })),
    tooling: {
      mcpStdioConfigPath: null,
      desktopWorkspaceRoot: null,
      nativeWorkspaceReadCatalog: "disabled",
    },
  });
  const definition = {
    schemaVersion: "crewon.agent-version-source.v0" as const,
    agentVersionId: bootstrap.route.agentVersionId,
    runtimeGeneration: bootstrap.route.runtimeGeneration,
    policySnapshotId: bootstrap.route.policySnapshotId,
    instructions: bootstrap.agent.instructions,
    model: {
      adapterName: "direct-responses",
      adapterVersion: "1+responses-lite",
      modelId: bootstrap.model.modelId,
      contextWindowTokens: bootstrap.agent.contextWindowTokens,
      autoCompactAtTokens: bootstrap.agent.autoCompactAtTokens,
    },
    execution: {
      streamMaxRetries: bootstrap.agent.streamMaxRetries,
      maxToolRounds: bootstrap.agent.maxToolRounds,
    },
    resources: { workspaceRequired: false, governedContextDigest: null },
    tools: [],
  };
  const baseVersions = [
    compileAgentVersion(definition, digester),
    ...bootstrap.profiles.map((profile) =>
      compileAgentVersion({ ...definition, ...profile }, digester),
    ),
  ];
  for (const modelId of bootstrap.modelCatalog ?? []) {
    if (modelId === bootstrap.model.modelId) continue;
    for (const source of [...baseVersions]) {
      baseVersions.push(
        compileAgentVersion(
          {
            ...definition,
            agentVersionId: `${source.agentVersionId}:model-${historicalFixtureDigest(modelId).slice(7, 31)}`,
            instructions: source.instructions,
            model: { ...definition.model, modelId },
          },
          digester,
        ),
      );
    }
  }
  const registration = {
    pluginId: "crewon.comfyui-krea2",
    pluginVersion: "1.0.0",
    manifestDigest: historicalFixtureDigest("unit-domain-manifest"),
    implementationDigest: historicalFixtureDigest(
      "unit-registration-implementation",
    ),
  };
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: owner.tenantId,
      spaceId: owner.spaceId,
      ...registration,
      revision: 1,
      parameters: { baseUrl: "https://comfy.example/" },
      credentialBindings: [],
      createdByActorId: owner.actorId,
      createdAt: "2026-10-03T00:00:00.000Z",
    },
    digester,
  );
  const pluginVersion = compileAgentVersion(
    {
      ...definition,
      agentVersionId: "saved-plugin",
      instructions: "unit plugin instructions",
      tools: [
        {
          schemaVersion: "crewon.tool-definition.v0",
          kind: "function",
          name: "unit_plugin_tool",
          description: "Unit-only catalog.",
          execution: "serial",
          inputSchema: { type: "object" },
        },
      ],
    },
    digester,
  );
  const provider = {
    kind: "directResponses" as const,
    endpoint: bootstrap.model.endpoint,
    apiKeyEnvironment: bootstrap.model.credentialRequired
      ? "CREWON_MODEL_API_KEY"
      : null,
    storeResponses: false,
    requestProfile: "responsesLite" as const,
    idleTimeoutMs: 60000,
    sequencePolicy: "whenPresent" as const,
  };
  function binding(
    version: CompiledAgentVersion,
    extensionConfigPath?: string,
  ) {
    return {
      tenantId: owner.tenantId,
      agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
      authorityId: bootstrap.route.authorityId,
      workspaceBindingId: null,
      provider,
      mcpStdioConfigPath: null,
      deviceToolConfigPath: null,
      remoteMcpConfigPath: null,
      ...(extensionConfigPath
        ? { extensionConfigPath }
        : { toolRuntimeMode: "shared" as const }),
    };
  }
  const baseBindings = {
    schemaVersion: "crewon.agent-version-runtime-bindings.v0",
    bindings: baseVersions.map((version) => binding(version)),
  };
  const pluginBindings = {
    schemaVersion: "crewon.agent-version-runtime-bindings.v0",
    bindings: [binding(pluginVersion, join(directory, "snapshot-00.json"))],
  };
  const versions = [...baseVersions, pluginVersion];
  const deployments = versions
    .map((version, index) => ({
      schemaVersion: "crewon.agent-version-deployment.v0",
      tenantId: owner.tenantId,
      agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
      materializationDigest:
        index === 0
          ? historicalFixtureDigest(
              JSON.stringify({
                schemaVersion: "crewon.static-agent-materialization.v0",
                authorityId: bootstrap.route.authorityId,
                workspaceBindingId: null,
                adapterName: version.model.adapterName,
                adapterVersion: version.model.adapterVersion,
                modelId: version.model.modelId,
              }),
            )
          : index === versions.length - 1
            ? historicalFixtureDigest(
                "unit-plugin-materialization-old-code-port",
              )
            : historicalFixtureDigest(
                extensionCanonicalJson({
                  schemaVersion: "crewon.agent-version-materialization.v0",
                  binding: baseBindings.bindings[index],
                  mcpStdioConfig: null,
                  deviceToolConfig: null,
                  remoteMcpConfig: null,
                }),
              ),
      authorityId: bootstrap.route.authorityId,
      workspaceBindingId: null,
    }))
    .sort((left, right) =>
      left.agentVersionId < right.agentVersionId
        ? -1
        : left.agentVersionId > right.agentVersionId
          ? 1
          : 0,
    );
  const releaseId = historicalFixtureDigest(
    JSON.stringify({
      schemaVersion: "crewon.agent-version-release-manifest.v0",
      tenantId: owner.tenantId,
      defaultAgentVersionId: bootstrap.route.agentVersionId,
      deployments,
    }),
  );
  const bundle = {
    schemaVersion: "crewon.agent-version-release-bundle.v0",
    tenantId: owner.tenantId,
    releaseId,
    manifestDigest: releaseId,
    defaultAgentVersionId: bootstrap.route.agentVersionId,
    deployments,
  };
  const documents = new Map<ExtensionRecoveryInputFile, unknown>([
    ["bootstrap.json", bootstrap],
    ["base-bindings.json", baseBindings],
    ["plugin-bindings.json", pluginBindings],
    [
      "plugin-assets.json",
      {
        schemaVersion: "crewon.extension-agent-version-assets.v0",
        assets: [
          createAgentVersionAsset({
            tenantId: owner.tenantId,
            version: pluginVersion,
            createdAt: "2026-10-03T00:00:00.000Z",
          }),
        ],
      },
    ],
    [
      "snapshot-00.json",
      {
        schemaVersion: "crewon.extension-runtime-config.v0",
        configuration,
        approvalRequirement: "perAction",
      },
    ],
    [
      "release.json",
      {
        schemaVersion: "crewon.extension-recovery-release.v0",
        tenantId: owner.tenantId,
        plan: {
          bootstrapVersion: baseVersions[0],
          versions,
          deployments,
          bundle,
        },
      },
    ],
  ]);
  const databasePath = join(input.dataRoot, "control.sqlite");
  const store = new SqliteRunStore(databasePath);
  try {
    for (const version of versions)
      await store.registerAgentVersion(
        createAgentVersionAsset({
          tenantId: owner.tenantId,
          version,
          createdAt: "2026-10-03T00:00:00.000Z",
        }),
      );
    await store.activateAgentVersionRelease({
      bundle: bundle as Parameters<
        SqliteRunStore["activateAgentVersionRelease"]
      >[0]["bundle"],
      activation: {
        schemaVersion: "crewon.agent-version-release-activation.v0",
        tenantId: owner.tenantId,
        releaseId,
        activationId: "unit-historical-publication",
        previousReleaseId: null,
        operator: {
          principalId: owner.principalId,
          actorId: owner.actorId,
          spaceId: owner.spaceId,
        },
        activatedAt: "2026-10-03T00:00:00.000Z",
      },
      expectedActiveReleaseId: null,
    });
  } finally {
    await store.close();
  }
  for (const [file, document] of documents)
    documents.set(file, structuredClone(document));
  input.mutate?.(documents, directory);
  const files = [];
  for (const [file, document] of documents)
    files.push(
      await putExtensionRecoveryFile({
        selection,
        file,
        bytes: Buffer.from(`${JSON.stringify(document)}\n`),
      }),
    );
  const manifest: ExtensionRecoveryManifest = {
    schemaVersion: "crewon.extension-recovery-capsule.v0",
    capsuleId: selection.capsuleId,
    owner,
    implementationDigest: historicalFixtureDigest("unit-source-build-port"),
    buildIdentityDigest: historicalFixtureDigest("unit-build-artifact-port"),
    providerBinding: {
      providerId: "saved-provider",
      endpoint: "https://provider.example/v1",
      responsesEndpoint: bootstrap.model.endpoint,
      credentialRequired: bootstrap.model.credentialRequired,
    },
    releaseId,
    registrations: [registration],
    targets: [
      parseExtensionExecutionTarget({
        executionAuthority: "crewonKernel",
        agentVersionId: pluginVersion.agentVersionId,
        agentVersionContentDigest: pluginVersion.contentDigest,
        materializationDigest: deployments.find(
          (value) => value.agentVersionId === pluginVersion.agentVersionId,
        )!.materializationDigest,
        authorityId: bootstrap.route.authorityId,
        runtimeGeneration: pluginVersion.runtimeGeneration,
        policySnapshotId: pluginVersion.policySnapshotId,
        workspaceBindingId: null,
      }),
    ],
    files,
  };
  if (input.complete !== false)
    await commitExtensionRecoveryCapsule({ selection, manifest });
  const archive = {
    implementationDigest: manifest.implementationDigest,
    buildIdentityDigest: manifest.buildIdentityDigest,
    historicalWorkItemScope: "crewon.extension-work-item-scope.v1" as const,
    bundles: [
      {
        file: "runtime-worker.mjs",
        path: join(input.dataRoot, "nonexecuted-unit-worker.mjs"),
      },
    ],
  };
  return {
    selection,
    manifest,
    directory,
    documents,
    bootstrap,
    registration,
    archive,
    resolveProvider: () => ({
      availability: "available" as const,
      apiKey: "unit-current-provider-key",
    }),
    databasePath,
  };
}
