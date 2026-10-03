import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { inspect, isDeepStrictEqual } from "node:util";
import { parseCompiledAgentVersion } from "@crewon/agent-version";
import { parseRuntimeBindingConfig } from "@crewon/agent-version/runtime-bindings";
import {
  parsePluginPackageDescriptor,
  PLUGIN_PACKAGE_DESCRIPTOR_PATH,
  PLUGIN_PACKAGE_LIMITS,
  type InstalledPluginPeerCatalogEntry,
} from "@crewon/contracts/plugins";
import {
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  assertDesktopPluginBootstrapIssued,
  type DesktopPluginBootstrap,
  type DesktopPluginBootstrapManifest,
} from "./desktopPluginBootstrap.ts";
import type { ActiveProvider } from "./providerCredentials.ts";
import {
  assertDesktopInstalledPluginRuntimeConfiguration,
  captureDesktopInstalledPluginRuntimeArtifact,
  captureDesktopInstalledPluginRuntimeDirectory,
  captureDesktopInstalledPluginRuntimeDocument,
  desktopInstalledPluginAbsolutePath,
  desktopInstalledPluginExactKeys,
  desktopInstalledPluginInvalid as invalid,
  desktopInstalledPluginRecord as record,
  desktopInstalledPluginText as text,
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  DESKTOP_INSTALLED_PLUGIN_AUTHORITY_NAMES,
  desktopInstalledPluginAuthorityEndpoints,
  parseDesktopInstalledPluginWorkerAuthorities,
  type EnabledDesktopInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";

const EXECUTION_PATH = "CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH";
const authorityNames = DESKTOP_INSTALLED_PLUGIN_AUTHORITY_NAMES;
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
type Snapshot = Readonly<{ assertCurrent(): void }>;
export type DesktopInstalledPluginExpectedCatalogEntry = Pick<
  InstalledPluginPeerCatalogEntry,
  "identity" | "configuration" | "configuredTarget"
>;
export type DesktopInstalledPluginRuntime = Readonly<{
  release: Readonly<NodeJS.ProcessEnv>;
  worker: Readonly<NodeJS.ProcessEnv>;
  /** Original default Control only; no installed execution authority or peer credentials. */
  control: Readonly<NodeJS.ProcessEnv>;
  token: string;
  scope: PluginProfileScope;
  expectedCatalogEntries: readonly DesktopInstalledPluginExpectedCatalogEntry[];
  assertCurrent(): void;
  withdraw(): void;
  /** Called after all consuming children have physically stopped. Operator files are retained. */
  close(): Promise<void>;
}>;
export type DesktopInstalledPluginRuntimeInput = Readonly<{
  configuration: EnabledDesktopInstalledPluginRuntimeConfiguration;
  dataDirectory: string;
  bootstrap: DesktopPluginBootstrap;
  provider: ActiveProvider;
  sharedEnvironment: NodeJS.ProcessEnv;
  workerEnvironment: NodeJS.ProcessEnv;
  deadlineMs?: number;
  signal: AbortSignal;
}>;

/** Synchronous ownership capture before Main starts or awaits any consuming child. */
export function prepareDesktopInstalledPluginRuntime(
  input: DesktopInstalledPluginRuntimeInput,
): DesktopInstalledPluginRuntime {
  const {
    signal,
    dataDirectory,
    configuration,
    bootstrap,
    manifest,
    scope,
    shared,
    worker,
    provider,
  } = captureDesktopInstalledPluginRuntimeInputs(input);
  if (configuration.schemaVersion !== DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA)
    invalid("configuration_mode");
  const workerFile = captureDesktopInstalledPluginRuntimeDocument(
    configuration.workerConfigurationPath,
    128 * 1024,
  );
  const workerConfig = parseWorkerConfiguration(workerFile.value, manifest);
  const authorityTokens = captureDesktopInstalledPluginAuthorityTokens(
    workerConfig,
    shared,
    worker,
  );
  const releaseFile = captureDesktopInstalledPluginRuntimeDocument(
    workerConfig.releaseDocumentPath,
    1024 * 1024,
  );
  const snapshots: Snapshot[] = [workerFile, releaseFile];
  const expectedCatalogEntries = captureRelease(
    releaseFile.value,
    manifest,
    shared,
    configuration,
    authorityTokens,
    snapshots,
  );
  return createCapturedRuntime({
    input,
    signal,
    dataDirectory,
    configuration,
    bootstrap,
    manifest,
    scope,
    shared,
    worker,
    provider,
    authorityTokens,
    snapshots,
    expectedCatalogEntries,
  });
}

/** Internal Native input capture shared by v1 publication and v2 preparation; no file issuance. */
export function captureDesktopInstalledPluginRuntimeInputs(
  input: DesktopInstalledPluginRuntimeInput,
) {
  if (!(input.signal instanceof AbortSignal)) invalid("signal");
  const signal = input.signal;
  signal.throwIfAborted();
  const dataDirectory = desktopInstalledPluginAbsolutePath(input.dataDirectory);
  const configuration = input.configuration;
  assertDesktopInstalledPluginRuntimeConfiguration(
    configuration,
    dataDirectory,
  );
  const bootstrap = input.bootstrap;
  const manifest = assertDesktopPluginBootstrapIssued(bootstrap);
  const scope = manifest.scope;
  if (
    !isDeepStrictEqual(manifest.actor, DESKTOP_RUNTIME_OWNER) ||
    manifest.installRoot !== join(dataDirectory, "plugins") ||
    !isDeepStrictEqual(scope, bootstrap.scope)
  )
    invalid("bootstrap");
  const shared = copyEnvironment(input.sharedEnvironment);
  const worker = copyEnvironment(input.workerEnvironment);
  const provider = copyProvider(input.provider);
  assertNativeEnvironment(shared, dataDirectory, provider, configuration);
  assertNativeEnvironment(worker, dataDirectory, provider, configuration);
  return {
    signal,
    dataDirectory,
    configuration,
    bootstrap,
    manifest,
    scope,
    shared,
    worker,
    provider,
  };
}

function createCapturedRuntime(
  input: ReturnType<typeof captureDesktopInstalledPluginRuntimeInputs> &
    Readonly<{
      input: DesktopInstalledPluginRuntimeInput;
      authorityTokens: Record<string, string>;
      snapshots: readonly Snapshot[];
      expectedCatalogEntries: readonly DesktopInstalledPluginExpectedCatalogEntry[];
    }>,
): DesktopInstalledPluginRuntime {
  const {
    signal,
    dataDirectory,
    configuration,
    bootstrap,
    manifest,
    scope,
    shared,
    worker,
    provider,
    authorityTokens,
    snapshots,
    expectedCatalogEntries,
  } = input;
  if (configuration.schemaVersion !== DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA)
    invalid("configuration_mode");
  const deadlineMs = input.input.deadlineMs ?? 20_000;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1_000 ||
    deadlineMs > 30_000
  )
    invalid("deadline");
  let token = randomBytes(32).toString("hex");
  let releaseEnvironment: NodeJS.ProcessEnv | null = {
    ...withoutDesktopInstalledPluginEnvironment(shared),
    ...authorityTokens,
    [EXECUTION_PATH]: configuration.workerConfigurationPath,
  };
  let workerEnvironment: NodeJS.ProcessEnv | null = {
    ...withoutDesktopInstalledPluginEnvironment(worker),
    ...authorityTokens,
    [EXECUTION_PATH]: configuration.workerConfigurationPath,
    CREWON_INSTALLED_PLUGIN_PEER_PORT: "0",
    CREWON_INSTALLED_PLUGIN_PEER_TOKEN: token,
    CREWON_INSTALLED_PLUGIN_PEER_DEADLINE_MS: String(deadlineMs),
  };
  const controlEnvironment = withoutDesktopInstalledPluginEnvironment(shared);
  for (const name of Object.keys(authorityTokens))
    delete controlEnvironment[name];
  let control: NodeJS.ProcessEnv | null = controlEnvironment;
  let withdrawn = false;
  const assertCurrent = () => {
    if (withdrawn) invalid("withdrawn");
    signal.throwIfAborted();
    assertDesktopInstalledPluginRuntimeConfiguration(
      configuration,
      dataDirectory,
    );
    const current = assertDesktopPluginBootstrapIssued(bootstrap);
    if (current !== manifest) invalid("bootstrap_changed");
    if (!isDeepStrictEqual(copyProvider(input.input.provider), provider))
      invalid("provider_changed");
    for (const snapshot of snapshots) snapshot.assertCurrent();
    signal.throwIfAborted();
  };
  const withdraw = () => {
    withdrawn = true;
  };
  signal.addEventListener("abort", withdraw, { once: true });
  const result: DesktopInstalledPluginRuntime = {
    get release() {
      assertCurrent();
      return Object.freeze({ ...releaseEnvironment });
    },
    get worker() {
      assertCurrent();
      return Object.freeze({ ...workerEnvironment });
    },
    get control() {
      assertCurrent();
      return Object.freeze({ ...control });
    },
    get token() {
      assertCurrent();
      return token;
    },
    scope,
    expectedCatalogEntries,
    assertCurrent,
    withdraw,
    async close() {
      withdraw();
      signal.removeEventListener("abort", withdraw);
      token = "";
      releaseEnvironment = workerEnvironment = control = null;
      for (const name of Object.keys(authorityTokens)) {
        delete authorityTokens[name];
        delete shared[name];
        delete worker[name];
      }
    },
  };
  Object.defineProperties(result, {
    toJSON: { value: () => ({ scope, withdrawn, token: "[REDACTED]" }) },
    [inspect.custom]: { value: () => "[DesktopInstalledPluginRuntime]" },
  });
  try {
    assertCurrent();
    return Object.freeze(result);
  } catch (error) {
    withdraw();
    signal.removeEventListener("abort", withdraw);
    token = "";
    for (const name of Object.keys(authorityTokens))
      delete authorityTokens[name];
    throw error;
  }
}

