import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  compileAgentVersion,
  createAgentVersionAsset,
  parseAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import {
  AgentVersionApplicationService,
  AgentVersionReleaseApplicationService,
  compileAgentVersionReleaseBundle,
  sameAgentVersionReleaseBundle,
  type ActorContext,
  type ActivateAgentVersionReleaseResult,
  type AgentVersionDeploymentCandidate,
  type AgentVersionDeploymentStore,
  type AgentVersionReleaseStore,
  type AgentVersionStore,
  type ApplicationClock,
  type AuthorizationPort,
  type ContentDigester,
  type RunRoute,
} from "@crewon/application";
import type { GovernedContextBundle } from "@crewon/context";
import type { ToolRuntimePort } from "@crewon/tool-broker";

import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import { runtimeReleaseToolDefinitions } from "./runtime-workspace-read-tool-catalog.ts";
import { RUNTIME_BOOTSTRAP_DEFAULTS } from "./runtime-bootstrap-defaults.ts";

export type RuntimeAgentVersionReleaseConfig = Readonly<{
  runtimeTenantId: string;
  route: RunRoute;
  transport: ModelTransportPort;
  agentInstructions?: string | null;
  governedContext?: GovernedContextBundle;
  toolRuntime?: ToolRuntimePort;
  nativeWorkspaceReadCatalog?: "disabled" | "enabled";
  streamMaxRetries?: number;
  maxToolRounds?: number;
  autoCompactAtTokens?: number | null;
  modelContextWindowTokens?: number;
  modelIdentity?: Readonly<{
    adapterName: string;
    adapterVersion: string;
    modelId: string;
  }>;
  modelId?: string;
  expectedAgentVersionDigest?: string | null;
  agentVersionDeployments?: readonly AgentVersionDeploymentCandidate[];
  additionalAgentVersions?: readonly CompiledAgentVersion[];
}>;

export type RuntimeAgentVersionReleasePlan = Readonly<{
  bootstrapVersion: CompiledAgentVersion;
  versions: readonly CompiledAgentVersion[];
  deployments: readonly AgentVersionDeploymentCandidate[];
  bundle: ReturnType<typeof compileAgentVersionReleaseBundle>;
}>;

type RuntimeAgentVersionReleaseStore = AgentVersionStore &
  AgentVersionDeploymentStore &
  AgentVersionReleaseStore;

/** Deterministically compiles the bootstrap asset and every runtime binding. */
export function compileRuntimeAgentVersionRelease(
  config: RuntimeAgentVersionReleaseConfig,
  digester: ContentDigester = new NodeSha256ContentDigester(),
): RuntimeAgentVersionReleasePlan {
  if (config.modelIdentity !== undefined) {
    throw new Error(
      "runtime_release_bootstrap_model_identity_override_unsupported",
    );
  }
  const bootstrapVersion = compileRuntimeAgentVersion(config, digester);
  const compiledVersions = [
    bootstrapVersion,
    ...(config.additionalAgentVersions ?? []),
  ].map((version) => structuredClone(version));
  const deployments = [
    staticAgentVersionDeployment(config, bootstrapVersion, digester),
    ...(config.agentVersionDeployments ?? []),
  ].map((deployment) => structuredClone(deployment));
  const deploymentIds = new Set<string>();
  for (const deployment of deployments) {
    if (deployment.tenantId !== config.runtimeTenantId) {
      throw new Error("runtime_deployment_tenant_mismatch");
    }
    if (deploymentIds.has(deployment.agentVersionId)) {
      throw new Error("runtime_release_duplicate_agent_version");
    }
    deploymentIds.add(deployment.agentVersionId);
  }
  const compiledById = new Map(
    compiledVersions.map((version) => [version.agentVersionId, version]),
  );
  const deploymentById = new Map(
    deployments.map((deployment) => [deployment.agentVersionId, deployment]),
  );
  if (
    compiledById.size !== compiledVersions.length ||
    compiledVersions.some(
      (version) =>
        deploymentById.get(version.agentVersionId)?.contentDigest !==
        version.contentDigest,
    )
  ) {
    throw new Error("runtime_release_version_deployment_mismatch");
  }
  const bundle = compileAgentVersionReleaseBundle(
    {
      tenantId: config.runtimeTenantId,
      defaultAgentVersionId: bootstrapVersion.agentVersionId,
      deployments,
    },
    digester,
  );
  return {
    bootstrapVersion,
    versions: compiledVersions,
    deployments: bundle.deployments,
    bundle,
  };
}

