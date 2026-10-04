import { writeFileSync } from "node:fs";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import {
  AgentVersionReleaseApplicationService,
  compileAgentVersionReleaseBundle,
} from "@crewon/application";
import { createExtensionConfiguration } from "@crewon/domain";
import {
  nativeActor,
  nativeDigest,
  type nativeAuthorityFixture,
} from "./installed-plugin-native-authority.test-support.ts";
import type { InstalledPluginExecutionReadinessMetadata } from "./plugins/installed-plugin-execution-readiness-types.ts";
/** Actual registered versions, activated deployment and persisted configuration; no provider transport exists. */
export async function publishNativeNetworkMetadata(
  f: Awaited<ReturnType<typeof nativeAuthorityFixture>>,
  options: Readonly<{ publishDerivedDeployment?: boolean }> = {},
) {
  const at = "2026-10-04T00:00:00.000Z",
    digester = { sha256: nativeDigest };
  const source = {
    schemaVersion: "crewon.agent-version-source.v0" as const,
    agentVersionId: "native-original-agent",
    runtimeGeneration: "native-original-generation",
    policySnapshotId: "native-original-policy",
    instructions: "Named metadata-only policy test.",
    model: {
      adapterName: "direct-responses",
      adapterVersion: "1",
      modelId: "named-metadata-only",
      contextWindowTokens: 32000,
      maxOutputTokens: 512,
      autoCompactAtTokens: null,
    },
    execution: { streamMaxRetries: 0, maxToolRounds: 8 },
    resources: { workspaceRequired: false, governedContextDigest: null },
    tools: [],
  };
  const base = compileAgentVersion(source, digester),
    version = compileAgentVersion(
      {
        ...source,
        agentVersionId: "native-image-agent",
        runtimeGeneration: "native-image-generation",
        policySnapshotId: "native-image-policy",
      },
      digester,
    );
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: f.scope.tenantId,
      spaceId: f.scope.spaceId,
      pluginId: f.identity.pluginId,
      pluginVersion: f.identity.version,
      revision: 1,
      manifestDigest: nativeDigest("named-manifest"),
      implementationDigest: nativeDigest("named-implementation"),
      parameters: { baseUrl: "https://example.com/" },
      credentialBindings: [],
      createdByActorId: nativeActor.actorId,
      createdAt: at,
    },
    digester,
  );
  await f.store.extensionStore().saveExtensionConfiguration({
    configuration,
    expectedRevision: 0,
    receipt: {
      actorId: nativeActor.actorId,
      idempotencyKey: "configure",
      requestDigest: nativeDigest("configure"),
    },
  });
  const baseDeployment = {
    schemaVersion: "crewon.agent-version-deployment.v0" as const,
    tenantId: f.scope.tenantId,
    agentVersionId: base.agentVersionId,
    contentDigest: base.contentDigest,
    materializationDigest: nativeDigest("native-original-materialization"),
    authorityId: "standalone-authority",
    workspaceBindingId: null,
  };
  const target = {
    executionAuthority: "crewonKernel" as const,
    agentVersionId: version.agentVersionId,
    agentVersionContentDigest: version.contentDigest,
    materializationDigest: nativeDigest("native-image-materialization"),
    authorityId: "standalone-authority",
    runtimeGeneration: version.runtimeGeneration,
    policySnapshotId: version.policySnapshotId,
    workspaceBindingId: null,
  };
  const deployment = {
    schemaVersion: "crewon.agent-version-deployment.v0" as const,
    tenantId: f.scope.tenantId,
    agentVersionId: target.agentVersionId,
    contentDigest: target.agentVersionContentDigest,
    materializationDigest: target.materializationDigest,
    authorityId: target.authorityId,
    workspaceBindingId: target.workspaceBindingId,
  };
  for (const definition of [base, version])
    await f.store.registerAgentVersion(
      createAgentVersionAsset({
        tenantId: f.scope.tenantId,
        version: definition,
        createdAt: at,
      }),
    );
  const bundle = compileAgentVersionReleaseBundle(
    {
      tenantId: f.scope.tenantId,
      defaultAgentVersionId: base.agentVersionId,
      deployments:
        options.publishDerivedDeployment === false
          ? [baseDeployment]
          : [baseDeployment, deployment],
    },
    digester,
  );
  await new AgentVersionReleaseApplicationService({
    store: f.store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => at },
    digester,
  }).activate(nativeActor, bundle, "named-native-test-publication");
  const document = {
    schemaVersion: "crewon.installed-plugin-release.v1",
    tenantId: f.scope.tenantId,
    defaultAgentVersionId: base.agentVersionId,
    entries: [
      {
        scope: f.scope,
        packageIdentity: f.identity,
        configuration,
        approvalRequirement: "none",
        modelSource: {
          executionAuthority: "crewonKernel",
          runtimeBinding: {
            tenantId: f.scope.tenantId,
            agentVersionId: base.agentVersionId,
            contentDigest: base.contentDigest,
            authorityId: "standalone-authority",
            workspaceBindingId: null,
            provider: {
              kind: "directResponses",
              endpoint: "https://example.com/v1/responses",
              apiKeyEnvironment: null,
              storeResponses: false,
              requestProfile: "standard",
              idleTimeoutMs: 1000,
              sequencePolicy: "whenPresent",
            },
            mcpStdioConfigPath: null,
            deviceToolConfigPath: null,
            remoteMcpConfigPath: null,
          },
          version: base,
          deployment: baseDeployment,
        },
        version,
        target,
      },
    ],
  };
  writeFileSync(f.configuration.releaseDocumentPath, JSON.stringify(document), {
    mode: 0o600,
  });
  const metadata: InstalledPluginExecutionReadinessMetadata = {
    identity: f.identity,
    scope: f.scope,
    configuration,
    target,
    purpose: "submit",
  };
  return { metadata, document };
}