type WorkerConfiguration = Readonly<{
  installRoot: string;
  releaseDocumentPath: string;
  authorities: readonly Readonly<{
    url: string;
    environmentVariable: string;
  }>[];
}>;
function parseWorkerConfiguration(
  input: unknown,
  manifest: DesktopPluginBootstrapManifest,
): WorkerConfiguration {
  const value = record(input);
  desktopInstalledPluginExactKeys(value, [
    "schemaVersion",
    "installRoot",
    "releaseDocumentPath",
    ...authorityNames,
    "historicalScope",
    "timeoutMs",
  ]);
  if (
    value.schemaVersion !== "crewon.installed-plugin-worker.v1" ||
    !Number.isSafeInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1 ||
    Number(value.timeoutMs) > 30_000 ||
    desktopInstalledPluginAbsolutePath(value.installRoot) !==
      manifest.installRoot
  )
    invalid("worker_configuration");
  if (
    value.historicalScope !== null &&
    !isDeepStrictEqual(
      parsePluginProfileScope(value.historicalScope),
      manifest.scope,
    )
  )
    invalid("scope");
  const authorities = desktopInstalledPluginAuthorityEndpoints(
    parseDesktopInstalledPluginWorkerAuthorities(
      Object.fromEntries(
        [...authorityNames, "timeoutMs"].map((name) => [name, value[name]]),
      ),
    ),
  );
  return Object.freeze({
    installRoot: manifest.installRoot,
    releaseDocumentPath: desktopInstalledPluginAbsolutePath(
      value.releaseDocumentPath,
    ),
    authorities: Object.freeze(authorities),
  });
}
export function captureDesktopInstalledPluginAuthorityTokens(
  config: Pick<WorkerConfiguration, "authorities">,
  shared: NodeJS.ProcessEnv,
  worker: NodeJS.ProcessEnv,
): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const { environmentVariable } of config.authorities) {
    const a = shared[environmentVariable],
      b = worker[environmentVariable];
    if (a !== undefined && b !== undefined && a !== b)
      invalid("authority_token_conflict");
    const token = a ?? b;
    if (typeof token !== "string" || !/^[\x21-\x7e]{32,8192}$/u.test(token))
      invalid("authority_token");
    tokens[environmentVariable] = token;
  }
  return tokens;
}