/** Performs the authorized release mutation separately from Worker construction. */
export async function activateRuntimeAgentVersionRelease(input: {
  actor: ActorContext;
  store: RuntimeAgentVersionReleaseStore;
  authorization: AuthorizationPort;
  clock: ApplicationClock;
  plan: RuntimeAgentVersionReleasePlan;
  activationId: string;
}): Promise<ActivateAgentVersionReleaseResult> {
  if (input.actor.tenantId !== input.plan.deployments[0]?.tenantId) {
    throw new Error("runtime_release_actor_tenant_mismatch");
  }
  const versions = new AgentVersionApplicationService({
    store: input.store,
    authorization: input.authorization,
  });
  const releases = new AgentVersionReleaseApplicationService({
    store: input.store,
    authorization: input.authorization,
    clock: input.clock,
    digester: new NodeSha256ContentDigester(),
  });
  for (const version of input.plan.versions) {
    await versions.publish(
      input.actor,
      createAgentVersionAsset({
        tenantId: input.actor.tenantId,
        version,
        createdAt: input.clock.now(),
      }),
    );
  }
  return releases.activate(input.actor, input.plan.bundle, input.activationId);
}

/** Verifies that release activation completed before a Worker can execute. */
export async function verifyRuntimeAgentVersionRelease(input: {
  tenantId: string;
  store: RuntimeAgentVersionReleaseStore;
  plan: RuntimeAgentVersionReleasePlan;
  digester?: ContentDigester;
}): Promise<void> {
  const registered = await input.store.loadAgentVersionReleaseBundle({
    tenantId: input.tenantId,
    releaseId: input.plan.bundle.releaseId,
  });
  if (registered === null) {
    throw new Error("runtime_release_bundle_missing");
  }
  if (!sameAgentVersionReleaseBundle(registered, input.plan.bundle)) {
    throw new Error("runtime_release_bundle_mismatch");
  }
  for (const version of input.plan.versions) {
    const asset = await input.store.loadAgentVersion({
      tenantId: input.tenantId,
      agentVersionId: version.agentVersionId,
    });
    if (asset === null) {
      throw new Error("runtime_release_asset_missing");
    }
    let persisted: CompiledAgentVersion;
    try {
      persisted = parseAgentVersionAsset(
        asset,
        input.digester ?? new NodeSha256ContentDigester(),
      );
    } catch (error) {
      throw new Error("runtime_release_asset_invalid", { cause: error });
    }
    if (
      persisted.agentVersionId !== version.agentVersionId ||
      persisted.contentDigest !== version.contentDigest
    ) {
      throw new Error("runtime_release_asset_mismatch");
    }
  }
  for (const expected of input.plan.deployments) {
    const actual = await input.store.loadAgentVersionDeployment({
      tenantId: expected.tenantId,
      agentVersionId: expected.agentVersionId,
    });
    if (actual === null) {
      throw new Error("runtime_release_deployment_missing");
    }
    if (!sameDeployment(actual, expected)) {
      throw new Error("runtime_release_deployment_mismatch");
    }
  }
}

