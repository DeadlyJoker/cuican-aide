import {
  compileAgentVersion,
  parseCompiledAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type {
  ExtensionConfiguration,
  PluginProfileScope,
} from "@crewon/domain";
import { advertisedRuntimeModelCatalog } from "../runtime-model-catalog.ts";
import { resolveResponsesRuntimeConfiguration } from "../responses-runtime-configuration.ts";
import { resolveRuntimeBootstrapRoute } from "../runtime-bootstrap-defaults.ts";
import {
  agentVersionDeploymentCandidates,
  createAgentVersionRuntimeBindings,
  parseRuntimeBindingConfig,
} from "../runtime-binding-config.ts";
import { installedPluginAgentRuntimeTarget } from "./installed-plugin-agent-runtime-factory.ts";
import { compileInstalledPluginAgentVersion } from "./installed-plugin-agent-version.ts";
import type { InstalledPluginBusinessRegistration } from "./installed-plugin-business-registration.ts";
import {
  installedPluginReleaseDigester as digester,
  type InstalledPluginReleaseEntry,
} from "./installed-plugin-release-document.ts";
import { nativePreparationFailure as fail } from "./installed-plugin-native-preparation-files.ts";
import { nativePreparationCanonicalJson } from "./installed-plugin-native-preparation-json.ts";

/** Validate the shared model/default inputs even when every requested plugin is blocked. */
export function assertNativeInstalledPluginModelPreparation(
  input: Readonly<{
    bootstrapVersion: CompiledAgentVersion;
    defaultAgentVersionId: string;
    environment: Readonly<Record<string, string | undefined>>;
  }>,
): void {
  resolveModelPreparation(
    input.bootstrapVersion,
    input.defaultAgentVersionId,
    input.environment,
  );
}

function resolveModelPreparation(
  bootstrap: CompiledAgentVersion,
  defaultAgentVersionId: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const resolved = resolveResponsesRuntimeConfiguration(environment),
    route = resolveRuntimeBootstrapRoute(environment);
  const credential = environment.CREWON_MODEL_CREDENTIAL_REQUIRED;
  if (
    (environment.CREWON_MODEL_ADAPTER !== undefined &&
      environment.CREWON_MODEL_ADAPTER !== "responses") ||
    (credential !== undefined && credential !== "0" && credential !== "1") ||
    route.agentVersionId !== defaultAgentVersionId ||
    bootstrap.agentVersionId !== defaultAgentVersionId ||
    bootstrap.model.modelId !== resolved.config.model ||
    bootstrap.model.adapterName !== "direct-responses" ||
    bootstrap.model.maxOutputTokens !== resolved.config.maxOutputTokens
  )
    fail("model_mismatch");
  return { resolved, route, credential };
}

/** Pure compilation and real materializer descriptions; no transport, tool runtime or plugin is created. */
export function compileNativeInstalledPluginReleaseEntry(
  input: Readonly<{
    bootstrapVersion: CompiledAgentVersion;
    defaultAgentVersionId: string;
    environment: Readonly<Record<string, string | undefined>>;
    scope: PluginProfileScope;
    registration: InstalledPluginBusinessRegistration;
    configuration: ExtensionConfiguration;
    approvalRequirement: "none" | "perAction";
    /** Host-discovered model only; never an arbitrary transport override. */
    modelId?: string;
  }>,
): InstalledPluginReleaseEntry {
  const bootstrap = parseCompiledAgentVersion(
    nativePreparationCanonicalJson(input.bootstrapVersion),
    digester,
  );
  const { resolved, route, credential } = resolveModelPreparation(
    bootstrap,
    input.defaultAgentVersionId,
    input.environment,
  );
  const modelId = input.modelId ?? bootstrap.model.modelId;
  if (
    input.modelId !== undefined &&
    !nativeInstalledPluginModelCatalog(
      input.environment,
      bootstrap.model.modelId,
    ).includes(modelId)
  )
    fail("model_not_advertised");
  const provider = Object.freeze({
    kind: "directResponses" as const,
    endpoint: resolved.config.endpoint,
    apiKeyEnvironment: credential === "0" ? null : "CREWON_MODEL_API_KEY",
    storeResponses: resolved.config.storeResponses,
    requestProfile: resolved.config.requestProfile,
    idleTimeoutMs: resolved.config.idleTimeoutMs,
    sequencePolicy: resolved.config.sequencePolicy,
  });
  const base = {
    instructions: bootstrap.instructions,
    model: { ...bootstrap.model, modelId },
    execution: bootstrap.execution,
    resources: { workspaceRequired: false, governedContextDigest: null },
    tools: [],
  };
  const sourceSeed = digester
    .sha256(
      nativePreparationCanonicalJson({
        schemaVersion: "crewon.native-installed-plugin-model-source.v1",
        tenantId: input.scope.tenantId,
        base,
        authorityId: route.authorityId,
        workspaceBindingId: null,
        provider,
        mcpStdioConfigPath: null,
        deviceToolConfigPath: null,
        remoteMcpConfigPath: null,
        toolRuntimeMode: "independent",
      }),
    )
    .slice("sha256:".length);
  const source = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: `native-plugin-source-${sourceSeed}`,
      runtimeGeneration: `native-plugin-source-runtime-${sourceSeed}`,
      policySnapshotId: `native-plugin-source-policy-${sourceSeed}`,
      ...base,
    },
    digester,
  );
  const bindings = parseRuntimeBindingConfig({
    schemaVersion: "crewon.agent-version-runtime-bindings.v0",
    bindings: [
      {
        tenantId: input.scope.tenantId,
        agentVersionId: source.agentVersionId,
        contentDigest: source.contentDigest,
        authorityId: route.authorityId,
        workspaceBindingId: null,
        provider,
        mcpStdioConfigPath: null,
        deviceToolConfigPath: null,
        remoteMcpConfigPath: null,
        toolRuntimeMode: "independent",
      },
    ],
  });
  const deployment = agentVersionDeploymentCandidates(bindings)[0]!;
  const materializer = createAgentVersionRuntimeBindings({
    config: bindings,
    environment: input.environment,
  })[0]!;
  const seed = digester
    .sha256(
      nativePreparationCanonicalJson({
        schemaVersion: "crewon.native-installed-plugin-derived-agent.v1",
        scope: input.scope,
        identity: input.registration.identity,
        configuration: input.configuration,
        approvalRequirement: input.approvalRequirement,
        modelSource: {
          version: source,
          binding: bindings.bindings[0]!,
          deployment,
        },
      }),
    )
    .slice("sha256:".length);
  const version = compileInstalledPluginAgentVersion({
    base: { executionAuthority: "crewonKernel", version: source },
    registration: input.registration,
    agentVersionId: `native-plugin-agent-${seed}`,
    runtimeGeneration: `native-plugin-runtime-${seed}`,
    policySnapshotId: `native-plugin-policy-${seed}`,
    digester,
  });
  const target = installedPluginAgentRuntimeTarget({
    defaultAgentVersionId: input.defaultAgentVersionId,
    entry: {
      scope: input.scope,
      registration: input.registration,
      configuration: input.configuration,
      approvalRequirement: input.approvalRequirement,
      base: { executionAuthority: "crewonKernel", version: source, deployment },
      version,
      authorityId: route.authorityId,
      workspaceBindingId: null,
      transportOwnership: "request",
      createTransport: materializer.createTransport.bind(materializer),
      createBaseToolRuntime: materializer.createToolRuntime.bind(materializer),
    },
  });
  return Object.freeze({
    scope: input.scope,
    packageIdentity: input.registration.identity,
    configuration: input.configuration,
    approvalRequirement: input.approvalRequirement,
    modelSource: {
      executionAuthority: "crewonKernel" as const,
      runtimeBinding: bindings.bindings[0]!,
      version: source,
      deployment,
    },
    version,
    target,
  });
}