function captureRelease(
  input: unknown,
  bootstrap: DesktopPluginBootstrapManifest,
  environment: NodeJS.ProcessEnv,
  configuration: EnabledDesktopInstalledPluginRuntimeConfiguration,
  authorityTokens: Readonly<Record<string, string>>,
  snapshots: Snapshot[],
): readonly DesktopInstalledPluginExpectedCatalogEntry[] {
  const value = record(input);
  desktopInstalledPluginExactKeys(value, [
    "schemaVersion",
    "tenantId",
    "defaultAgentVersionId",
    "entries",
  ]);
  if (
    value.schemaVersion !== "crewon.installed-plugin-release.v1" ||
    value.tenantId !== bootstrap.scope.tenantId ||
    value.defaultAgentVersionId !== environment.CREWON_AGENT_VERSION_ID ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > 32
  )
    invalid("release");
  const versions = new Set<string>();
  const capturedPackages = new Set<string>();
  const entries = value.entries.map(
    (raw): DesktopInstalledPluginExpectedCatalogEntry => {
      const entry = record(raw);
      desktopInstalledPluginExactKeys(entry, [
        "scope",
        "packageIdentity",
        "configuration",
        "approvalRequirement",
        "modelSource",
        "version",
        "target",
      ]);
      if (
        !isDeepStrictEqual(
          parsePluginProfileScope(entry.scope),
          bootstrap.scope,
        ) ||
        (entry.approvalRequirement !== "none" &&
          entry.approvalRequirement !== "perAction")
      )
        invalid("release_scope");
      const identity = record(entry.packageIdentity);
      desktopInstalledPluginExactKeys(identity, [
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
      ]);
      const source = bootstrap.sources.find(
        (candidate) =>
          candidate.pluginId === identity.pluginId &&
          candidate.publisherId === identity.publisherId &&
          candidate.version === identity.version &&
          candidate.packageDigest === identity.packageDigest,
      );
      if (!source) invalid("release_package_unapproved");
      const config = parseExtensionConfiguration(entry.configuration, digester);
      if (
        config.tenantId !== bootstrap.scope.tenantId ||
        config.spaceId !== bootstrap.scope.spaceId ||
        config.pluginId !== source.pluginId ||
        config.pluginVersion !== source.version
      )
        invalid("release_configuration");
      const modelSource = record(entry.modelSource);
      desktopInstalledPluginExactKeys(modelSource, [
        "executionAuthority",
        "runtimeBinding",
        "version",
        "deployment",
      ]);
      const binding = parseRuntimeBindingConfig({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [modelSource.runtimeBinding],
      }).bindings[0]!;
      const base = parseCompiledAgentVersion(
        JSON.stringify(modelSource.version),
        digester,
      );
      const provider = configuration.providerBinding;
      if (
        modelSource.executionAuthority !== "crewonKernel" ||
        binding.provider.kind !== "directResponses" ||
        binding.toolRuntimeMode !== "independent" ||
        binding.extensionConfigPath !== undefined ||
        binding.mcpStdioConfigPath !== null ||
        binding.deviceToolConfigPath !== null ||
        binding.remoteMcpConfigPath !== null ||
        binding.workspaceBindingId !== null ||
        binding.tenantId !== bootstrap.scope.tenantId ||
        binding.agentVersionId !== base.agentVersionId ||
        binding.contentDigest !== base.contentDigest ||
        binding.agentVersionId === value.defaultAgentVersionId ||
        binding.provider.endpoint !== provider.responsesEndpoint ||
        base.model.modelId !== provider.modelId ||
        (binding.provider.apiKeyEnvironment !== null) !==
          provider.credentialRequired
      )
        invalid("model_source");
      const key = binding.provider.apiKeyEnvironment;
      if (
        key !== null &&
        (Object.hasOwn(authorityTokens, key) || key !== "CREWON_MODEL_API_KEY")
      )
        invalid("model_credential_reference");
      const deployment = record(modelSource.deployment);
      if (
        deployment.tenantId !== bootstrap.scope.tenantId ||
        deployment.agentVersionId !== base.agentVersionId ||
        deployment.contentDigest !== base.contentDigest ||
        deployment.authorityId !== binding.authorityId ||
        deployment.workspaceBindingId !== binding.workspaceBindingId
      )
        invalid("model_deployment");
      const version = parseCompiledAgentVersion(
        JSON.stringify(entry.version),
        digester,
      );
      const target = parseExtensionExecutionTarget(entry.target);
      if (
        versions.has(version.agentVersionId) ||
        version.agentVersionId === value.defaultAgentVersionId ||
        version.agentVersionId === base.agentVersionId ||
        version.model.modelId !== provider.modelId ||
        target.executionAuthority !== "crewonKernel" ||
        target.agentVersionId !== version.agentVersionId ||
        target.agentVersionContentDigest !== version.contentDigest ||
        target.runtimeGeneration !== version.runtimeGeneration ||
        target.policySnapshotId !== version.policySnapshotId
      )
        invalid("release_target");
      versions.add(version.agentVersionId);
      if (!capturedPackages.has(source.packageDigest)) {
        capturePackage(
          join(
            bootstrap.installRoot,
            "packages",
            source.packageDigest.slice(7),
          ),
          source,
          snapshots,
        );
        capturedPackages.add(source.packageDigest);
      }
      return Object.freeze({
        identity: Object.freeze({
          pluginId: source.pluginId,
          publisherId: source.publisherId,
          version: source.version,
          packageDigest: source.packageDigest,
          manifestDigest: config.manifestDigest,
          implementationDigest: config.implementationDigest,
        }),
        configuration:
          config as unknown as InstalledPluginPeerCatalogEntry["configuration"],
        configuredTarget:
          target as unknown as InstalledPluginPeerCatalogEntry["configuredTarget"],
      });
    },
  );
  return Object.freeze(entries);
}
function capturePackage(
  directory: string,
  identity: DesktopPluginBootstrapManifest["sources"][number],
  snapshots: Snapshot[],
): void {
  snapshots.push(captureDesktopInstalledPluginRuntimeDirectory(directory));
  const file = captureDesktopInstalledPluginRuntimeDocument(
    join(directory, PLUGIN_PACKAGE_DESCRIPTOR_PATH),
    PLUGIN_PACKAGE_LIMITS.descriptorBytes,
    "package",
  );
  const descriptor = parsePluginPackageDescriptor(file.value);
  if (
    descriptor.pluginId !== identity.pluginId ||
    descriptor.publisherId !== identity.publisherId ||
    descriptor.version !== identity.version
  )
    invalid("package_identity");
  snapshots.push(file);
  let total = 0;
  for (const artifact of descriptor.files) {
    total += artifact.byteLength;
    if (artifact.byteLength > 32 * 1024 * 1024 || total > 128 * 1024 * 1024)
      invalid("package_limit");
    snapshots.push(
      captureDesktopInstalledPluginRuntimeArtifact(
        join(directory, artifact.path),
        artifact.byteLength,
      ),
    );
  }
}
function assertNativeEnvironment(
  environment: NodeJS.ProcessEnv,
  dataDirectory: string,
  provider: ActiveProvider,
  configuration: EnabledDesktopInstalledPluginRuntimeConfiguration,
): void {
  if (
    Object.keys(environment).some(
      (name) =>
        environment[name] !== undefined &&
        (name.startsWith("CREWON_EXTENSIONS") ||
          name.startsWith("CREWON_EXTENSION_") ||
          (name.startsWith("CREWON_INSTALLED_PLUGIN_") &&
            !name.startsWith("CREWON_INSTALLED_PLUGIN_AUTHORITY_")) ||
          (name.startsWith("CREWON_NATIVE_") && name.includes("BOOTSTRAP"))),
    )
  )
    invalid("legacy_composition");
  if (
    environment.CREWON_CONTROL_DB_PATH !==
      join(dataDirectory, "control.sqlite") ||
    environment.CREWON_CONTROL_DATABASE_URL !== undefined ||
    environment.CREWON_CONTROL_DATABASE_SCHEMA !== undefined ||
    environment.CREWON_CONTROL_SECURITY_MODE !== "standalone" ||
    environment.CREWON_PRINCIPAL_ID !== DESKTOP_RUNTIME_OWNER.principalId ||
    environment.CREWON_ACTOR_ID !== DESKTOP_RUNTIME_OWNER.actorId ||
    environment.CREWON_TENANT_ID !== DESKTOP_RUNTIME_OWNER.tenantId ||
    environment.CREWON_SPACE_ID !== DESKTOP_RUNTIME_OWNER.spaceId ||
    !environment.CREWON_AGENT_VERSION_ID
  )
    invalid("native_environment");
  const expected = configuration.providerBinding;
  if (
    provider.providerId !== expected.providerId ||
    provider.endpoint !== expected.endpoint ||
    provider.modelId !== expected.modelId ||
    environment.CREWON_MODEL_ID !== expected.modelId ||
    environment.CREWON_RESPONSES_ENDPOINT !== expected.responsesEndpoint ||
    (environment.CREWON_MODEL_CREDENTIAL_REQUIRED !== "0") !==
      expected.credentialRequired ||
    (provider.apiKey !== null) !== expected.credentialRequired ||
    environment.CREWON_MODEL_API_KEY !== (provider.apiKey ?? "")
  )
    invalid("provider_binding");
}
function copyProvider(input: ActiveProvider): ActiveProvider {
  const value = record(input);
  desktopInstalledPluginExactKeys(value, [
    "providerId",
    "endpoint",
    "modelId",
    "apiKey",
  ]);
  const apiKey = value.apiKey;
  if (
    apiKey !== null &&
    (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,8192}$/u.test(apiKey))
  )
    invalid("provider_credential");
  return Object.freeze({
    providerId: text(value.providerId, 128),
    endpoint: text(value.endpoint, 2048),
    modelId: text(value.modelId, 256),
    apiKey,
  });
}
function copyEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const value = record(input);
  if (
    Object.values(value).some(
      (field) => field !== undefined && typeof field !== "string",
    )
  )
    invalid("environment");
  return value as NodeJS.ProcessEnv;
}
export function withoutDesktopInstalledPluginEnvironment(
  input: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...input };
  for (const name of Object.keys(result))
    if (name.startsWith("CREWON_INSTALLED_PLUGIN_")) delete result[name];
  return result;
}
