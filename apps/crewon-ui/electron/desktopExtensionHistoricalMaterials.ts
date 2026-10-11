import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseAgentVersionAsset,
  parseCompiledAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { ExtensionRecoveryManifest } from "@crewon/agent-version/extension-recovery";
import {
  parseRuntimeBootstrapInputs,
  type RuntimeBootstrapInputs,
} from "@crewon/contracts";
import { readSqliteExtensionRecoveryRelease } from "@crewon/store/extension-recovery";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
} from "@crewon/domain";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";

type Deployment = Readonly<{
  schemaVersion: "crewon.agent-version-deployment.v0";
  tenantId: string;
  agentVersionId: string;
  contentDigest: string;
  materializationDigest: string;
  authorityId: string;
  workspaceBindingId: null;
}>;
type Binding = Readonly<{
  tenantId: string;
  agentVersionId: string;
  contentDigest: string;
  authorityId: string;
  workspaceBindingId: null;
  provider: Readonly<{
    kind: "directResponses";
    endpoint: string;
    apiKeyEnvironment: "CREWON_MODEL_API_KEY" | null;
    storeResponses: boolean;
    requestProfile: "standard" | "responsesLite";
    idleTimeoutMs: number;
    sequencePolicy: "required" | "whenPresent";
  }>;
  mcpStdioConfigPath: null;
  deviceToolConfigPath: null;
  remoteMcpConfigPath: null;
  extensionConfigPath?: string;
  toolRuntimeMode?: "independent" | "shared";
}>;
const digester = { sha256: hash };

/** Parses pinned inputs and revalidates the entire published release through a read-only Store port. */
export function verifyDesktopExtensionHistoricalMaterials(input: {
  dataRoot: string;
  manifest: ExtensionRecoveryManifest;
  directory: string;
  documents: ReadonlyMap<string, unknown>;
}): Readonly<{
  inputs: RuntimeBootstrapInputs;
  bootstrapContentDigest: string;
}> {
  const inputs = verifyMaterials(
    input.manifest,
    input.directory,
    input.documents,
  );
  verifyPublishedMaterials(input.dataRoot, input.manifest, input.documents);
  return Object.freeze({
    inputs,
    bootstrapContentDigest: compiled(
      savedPlan(input.documents).bootstrapVersion,
    ).contentDigest,
  });
}

