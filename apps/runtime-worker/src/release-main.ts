import { v7 as uuidv7 } from "uuid";

import {
  activatePostgresRuntimeAgentVersionRelease,
  activateStandaloneRuntimeAgentVersionRelease,
} from "./agent-version-release-composition.ts";
import { loadAgentVersionDeployments } from "./runtime-binding-config.ts";
import {
  createConfiguredToolRuntime,
  createModelTransport,
  parseNativeWorkspaceReadCatalog,
  parseNonNegativeInteger,
  parsePositiveInteger,
} from "./runtime-process-environment.ts";
import {
  resolveRuntimeAuthorityValue,
  resolveRuntimeDatabaseAuthority,
} from "./runtime-database-environment.ts";
import { parseRuntimeWorkerSecurityMode } from "./runtime-provider-probe-environment.ts";
import { resolveRuntimeProductionWorkspaceEnvironment } from "./runtime-production-workspace-environment.ts";
import { SystemApplicationClock } from "./standalone-adapters.ts";
import {
  loadRuntimeReleaseActor,
  RuntimeReleaseAuthorization,
} from "./release-authority.ts";

const securityMode = parseRuntimeWorkerSecurityMode(
  process.env.CREWON_CONTROL_SECURITY_MODE ?? "standalone",
);
const productionWorkspace = resolveRuntimeProductionWorkspaceEnvironment(
  process.env,
  securityMode,
);
const databaseAuthority = resolveRuntimeDatabaseAuthority(
  process.env,
  securityMode,
);
const actor = loadRuntimeReleaseActor(process.env, securityMode);
const route = {
  authorityId: resolveRuntimeAuthorityValue(
    process.env,
    securityMode,
    "CREWON_AUTHORITY_ID",
    "standalone-authority",
  ),
  runtimeGeneration: resolveRuntimeAuthorityValue(
    process.env,
    securityMode,
    "CREWON_RUNTIME_GENERATION",
    "ts-v0",
  ),
  agentVersionId: resolveRuntimeAuthorityValue(
    process.env,
    securityMode,
    "CREWON_AGENT_VERSION_ID",
    "default-agent-v1",
  ),
  policySnapshotId: resolveRuntimeAuthorityValue(
    process.env,
    securityMode,
    "CREWON_POLICY_SNAPSHOT_ID",
    "standalone-policy-v0",
  ),
  workspaceBindingId: process.env.CREWON_WORKSPACE_BINDING_ID?.trim() || null,
};
const bindingsPath =
  process.env.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH?.trim();
const configuredDeployments = bindingsPath
  ? loadAgentVersionDeployments(bindingsPath, securityMode)
  : undefined;
const transport = createModelTransport();
const toolRuntime = await createConfiguredToolRuntime();

try {
  const common = {
    actor,
    authorization: new RuntimeReleaseAuthorization(actor),
    clock: new SystemApplicationClock(),
    activationId:
      process.env.CREWON_AGENT_VERSION_ACTIVATION_ID?.trim() || uuidv7(),
    runtimeTenantId: actor.tenantId,
    route,
    transport,
    agentInstructions: process.env.CREWON_AGENT_INSTRUCTIONS?.trim() || null,
    toolRuntime,
    nativeWorkspaceReadCatalog:
      productionWorkspace === undefined
        ? parseNativeWorkspaceReadCatalog(
            process.env.CREWON_NATIVE_WORKSPACE_READ_ENABLED,
          )
        : "enabled",
    streamMaxRetries: parseNonNegativeInteger(
      process.env.CREWON_RESPONSES_STREAM_MAX_RETRIES ?? "5",
      "CREWON_RESPONSES_STREAM_MAX_RETRIES_invalid",
    ),
    autoCompactAtTokens: parsePositiveInteger(
      process.env.CREWON_AUTO_COMPACT_AT_TOKENS ?? "200000",
      "CREWON_AUTO_COMPACT_AT_TOKENS_invalid",
    ),
    modelContextWindowTokens: parsePositiveInteger(
      process.env.CREWON_MODEL_CONTEXT_WINDOW_TOKENS ?? "273000",
      "CREWON_MODEL_CONTEXT_WINDOW_TOKENS_invalid",
    ),
    expectedAgentVersionDigest:
      process.env.CREWON_AGENT_VERSION_CONTENT_DIGEST?.trim() || null,
    ...(configuredDeployments === undefined
      ? {}
      : {
          agentVersionDeployments: configuredDeployments.filter(
            (deployment) => deployment.tenantId === actor.tenantId,
          ),
        }),
  };
  const activated =
    databaseAuthority.mode === "production"
      ? await activatePostgresRuntimeAgentVersionRelease({
          ...common,
          connectionString: databaseAuthority.connectionString,
          schema: databaseAuthority.schema,
        })
      : await activateStandaloneRuntimeAgentVersionRelease({
          ...common,
          databasePath: databaseAuthority.databasePath,
        });
  process.stdout.write(
    `${JSON.stringify({
      disposition: activated.activation.disposition,
      tenantId: actor.tenantId,
      releaseId: activated.plan.bundle.releaseId,
      activationId: common.activationId,
      agentVersionIds: activated.plan.deployments.map(
        (deployment) => deployment.agentVersionId,
      ),
      contentDigests: activated.plan.deployments.map(
        (deployment) => deployment.contentDigest,
      ),
      materializationDigests: activated.plan.deployments.map(
        (deployment) => deployment.materializationDigest,
      ),
    })}\n`,
  );
} finally {
  await Promise.allSettled([toolRuntime?.close?.(), transport.close?.()]);
}
