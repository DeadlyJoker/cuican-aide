import { v7 as uuidv7 } from "uuid";

import {
  activatePostgresRuntimeAgentVersionRelease,
  activateStandaloneRuntimeAgentVersionRelease,
} from "./agent-version-release-composition.ts";
import { loadAgentVersionDeployments } from "./runtime-binding-config.ts";
import {
  createConfiguredToolRuntime,
  createModelTransport,
  environmentOr,
  parseNativeWorkspaceReadCatalog,
  parseNonNegativeInteger,
  parsePositiveInteger,
  requiredEnvironment,
} from "./runtime-process-environment.ts";
import { SystemApplicationClock } from "./standalone-adapters.ts";
import {
  loadRuntimeReleaseActor,
  RuntimeReleaseAuthorization,
} from "./release-authority.ts";

const actor = loadRuntimeReleaseActor();
const bindingsPath =
  process.env.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH?.trim();
const configuredDeployments = bindingsPath
  ? loadAgentVersionDeployments(bindingsPath)
  : undefined;
const transport = createModelTransport(
  environmentOr("CREWON_MODEL_ADAPTER", "responses"),
);
const toolRuntime = await createConfiguredToolRuntime();

try {
  const common = {
    actor,
    authorization: new RuntimeReleaseAuthorization(actor),
    clock: new SystemApplicationClock(),
    activationId:
      process.env.CREWON_AGENT_VERSION_ACTIVATION_ID?.trim() || uuidv7(),
    runtimeTenantId: actor.tenantId,
    route: {
      authorityId: environmentOr("CREWON_AUTHORITY_ID", "standalone-authority"),
      runtimeGeneration: environmentOr("CREWON_RUNTIME_GENERATION", "ts-v0"),
      agentVersionId: environmentOr(
        "CREWON_AGENT_VERSION_ID",
        "default-agent-v1",
      ),
      policySnapshotId: environmentOr(
        "CREWON_POLICY_SNAPSHOT_ID",
        "standalone-policy-v0",
      ),
      workspaceBindingId:
        process.env.CREWON_WORKSPACE_BINDING_ID?.trim() || null,
    },
    transport,
    agentInstructions: process.env.CREWON_AGENT_INSTRUCTIONS?.trim() || null,
    toolRuntime,
    nativeWorkspaceReadCatalog: parseNativeWorkspaceReadCatalog(
      process.env.CREWON_NATIVE_WORKSPACE_READ_ENABLED,
    ),
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
  const connectionString = process.env.CREWON_CONTROL_DATABASE_URL?.trim();
  const activated = connectionString
    ? await activatePostgresRuntimeAgentVersionRelease({
        ...common,
        connectionString,
        ...(process.env.CREWON_CONTROL_DATABASE_SCHEMA?.trim()
          ? { schema: process.env.CREWON_CONTROL_DATABASE_SCHEMA.trim() }
          : {}),
      })
    : await activateStandaloneRuntimeAgentVersionRelease({
        ...common,
        databasePath: requiredEnvironment("CREWON_CONTROL_DB_PATH"),
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