/** Bounded model siblings of one installed package, each with a real immutable model source/deployment. */
export function compileNativeInstalledPluginModelVariants(
  input: Omit<
    Parameters<typeof compileNativeInstalledPluginReleaseEntry>[0],
    "modelId"
  >,
): readonly InstalledPluginReleaseEntry[] {
  const models = nativeInstalledPluginModelCatalog(
    input.environment,
    input.bootstrapVersion.model.modelId,
  );
  if (models.length === 0) fail("model_catalog_empty");
  return Object.freeze(
    models.map((modelId) =>
      compileNativeInstalledPluginReleaseEntry({ ...input, modelId }),
    ),
  );
}

function nativeInstalledPluginModelCatalog(
  environment: Readonly<Record<string, string | undefined>>,
  defaultModelId: string,
): readonly string[] {
  const input = environment.CREWON_MODEL_CATALOG_JSON;
  if (input === undefined) return [defaultModelId];
  let models: readonly string[];
  try {
    models = advertisedRuntimeModelCatalog(input);
  } catch {
    return fail("model_catalog_invalid");
  }
  // Catalog order is not identity. Preserve the default first only when it remains advertised.
  return Object.freeze(
    [...models].sort((a, b) =>
      a === b
        ? 0
        : a === defaultModelId
          ? -1
          : b === defaultModelId
            ? 1
            : a < b
              ? -1
              : a > b
                ? 1
                : 0,
    ),
  );
}
