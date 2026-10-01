import { v7 as uuidv7 } from "uuid";
import { writeFileSync } from "node:fs";

import {
  activatePostgresRuntimeAgentVersionRelease,
  activateStandaloneRuntimeAgentVersionRelease,
} from "./agent-version-release-composition.ts";
import { compileRuntimeAgentVersion } from "./agent-version-release.ts";
import {
  compileDevelopmentAgentProfileVersion,
  developmentAgentRuntimeBindings,
  parseDevelopmentAgentProfiles,
} from "./development-agent-profiles.ts";
import {
  modelVariantAgentVersionId,
  runtimeModelCatalog,
} from "./runtime-model-catalog.ts";
import {
  agentVersionDeploymentCandidates,
  loadAgentVersionDeployments,
} from "./runtime-binding-config.ts";
import {
  createConfiguredToolRuntime,
  createModelTransport,
  environmentOr,
  parseNativeWorkspaceReadCatalog,
  requiredEnvironment,
  responsesCompatibilityProfile,
} from "./runtime-process-environment.ts";
import { SystemApplicationClock } from "./standalone-adapters.ts";
import {
  loadRuntimeReleaseActor,
  RuntimeReleaseAuthorization,
} from "./release-authority.ts";
import {
  loadExtensionReleaseInput,
  mergeExtensionReleaseInput,
} from "./extensions/extension-release-input.ts";
import { retainInstalledExtensionBuild } from "./extensions/retain-installed-extension-build.ts";
import {
  resolveRuntimeBootstrapAgent,
  resolveRuntimeBootstrapRoute,
} from "./runtime-bootstrap-defaults.ts";
import {
  parseExtensionRecoveryReleaseRequest,
  prepareExtensionRecoveryRelease,
  finishExtensionRecoveryRelease,
} from "./extension-recovery-release.ts";
import { resolveResponsesRuntimeConfiguration } from "./responses-runtime-configuration.ts";

const environment = Object.freeze({ ...process.env });
const recoveryRequest = parseExtensionRecoveryReleaseRequest(environment);
const actor = loadRuntimeReleaseActor();
const bindingsPath =
  environment.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH?.trim();
const route = resolveRuntimeBootstrapRoute(environment);
const bootstrapAgent = resolveRuntimeBootstrapAgent(environment);
const originalExtensionRelease = loadExtensionReleaseInput({
  environment,
  tenantId: actor.tenantId,
  defaultAgentVersionId: route.agentVersionId,
});
const retainedBuild =
  recoveryRequest !== null &&
  !new URL(import.meta.url).pathname.endsWith("/runtime-release.mjs")
    ? undefined
    : await retainInstalledExtensionBuild({
        environment,
        entrypointUrl: import.meta.url,
      });
const recoveryPreparation = await prepareExtensionRecoveryRelease({
  request: recoveryRequest,
  extension: originalExtensionRelease,
  retainedBuild,
  releaseActor: actor,
  defaultAgentVersionId: route.agentVersionId,
});
const extensionRelease =
  recoveryPreparation !== null
    ? recoveryPreparation.extension
    : originalExtensionRelease;
const transport = createModelTransport(
  environmentOr("CREWON_MODEL_ADAPTER", "responses", environment),
  {},
  environment,
);
const toolRuntime = await createConfiguredToolRuntime(environment);