function verifyMaterials(
  manifest: ExtensionRecoveryManifest,
  directory: string,
  documents: ReadonlyMap<string, unknown>,
): RuntimeBootstrapInputs {
  const bootstrap = parseRuntimeBootstrapInputs(
    documents.get("bootstrap.json"),
  );
  if (
    new URL(bootstrap.model.endpoint).href !==
      manifest.providerBinding.responsesEndpoint ||
    bootstrap.model.credentialRequired !==
      manifest.providerBinding.credentialRequired
  )
    invalid();
  const plan = savedPlan(documents);
  const base = bindings(documents.get("base-bindings.json"), manifest, false);
  const plugins = bindings(
    documents.get("plugin-bindings.json"),
    manifest,
    true,
  );
  const assetFile = record(documents.get("plugin-assets.json"), [
    "schemaVersion",
    "assets",
  ]);
  if (assetFile.schemaVersion !== "crewon.extension-agent-version-assets.v0")
    invalid();
  const assets = array(assetFile.assets, 1, 32).map((asset) => {
    const parsed = record(asset, [
      "schemaVersion",
      "tenantId",
      "agentVersionId",
      "contentDigest",
      "createdAt",
      "definitionJson",
    ]);
    if (parsed.tenantId !== manifest.owner.tenantId) invalid();
    return parseAgentVersionAsset(
      parsed as Parameters<typeof parseAgentVersionAsset>[0],
      digester,
    );
  });
  if (
    plugins.length !== assets.length ||
    plugins.length !== manifest.targets.length ||
    new Set(assets.map((asset) => asset.agentVersionId)).size !== assets.length
  )
    invalid();
  const versions = array(plan.versions, 2, 256).map(compiled);
  const bootstrapVersion = compiled(plan.bootstrapVersion);
  const byId = new Map(
    versions.map((version) => [version.agentVersionId, version]),
  );
  if (
    byId.size !== versions.length ||
    !same(versions[0], bootstrapVersion) ||
    !same(byId.get(bootstrapVersion.agentVersionId), bootstrapVersion)
  )
    invalid();
  verifyBootstrapDefinition(bootstrap, bootstrapVersion);
  const baseDefinitions = expectedBaseDefinitions(bootstrap);
  if (
    base.length !== baseDefinitions.length ||
    versions.length !== baseDefinitions.length + assets.length
  )
    invalid();
  for (const definition of baseDefinitions) {
    const saved = byId.get(definition.agentVersionId);
    const binding = base.find(
      (value) => value.agentVersionId === definition.agentVersionId,
    );
    if (
      !saved ||
      !same(saved, {
        ...bootstrapVersion,
        agentVersionId: definition.agentVersionId,
        instructions: definition.instructions,
        model: { ...bootstrapVersion.model, modelId: definition.modelId },
        contentDigest: saved.contentDigest,
      }) ||
      !binding ||
      binding.contentDigest !== saved.contentDigest
    )
      invalid();
    if (
      binding.authorityId !== bootstrap.route.authorityId ||
      binding.provider.endpoint !== bootstrap.model.endpoint ||
      binding.provider.storeResponses !== false ||
      binding.provider.idleTimeoutMs !== bootstrap.model.idleTimeoutMs ||
      binding.provider.requestProfile !== bootstrap.model.requestProfile ||
      binding.provider.sequencePolicy !== bootstrap.model.sequencePolicy
    )
      invalid();
  }
  const deployments = array(plan.deployments, 2, 256).map(deployment);
  const deployed = new Map(
    deployments.map((value) => [value.agentVersionId, value]),
  );
  if (
    deployed.size !== versions.length ||
    deployments.length !== versions.length
  )
    invalid();
  for (const version of versions) {
    const candidate = deployed.get(version.agentVersionId);
    if (
      !candidate ||
      candidate.tenantId !== manifest.owner.tenantId ||
      candidate.contentDigest !== version.contentDigest
    )
      invalid();
  }
  const bootstrapDeployment = deployed.get(bootstrapVersion.agentVersionId)!;
  if (
    bootstrapDeployment.authorityId !== bootstrap.route.authorityId ||
    bootstrapDeployment.materializationDigest !==
      hash(
        JSON.stringify({
          schemaVersion: "crewon.static-agent-materialization.v0",
          authorityId: bootstrap.route.authorityId,
          workspaceBindingId: null,
          adapterName: bootstrapVersion.model.adapterName,
          adapterVersion: bootstrapVersion.model.adapterVersion,
          modelId: bootstrapVersion.model.modelId,
        }),
      )
  )
    invalid();
  for (const binding of base) {
    if (binding.agentVersionId === bootstrapVersion.agentVersionId) continue;
    const candidate = deployed.get(binding.agentVersionId)!;
    if (
      candidate.authorityId !== binding.authorityId ||
      candidate.materializationDigest !==
        hash(
          extensionCanonicalJson({
            schemaVersion: "crewon.agent-version-materialization.v0",
            binding,
            mcpStdioConfig: null,
            deviceToolConfig: null,
            remoteMcpConfig: null,
          }),
        )
    )
      invalid();
  }
  const registrations = new Set<string>();
  for (const [index, binding] of plugins.entries()) {
    const file = `snapshot-${String(index).padStart(2, "0")}.json`;
    if (binding.extensionConfigPath !== join(directory, file)) invalid();
    const snapshot = record(documents.get(file), [
      "schemaVersion",
      "configuration",
      "approvalRequirement",
    ]);
    if (
      snapshot.schemaVersion !== "crewon.extension-runtime-config.v0" ||
      (snapshot.approvalRequirement !== "none" &&
        snapshot.approvalRequirement !== "perAction")
    )
      invalid();
    const configuration = parseExtensionConfiguration(
      snapshot.configuration,
      digester,
    );
    if (
      configuration.tenantId !== manifest.owner.tenantId ||
      configuration.spaceId !== manifest.owner.spaceId ||
      configuration.credentialBindings.length !== 0
    )
      invalid();
    const registration = {
      pluginId: configuration.pluginId,
      pluginVersion: configuration.pluginVersion,
      manifestDigest: configuration.manifestDigest,
      implementationDigest: configuration.implementationDigest,
    };
    if (!manifest.registrations.some((value) => same(value, registration)))
      invalid();
    registrations.add(extensionCanonicalJson(registration));
    const asset = assets.find(
      (value) => value.agentVersionId === binding.agentVersionId,
    );
    const candidate = deployed.get(binding.agentVersionId);
    const target = manifest.targets.find(
      (value) => value.agentVersionId === binding.agentVersionId,
    );
    if (
      !asset ||
      !candidate ||
      !target ||
      !same(byId.get(binding.agentVersionId), asset) ||
      binding.contentDigest !== asset.contentDigest ||
      candidate.authorityId !== binding.authorityId ||
      !same(target, {
        executionAuthority: "crewonKernel",
        agentVersionId: asset.agentVersionId,
        agentVersionContentDigest: asset.contentDigest,
        materializationDigest: candidate.materializationDigest,
        authorityId: candidate.authorityId,
        runtimeGeneration: asset.runtimeGeneration,
        policySnapshotId: asset.policySnapshotId,
        workspaceBindingId: null,
      })
    )
      invalid();
  }
  const names = [...documents.keys()].sort();
  if (
    registrations.size !== manifest.registrations.length ||
    !same(
      names,
      [
        "bootstrap.json",
        "base-bindings.json",
        "plugin-assets.json",
        "plugin-bindings.json",
        "release.json",
        ...plugins.map(
          (_, index) => `snapshot-${String(index).padStart(2, "0")}.json`,
        ),
      ].sort(),
    )
  )
    invalid();
  const bundle = record(plan.bundle, [
    "schemaVersion",
    "tenantId",
    "releaseId",
    "manifestDigest",
    "defaultAgentVersionId",
    "deployments",
  ]);
  if (
    bundle.schemaVersion !== "crewon.agent-version-release-bundle.v0" ||
    bundle.tenantId !== manifest.owner.tenantId ||
    bundle.defaultAgentVersionId !== bootstrapVersion.agentVersionId ||
    bundle.releaseId !== manifest.releaseId ||
    bundle.manifestDigest !== manifest.releaseId ||
    !same(bundle.deployments, deployments)
  )
    invalid();
  const ordered = [...deployments].sort((left, right) =>
    left.agentVersionId < right.agentVersionId
      ? -1
      : left.agentVersionId > right.agentVersionId
        ? 1
        : 0,
  );
  if (
    !same(ordered, deployments) ||
    hash(
      JSON.stringify({
        schemaVersion: "crewon.agent-version-release-manifest.v0",
        tenantId: manifest.owner.tenantId,
        defaultAgentVersionId: bootstrapVersion.agentVersionId,
        deployments: ordered,
      }),
    ) !== manifest.releaseId
  )
    invalid();
  return bootstrap;
}

