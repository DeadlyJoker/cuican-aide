import { v7 as uuidv7 } from "uuid";
import { writeFileSync } from "node:fs";

import {
  activatePostgresRuntimeAgentVersionRelease,
  activateStandaloneRuntimeAgentVersionRelease,
} from "./agent-version-release-composition.ts";
import { compileRuntimeAgentVersion } from "./agent-version-release.ts";
import {
  developmentAgentRuntimeBindings,
  parseDevelopmentAgentProfiles,
} from "./development-agent-profiles.ts";
import {
  modelVariantAgentVersionId,
  runtimeModelCatalog,
} from "./runtime-model-catalog.ts";
import { loadAgentVersionDeployments } from "./runtime-binding-config.ts";
import {
  createConfiguredToolRuntime,
  createModelTransport,
  environmentOr,
  parseNativeWorkspaceReadCatalog,
  parseNonNegativeInteger,
  parsePositiveInteger,
  requiredEnvironment,
  responsesCompatibilityProfile,
} from "./runtime-process-environment.ts";
import { SystemApplicationClock } from "./standalone-adapters.ts";
import {
  loadRuntimeReleaseActor,
  RuntimeReleaseAuthorization,
} from "./release-authority.ts";

const actor = loadRuntimeReleaseActor();
const bindingsPath =
  process.env.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH?.trim();
const transport = createModelTransport(
  environmentOr("CREWON_MODEL_ADAPTER", "responses"),
);
const toolRuntime = await createConfiguredToolRuntime();

try {
  const route = {
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
  };
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
  };
  const profiles = parseDevelopmentAgentProfiles(
    process.env.CREWON_DEV_AGENT_PROFILES_JSON,
  );
  const bootstrapVersion = compileRuntimeAgentVersion(common);
  const profileAgentVersions = profiles.map((profile) =>
    compileRuntimeAgentVersion({
      ...common,
      route: { ...route, agentVersionId: profile.agentVersionId },
      agentInstructions: profile.instructions,
    }),
  );
  const modelAgentVersions = runtimeModelCatalog(
    process.env.CREWON_MODEL_CATALOG_JSON,
    transport.modelId,
  ).flatMap((modelId) => {
    if (modelId === transport.modelId) return [];
    const agentVersionId = modelVariantAgentVersionId(
      route.agentVersionId,
      modelId,
    );
    return agentVersionId === null
      ? []
      : [
          compileRuntimeAgentVersion({
            ...common,
            route: { ...route, agentVersionId },
            modelId,
          }),
        ];
  });
  const additionalAgentVersions = [
    ...profileAgentVersions,
    ...modelAgentVersions,
  ];
  const ownsBindingsManifest =
    process.env.CREWON_MODEL_CATALOG_JSON !== undefined;
  if (profiles.length > 0 || ownsBindingsManifest) {
    if (bindingsPath === undefined) {
      throw new Error("CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH_required");
    }
    const endpoint = environmentOr(
      "CREWON_RESPONSES_ENDPOINT",
      "https://api.openai.com/v1/responses",
    );
    const compatibility = responsesCompatibilityProfile(
      process.env.CREWON_PROVIDER_ID,
      endpoint,
    );
    const requestProfile = compatibility?.requestProfile ?? "standard";
    const sequencePolicy = compatibility?.sequencePolicy ?? "required";
    writeFileSync(
      bindingsPath,
      JSON.stringify(
        developmentAgentRuntimeBindings({
          versions: [bootstrapVersion, ...additionalAgentVersions],
          tenantId: actor.tenantId,
          authorityId: route.authorityId,
          workspaceBindingId: route.workspaceBindingId,
          endpoint,
          requestProfile,
          sequencePolicy,
          idleTimeoutMs: parsePositiveInteger(
            process.env.CREWON_RESPONSES_IDLE_TIMEOUT_MS ?? "60000",
            "CREWON_RESPONSES_IDLE_TIMEOUT_MS_invalid",
          ),
          mcpStdioConfigPath: ownsBindingsManifest
            ? null
            : process.env.CREWON_MCP_STDIO_CONFIG_PATH?.trim() || null,
          ...(ownsBindingsManifest
            ? {
                apiKeyEnvironment:
                  process.env.CREWON_MODEL_CREDENTIAL_REQUIRED === "0"
                    ? null
                    : "CREWON_MODEL_API_KEY",
              }
            : {}),
          ...(ownsBindingsManifest ? { toolRuntimeMode: "shared" } : {}),
        }),
      ),
      { encoding: "utf8", mode: 0o600 },
    );
  }
  const configuredDeployments = bindingsPath
    ? loadAgentVersionDeployments(bindingsPath).filter(
        (deployment) =>
          deployment.tenantId === actor.tenantId &&
          deployment.agentVersionId !== route.agentVersionId,
      )
    : undefined;
  const release = {
    ...common,
    ...(additionalAgentVersions.length === 0
      ? {}
      : { additionalAgentVersions }),
    ...(configuredDeployments === undefined
      ? {}
      : { agentVersionDeployments: configuredDeployments }),
  };
  const connectionString = process.env.CREWON_CONTROL_DATABASE_URL?.trim();
  const activated = connectionString
    ? await activatePostgresRuntimeAgentVersionRelease({
        ...release,
        connectionString,
        ...(process.env.CREWON_CONTROL_DATABASE_SCHEMA?.trim()
          ? { schema: process.env.CREWON_CONTROL_DATABASE_SCHEMA.trim() }
          : {}),
      })
    : await activateStandaloneRuntimeAgentVersionRelease({
        ...release,
        databasePath: requiredEnvironment("CREWON_CONTROL_DB_PATH"),
      });
  process.stdout.write(
    `${JSON.stringify({
      disposition: activated.activation.disposition,
      tenantId: actor.tenantId,
      releaseId: activated.plan.bundle.releaseId,
      activationId: release.activationId,
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