try {
  const common = {
    actor,
    authorization: new RuntimeReleaseAuthorization(actor),
    clock: new SystemApplicationClock(),
    activationId:
      environment.CREWON_AGENT_VERSION_ACTIVATION_ID?.trim() || uuidv7(),
    runtimeTenantId: actor.tenantId,
    route,
    transport,
    agentInstructions: bootstrapAgent.instructions,
    toolRuntime,
    nativeWorkspaceReadCatalog: parseNativeWorkspaceReadCatalog(
      environment.CREWON_NATIVE_WORKSPACE_READ_ENABLED,
    ),
    streamMaxRetries: bootstrapAgent.streamMaxRetries,
    maxToolRounds: bootstrapAgent.maxToolRounds,
    autoCompactAtTokens: bootstrapAgent.autoCompactAtTokens,
    modelContextWindowTokens: bootstrapAgent.contextWindowTokens,
    expectedAgentVersionDigest:
      environment.CREWON_AGENT_VERSION_CONTENT_DIGEST?.trim() || null,
  };
  const profiles = parseDevelopmentAgentProfiles(
    environment.CREWON_DEV_AGENT_PROFILES_JSON,
  );
  const bootstrapVersion = compileRuntimeAgentVersion(common);
  const profileAgentVersions = profiles.map((profile) =>
    compileDevelopmentAgentProfileVersion(common, profile),
  );
  const modelIds = runtimeModelCatalog(
    environment.CREWON_MODEL_CATALOG_JSON,
    transport.modelId,
  );
  const modelVariantSources = [
    {
      agentVersionId: route.agentVersionId,
      instructions: common.agentInstructions,
    },
    ...profiles.flatMap((profile) =>
      profile.cloudAgent === undefined
        ? [
            {
              agentVersionId: profile.agentVersionId,
              instructions: profile.instructions,
            },
          ]
        : [],
    ),
  ];
  const modelAgentVersions = modelIds.flatMap((modelId) =>
    modelId === transport.modelId
      ? []
      : modelVariantSources.flatMap((source) => {
          const agentVersionId = modelVariantAgentVersionId(
            source.agentVersionId,
            modelId,
          );
          return agentVersionId === null
            ? []
            : [
                compileRuntimeAgentVersion({
                  ...common,
                  route: { ...route, agentVersionId },
                  agentInstructions: source.instructions,
                  modelId,
                }),
              ];
        }),
  );
  const additionalAgentVersions = [
    ...profileAgentVersions,
    ...modelAgentVersions,
  ];
  const ownsBindingsManifest =
    environment.CREWON_MODEL_CATALOG_JSON !== undefined;
  let generatedBindings:
    | ReturnType<typeof developmentAgentRuntimeBindings>
    | undefined;
  if (profiles.length > 0 || ownsBindingsManifest) {
    if (bindingsPath === undefined) {
      throw new Error("CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH_required");
    }
    const endpoint = environmentOr(
      "CREWON_RESPONSES_ENDPOINT",
      "https://api.openai.com/v1/responses",
      environment,
    );
    const compatibility = responsesCompatibilityProfile(
      environment.CREWON_PROVIDER_ID,
      endpoint,
    );
    const requestProfile = compatibility?.requestProfile ?? "standard";
    const sequencePolicy = compatibility?.sequencePolicy ?? "required";
    generatedBindings = developmentAgentRuntimeBindings({
      versions: [bootstrapVersion, ...additionalAgentVersions],
      profiles: [
        undefined,
        ...profiles,
        ...modelAgentVersions.map(() => undefined),
      ],
      tenantId: actor.tenantId,
      authorityId: route.authorityId,
      workspaceBindingId: route.workspaceBindingId,
      endpoint,
      requestProfile,
      sequencePolicy,
      idleTimeoutMs:
        resolveResponsesRuntimeConfiguration(environment).config.idleTimeoutMs,
      mcpStdioConfigPath: ownsBindingsManifest
        ? null
        : environment.CREWON_MCP_STDIO_CONFIG_PATH?.trim() || null,
      ...(ownsBindingsManifest
        ? {
            directApiKeyEnvironment:
              environment.CREWON_MODEL_CREDENTIAL_REQUIRED === "0"
                ? null
                : "CREWON_MODEL_API_KEY",
          }
        : {}),
      ...(ownsBindingsManifest ? { toolRuntimeMode: "shared" } : {}),
    });
  }
  const loadedDeployments =
    generatedBindings === undefined
      ? bindingsPath
        ? loadAgentVersionDeployments(bindingsPath)
        : undefined
      : agentVersionDeploymentCandidates(generatedBindings);
  if (
    extensionRelease !== null &&
    loadedDeployments?.some(
      (deployment) => deployment.tenantId !== actor.tenantId,
    )
  )
    throw new Error("runtime_deployment_tenant_mismatch");
  const configuredDeployments = loadedDeployments?.filter(
    (deployment) =>
      deployment.tenantId === actor.tenantId &&
      deployment.agentVersionId !== route.agentVersionId,
  );
  const checkedRelease =
    extensionRelease === null
      ? undefined
      : mergeExtensionReleaseInput({
          extension: extensionRelease,
          existingVersions: additionalAgentVersions,
          existingDeployments: configuredDeployments ?? [],
          tenantId: actor.tenantId,
          defaultAgentVersionId: route.agentVersionId,
        });
  const releaseVersions =
    checkedRelease?.additionalAgentVersions ?? additionalAgentVersions;
  const releaseDeployments =
    checkedRelease?.agentVersionDeployments ?? configuredDeployments;
  if (generatedBindings !== undefined)
    writeFileSync(bindingsPath!, JSON.stringify(generatedBindings), {
      encoding: "utf8",
      mode: 0o600,
    });
  const release = {
    ...common,
    ...(releaseVersions.length === 0
      ? {}
      : { additionalAgentVersions: releaseVersions }),
    ...(releaseDeployments === undefined
      ? {}
      : { agentVersionDeployments: releaseDeployments }),
  };
  const connectionString = environment.CREWON_CONTROL_DATABASE_URL?.trim();
  const activated = connectionString
    ? await activatePostgresRuntimeAgentVersionRelease({
        ...release,
        connectionString,
        ...(environment.CREWON_CONTROL_DATABASE_SCHEMA?.trim()
          ? { schema: environment.CREWON_CONTROL_DATABASE_SCHEMA.trim() }
          : {}),
      })
    : await activateStandaloneRuntimeAgentVersionRelease({
        ...release,
        databasePath: requiredEnvironment(
          "CREWON_CONTROL_DB_PATH",
          environment,
        ),
      });
  await finishExtensionRecoveryRelease({
    preparation: recoveryPreparation,
    plan: activated.plan,
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