function savedPlan(documents: ReadonlyMap<string, unknown>) {
  const release = record(documents.get("release.json"), [
    "schemaVersion",
    "tenantId",
    "plan",
  ]);
  if (
    release.schemaVersion !== "crewon.extension-recovery-release.v0" ||
    release.tenantId !== DESKTOP_RUNTIME_OWNER.tenantId
  )
    invalid();
  return record(release.plan, [
    "bootstrapVersion",
    "versions",
    "deployments",
    "bundle",
  ]);
}
/** Includes base/profile/model assets that an older Worker's bootstrap-only asset check omits. */
function verifyPublishedMaterials(
  dataRoot: string,
  manifest: ExtensionRecoveryManifest,
  documents: ReadonlyMap<string, unknown>,
): void {
  const plan = savedPlan(documents);
  const versions = array(plan.versions, 2, 256).map(compiled);
  const stored = readSqliteExtensionRecoveryRelease({
    databasePath: join(dataRoot, "control.sqlite"),
    tenantId: manifest.owner.tenantId,
    releaseId: manifest.releaseId,
    agentVersionIds: versions.map((version) => version.agentVersionId),
  });
  if (
    stored.assets.length !== versions.length ||
    stored.deployments.length !== versions.length ||
    !same(stored.bundle, plan.bundle)
  )
    invalid();
  const assets = new Map(
    stored.assets.map((asset) => [
      asset.agentVersionId,
      parseAgentVersionAsset(asset, digester),
    ]),
  );
  if (
    assets.size !== versions.length ||
    versions.some(
      (version) => !same(assets.get(version.agentVersionId), version),
    )
  )
    invalid();
  const deployments = stored.deployments
    .map(({ deployedAt: _timestamp, ...candidate }) => deployment(candidate))
    .sort((left, right) =>
      left.agentVersionId < right.agentVersionId
        ? -1
        : left.agentVersionId > right.agentVersionId
          ? 1
          : 0,
    );
  if (!same(deployments, plan.deployments)) invalid();
}
function compiled(value: unknown): CompiledAgentVersion {
  const result = parseCompiledAgentVersion(JSON.stringify(value), digester);
  if (!same(value, result)) invalid();
  return result;
}
function verifyBootstrapDefinition(
  inputs: RuntimeBootstrapInputs,
  version: CompiledAgentVersion,
) {
  const model = inputs.model;
  const adapterVersion = `${model.websocket === null ? "1" : "2"}${model.requestProfile === "responsesLite" ? "+responses-lite" : ""}`;
  if (
    version.agentVersionId !== inputs.route.agentVersionId ||
    version.runtimeGeneration !== inputs.route.runtimeGeneration ||
    version.policySnapshotId !== inputs.route.policySnapshotId ||
    version.instructions !== inputs.agent.instructions ||
    !same(version.model, {
      adapterName: "direct-responses",
      adapterVersion,
      modelId: model.modelId,
      ...(model.maxOutputTokens === null
        ? {}
        : { maxOutputTokens: model.maxOutputTokens }),
      contextWindowTokens: inputs.agent.contextWindowTokens,
      autoCompactAtTokens: inputs.agent.autoCompactAtTokens,
    }) ||
    !same(version.execution, {
      streamMaxRetries: inputs.agent.streamMaxRetries,
      maxToolRounds: inputs.agent.maxToolRounds,
    }) ||
    !same(version.resources, {
      workspaceRequired: false,
      governedContextDigest: null,
    }) ||
    version.tools.length !== 0
  )
    invalid();
}
/** The fixed v0 IDs select saved definitions; the existing compiler validates their source digests. */
function expectedBaseDefinitions(inputs: RuntimeBootstrapInputs) {
  const originals = [
    {
      agentVersionId: inputs.route.agentVersionId,
      instructions: inputs.agent.instructions,
      modelId: inputs.model.modelId,
    },
    ...inputs.profiles.map((profile) => ({
      ...profile,
      modelId: inputs.model.modelId,
    })),
  ];
  const definitions = [...originals];
  for (const modelId of inputs.modelCatalog ?? [inputs.model.modelId]) {
    if (modelId === inputs.model.modelId) continue;
    for (const source of originals) {
      if (Buffer.byteLength(source.agentVersionId) > 480) continue;
      definitions.push({
        ...source,
        agentVersionId: `${source.agentVersionId}:model-${hash(modelId).slice(7, 31)}`,
        modelId,
      });
    }
  }
  return definitions;
}
function bindings(
  input: unknown,
  manifest: ExtensionRecoveryManifest,
  plugin: boolean,
): readonly Binding[] {
  const value = record(input, ["schemaVersion", "bindings"]);
  if (value.schemaVersion !== "crewon.agent-version-runtime-bindings.v0")
    invalid();
  const results = array(value.bindings, 1, plugin ? 32 : 256).map((entry) => {
    const optional =
      entry !== null && typeof entry === "object"
        ? ["toolRuntimeMode", "extensionConfigPath"].filter((key) =>
            Object.hasOwn(entry, key),
          )
        : [];
    const binding = record(entry, [
      "tenantId",
      "agentVersionId",
      "contentDigest",
      "authorityId",
      "workspaceBindingId",
      "provider",
      "mcpStdioConfigPath",
      "deviceToolConfigPath",
      "remoteMcpConfigPath",
      ...optional,
    ]);
    const provider = record(binding.provider, [
      "kind",
      "endpoint",
      "apiKeyEnvironment",
      "storeResponses",
      "requestProfile",
      "idleTimeoutMs",
      "sequencePolicy",
    ]);
    if (
      binding.tenantId !== manifest.owner.tenantId ||
      binding.workspaceBindingId !== null ||
      binding.mcpStdioConfigPath !== null ||
      binding.deviceToolConfigPath !== null ||
      binding.remoteMcpConfigPath !== null ||
      (binding.toolRuntimeMode !== undefined &&
        binding.toolRuntimeMode !== "shared" &&
        binding.toolRuntimeMode !== "independent") ||
      (plugin
        ? typeof binding.extensionConfigPath !== "string" ||
          binding.toolRuntimeMode === "shared"
        : binding.extensionConfigPath !== undefined) ||
      provider.kind !== "directResponses" ||
      typeof provider.endpoint !== "string" ||
      new URL(provider.endpoint).href !==
        manifest.providerBinding.responsesEndpoint ||
      provider.apiKeyEnvironment !==
        (manifest.providerBinding.credentialRequired
          ? "CREWON_MODEL_API_KEY"
          : null) ||
      typeof provider.storeResponses !== "boolean" ||
      (provider.requestProfile !== "standard" &&
        provider.requestProfile !== "responsesLite") ||
      (provider.sequencePolicy !== "required" &&
        provider.sequencePolicy !== "whenPresent") ||
      !Number.isSafeInteger(provider.idleTimeoutMs) ||
      Number(provider.idleTimeoutMs) < 1 ||
      Number(provider.idleTimeoutMs) > 300_000
    )
      invalid();
    identifier(binding.agentVersionId, 512);
    identifier(binding.authorityId, 512);
    digest(binding.contentDigest);
    return binding as unknown as Binding;
  });
  if (
    new Set(results.map((binding) => binding.agentVersionId)).size !==
    results.length
  )
    invalid();
  return results;
}
function deployment(input: unknown): Deployment {
  const value = record(input, [
    "schemaVersion",
    "tenantId",
    "agentVersionId",
    "contentDigest",
    "materializationDigest",
    "authorityId",
    "workspaceBindingId",
  ]);
  if (
    value.schemaVersion !== "crewon.agent-version-deployment.v0" ||
    value.workspaceBindingId !== null
  )
    invalid();
  for (const key of ["tenantId", "agentVersionId", "authorityId"] as const)
    identifier(value[key], key === "tenantId" ? 256 : 512);
  digest(value.contentDigest);
  digest(value.materializationDigest);
  // This order is the existing release manifest protocol's digest input.
  return {
    schemaVersion: value.schemaVersion,
    tenantId: value.tenantId as string,
    agentVersionId: value.agentVersionId as string,
    contentDigest: value.contentDigest as string,
    materializationDigest: value.materializationDigest as string,
    authorityId: value.authorityId as string,
    workspaceBindingId: null,
  };
}
function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.getOwnPropertySymbols(input).length !== 0
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some(
      (value) => !("value" in value) || !value.enumerable,
    )
  )
    invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function array(input: unknown, min: number, max: number): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    input.length < min ||
    input.length > max ||
    Object.keys(input).length !== input.length
  )
    invalid();
  return input;
}
function digest(input: unknown): void {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input))
    invalid();
}
function identifier(input: unknown, max: number): void {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.trim() !== input ||
    Buffer.byteLength(input) > max ||
    /[\u0000-\u001f\u007f]/u.test(input)
  )
    invalid();
}
function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
function invalid(): never {
  throw new Error("desktop_extension_historical_inputs_invalid");
}