export function compileRuntimeAgentVersion(
  config: RuntimeAgentVersionReleaseConfig,
  digester: ContentDigester = new NodeSha256ContentDigester(),
): CompiledAgentVersion {
  if (config.modelIdentity !== undefined && config.modelId !== undefined) {
    throw new Error("runtime_release_model_identity_ambiguous");
  }
  const modelIdentity = runtimeModelIdentity(config);
  if (
    config.nativeWorkspaceReadCatalog === "enabled" &&
    config.route.workspaceBindingId === null
  ) {
    throw new Error("runtime_release_workspace_read_authority_missing");
  }
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: config.route.agentVersionId,
      runtimeGeneration: config.route.runtimeGeneration,
      policySnapshotId: config.route.policySnapshotId,
      instructions: config.agentInstructions ?? null,
      model: {
        ...modelIdentity,
        ...(config.transport.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: config.transport.maxOutputTokens }),
        contextWindowTokens:
          config.modelContextWindowTokens ??
          RUNTIME_BOOTSTRAP_DEFAULTS.contextWindowTokens,
        autoCompactAtTokens:
          config.autoCompactAtTokens === undefined
            ? RUNTIME_BOOTSTRAP_DEFAULTS.autoCompactAtTokens
            : config.autoCompactAtTokens,
      },
      execution: {
        streamMaxRetries:
          config.streamMaxRetries ??
          RUNTIME_BOOTSTRAP_DEFAULTS.streamMaxRetries,
        maxToolRounds:
          config.maxToolRounds ?? RUNTIME_BOOTSTRAP_DEFAULTS.maxToolRounds,
      },
      resources: {
        workspaceRequired: config.route.workspaceBindingId !== null,
        governedContextDigest:
          config.governedContext === undefined
            ? null
            : digester.sha256(
                JSON.stringify(config.governedContext.modelItems()),
              ),
      },
      tools: runtimeReleaseToolDefinitions({
        toolRuntime: config.toolRuntime,
        nativeWorkspaceReadCatalog:
          config.nativeWorkspaceReadCatalog ?? "disabled",
      }),
    },
    digester,
    config.expectedAgentVersionDigest,
  );
}

function staticAgentVersionDeployment(
  config: RuntimeAgentVersionReleaseConfig,
  version: CompiledAgentVersion,
  digester: ContentDigester,
): AgentVersionDeploymentCandidate {
  const modelIdentity = runtimeModelIdentity(config);
  return {
    schemaVersion: "crewon.agent-version-deployment.v0",
    tenantId: config.runtimeTenantId,
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    materializationDigest: digester.sha256(
      JSON.stringify({
        schemaVersion: "crewon.static-agent-materialization.v0",
        authorityId: config.route.authorityId,
        workspaceBindingId: config.route.workspaceBindingId,
        ...modelIdentity,
      }),
    ),
    authorityId: config.route.authorityId,
    workspaceBindingId: config.route.workspaceBindingId,
  };
}

function runtimeModelIdentity(
  config: RuntimeAgentVersionReleaseConfig,
): Readonly<{ adapterName: string; adapterVersion: string; modelId: string }> {
  if (config.modelIdentity !== undefined) {
    return config.modelIdentity;
  }
  return {
    adapterName: config.transport.adapterName,
    adapterVersion: config.transport.adapterVersion,
    modelId: config.modelId ?? config.transport.modelId,
  };
}

function sameDeployment(
  actual: Readonly<{
    schemaVersion: string;
    tenantId: string;
    agentVersionId: string;
    contentDigest: string;
    materializationDigest: string;
    authorityId: string;
    workspaceBindingId: string | null;
  }>,
  expected: AgentVersionDeploymentCandidate,
): boolean {
  return (
    actual.schemaVersion === expected.schemaVersion &&
    actual.tenantId === expected.tenantId &&
    actual.agentVersionId === expected.agentVersionId &&
    actual.contentDigest === expected.contentDigest &&
    actual.materializationDigest === expected.materializationDigest &&
    actual.authorityId === expected.authorityId &&
    actual.workspaceBindingId === expected.workspaceBindingId
  );
}
