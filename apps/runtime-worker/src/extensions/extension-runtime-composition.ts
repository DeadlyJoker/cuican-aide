import { isDeepStrictEqual } from "node:util";
import {
  CurrentExtensionExecutionAuthorization,
  type ActorContext,
  type AgentVersionDeploymentCandidate,
  type AuthorizationPort,
} from "@crewon/application";
import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import {
  agentVersionDeploymentCandidates,
  createAgentVersionRuntimeFactory,
  loadRuntimeBindingConfig,
  type RuntimeBindingConfig,
} from "../runtime-binding-config.ts";
import type { NetworkDnsResolver } from "../network-egress.ts";
import type { PinnedHttpPort } from "../pinned-node-http.ts";

export type RuntimeExtensionActorResolver = (
  owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
  signal: AbortSignal,
) => Promise<ActorContext | null>;

/** Explicit host opt-in. Identity resolution must come from a trusted current host. */
export type RuntimeExtensionCompositionConfig = Readonly<{
  runtimeBindingsPath: string;
  authorization: AuthorizationPort;
  resolveActor: RuntimeExtensionActorResolver;
  environment?: Readonly<Record<string, string | undefined>>;
  dns?: NetworkDnsResolver;
  transport?: PinnedHttpPort;
  now?: () => Date;
  privateHost?: Readonly<{ port: number; token: string; deadlineMs?: number }>;
}>;

/** Checks deployment input before opening storage or allocating a plugin runtime. */
export function extensionCompositionDeployments(input: {
  config: RuntimeExtensionCompositionConfig;
  tenantId: string;
  defaultAgentVersionId: string;
}): readonly AgentVersionDeploymentCandidate[] {
  const config = checkedBindings(input);
  return agentVersionDeploymentCandidates(config).filter(
    (deployment) => deployment.agentVersionId !== input.defaultAgentVersionId,
  );
}

function checkedBindings(input: {
  config: RuntimeExtensionCompositionConfig;
  tenantId: string;
  defaultAgentVersionId: string;
}): RuntimeBindingConfig {
  const config = loadRuntimeBindingConfig(input.config.runtimeBindingsPath);
  const bindings = config.bindings;
  const extensions = bindings.filter(
    (binding) => binding.extensionConfigPath !== undefined,
  );
  if (extensions.length === 0 || extensions.length > 32)
    throw new Error("extension_runtime_bindings_invalid");
  if (bindings.some((binding) => binding.tenantId !== input.tenantId))
    throw new Error("runtime_deployment_tenant_mismatch");
  if (
    extensions.some(
      (binding) => binding.agentVersionId === input.defaultAgentVersionId,
    )
  )
    throw new Error("extension_default_agent_override_forbidden");
  return config;
}

/** Children borrow the parent's DB. Migrations and close ownership stay explicit. */
export async function composeRuntimeExtensions(input: {
  config: RuntimeExtensionCompositionConfig;
  store: SqliteRunStore | PostgresDomainStore;
  tenantId: string;
  defaultAgentVersionId: string;
  expectedDeployments: readonly AgentVersionDeploymentCandidate[];
}) {
  const config = checkedBindings({
    ...input,
    defaultAgentVersionId: input.defaultAgentVersionId,
  });
  const extensions = input.store.extensionStore();
  const operations = input.store.externalOperationStore();
  await extensions.migrate();
  await operations.migrate();
  const access = new CurrentExtensionExecutionAuthorization({
    authorization: input.config.authorization,
    resolveActor: input.config.resolveActor,
  });
  const factory = createAgentVersionRuntimeFactory({
    config,
    environment: input.config.environment ?? process.env,
    extensionDependencies: {
      extensions,
      operations,
      runs: input.store,
      access,
      dns: input.config.dns,
      transport: input.config.transport,
      now: input.config.now,
    },
  });
  const expected = new Map(
    input.expectedDeployments.map((item) => [item.agentVersionId, item]),
  );
  const actual = factory
    .deploymentBindings(input.tenantId)
    .filter((item) => item.agentVersionId !== input.defaultAgentVersionId);
  if (
    actual.length !== expected.size ||
    actual.some(
      (item) => !isDeepStrictEqual(item, expected.get(item.agentVersionId)),
    )
  )
    throw new Error("agent_version_runtime_materialization_drift");
  return factory;
}
