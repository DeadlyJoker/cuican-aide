import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileAgentVersion } from "@crewon/agent-version";
import { createExtensionConfiguration } from "@crewon/domain";
import { desktopPluginBootstrapFixture } from "./desktopPluginBootstrap.test-support.ts";
import { prepareDesktopPluginBootstrap } from "./desktopPluginBootstrap.ts";
import {
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE,
  DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  loadDesktopInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { prepareDesktopInstalledPluginRuntime } from "./desktopInstalledPluginRuntime.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export async function desktopInstalledPluginRuntimeFixture() {
  const f = desktopPluginBootstrapFixture();
  f.writeApproval();
  const bootstrap = (await prepareDesktopPluginBootstrap(f.input))!;
  const provider = {
    providerId: "native-provider",
    endpoint: "https://model.example/v1",
    modelId: "native-model",
    apiKey: "native-model-key-canary",
  };
  const workerPath = join(f.dataDirectory, "installed-worker.json");
  const releasePath = join(f.dataDirectory, "installed-release.json");
  const configurationPath = join(
    f.dataDirectory,
    DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE,
  );
  const configuration = {
    schemaVersion: DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
    enabled: true,
    workerConfigurationPath: workerPath,
    providerBinding: {
      providerId: provider.providerId,
      endpoint: provider.endpoint,
      responsesEndpoint: `${provider.endpoint}/responses`,
      modelId: provider.modelId,
      credentialRequired: true,
    },
  };
  const source = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "native-installed-source",
      runtimeGeneration: "source-generation",
      policySnapshotId: "native-policy",
      instructions: null,
      model: {
        adapterName: "responses",
        adapterVersion: "1",
        modelId: provider.modelId,
        contextWindowTokens: 64_000,
        autoCompactAtTokens: null,
      },
      execution: { streamMaxRetries: 0, maxToolRounds: 2 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
  const version = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "native-installed-derived",
      runtimeGeneration: "derived-generation",
      policySnapshotId: "derived-policy",
      instructions: source.instructions,
      model: source.model,
      execution: source.execution,
      resources: source.resources,
      tools: source.tools,
    },
    digester,
  );
  const saved = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: f.input.actor.tenantId,
      spaceId: f.input.actor.spaceId,
      pluginId: f.source.pluginId,
      revision: 1,
      pluginVersion: f.source.version,
      manifestDigest: digester.sha256("manifest"),
      implementationDigest: digester.sha256("implementation"),
      parameters: {},
      credentialBindings: [],
      createdByActorId: f.input.actor.actorId,
      createdAt: "2026-10-03T00:00:00.000Z",
    },
    digester,
  );
  const release = {
    schemaVersion: "crewon.installed-plugin-release.v1",
    tenantId: f.input.actor.tenantId,
    defaultAgentVersionId: "original-native-default",
    entries: [
      {
        scope: bootstrap.scope,
        packageIdentity: {
          pluginId: f.source.pluginId,
          publisherId: f.source.publisherId,
          version: f.source.version,
          packageDigest: f.source.packageDigest,
        },
        configuration: saved,
        approvalRequirement: "none",
        modelSource: {
          executionAuthority: "crewonKernel",
          runtimeBinding: {
            tenantId: f.input.actor.tenantId,
            agentVersionId: source.agentVersionId,
            contentDigest: source.contentDigest,
            authorityId: "standalone-authority",
            workspaceBindingId: null,
            provider: {
              kind: "directResponses",
              endpoint: `${provider.endpoint}/responses`,
              apiKeyEnvironment: "CREWON_MODEL_API_KEY",
              storeResponses: false,
              requestProfile: "standard",
              idleTimeoutMs: 20_000,
              sequencePolicy: "required",
            },
            mcpStdioConfigPath: null,
            deviceToolConfigPath: null,
            remoteMcpConfigPath: null,
            toolRuntimeMode: "independent",
          },
          version: source,
          deployment: {
            schemaVersion: "crewon.agent-version-deployment.v0",
            tenantId: f.input.actor.tenantId,
            agentVersionId: source.agentVersionId,
            contentDigest: source.contentDigest,
            materializationDigest: digester.sha256("source-materialization"),
            authorityId: "standalone-authority",
            workspaceBindingId: null,
          },
        },
        version,
        target: {
          executionAuthority: "crewonKernel",
          agentVersionId: version.agentVersionId,
          agentVersionContentDigest: version.contentDigest,
          materializationDigest: digester.sha256("derived-materialization"),
          authorityId: "standalone-authority",
          runtimeGeneration: version.runtimeGeneration,
          policySnapshotId: version.policySnapshotId,
          workspaceBindingId: null,
        },
      },
    ],
  };
  const authority = {
    url: "https://authority.example/check",
    serviceTokenEnvironmentVariable: "NATIVE_INSTALLED_AUTHORITY_TOKEN",
  };
  const workerConfiguration = {
    schemaVersion: "crewon.installed-plugin-worker.v1",
    installRoot: join(f.dataDirectory, "plugins"),
    releaseDocumentPath: releasePath,
    actorAuthority: authority,
    policyAuthority: authority,
    profileAuthority: authority,
    packageAuthority: authority,
    networkAuthority: null,
    historicalScope: null,
    timeoutMs: 2_000,
  };
  const installedDirectory = join(
    workerConfiguration.installRoot,
    "packages",
    f.source.packageDigest.slice(7),
  );
  mkdirSync(installedDirectory, { recursive: true, mode: 0o700 });
  const nodeBytes =
    "globalThis.__nativePluginMustNotImport = true; throw new Error('execution grant required');";
  const descriptor = {
    schemaVersion: "crewon.plugin-package.v1",
    hostApi: "crewon.plugin-host.v1",
    pluginId: f.source.pluginId,
    version: f.source.version,
    title: "Boundary fixture",
    description: "Private operator input boundary fixture",
    publisherId: f.source.publisherId,
    entrypoints: { node: "node.mjs", ui: null },
    businessManifestPath: null,
    requires: [
      { service: "crewon.execution", apiVersion: "1", optional: false },
    ],
    provides: [],
    contributions: [],
    files: [
      {
        path: "node.mjs",
        byteLength: Buffer.byteLength(nodeBytes),
        sha256: digester.sha256(nodeBytes).slice(7),
      },
    ],
  };
  writeFileSync(
    join(installedDirectory, "crewon.plugin.json"),
    JSON.stringify(descriptor),
    { mode: 0o600 },
  );
  writeFileSync(join(installedDirectory, "node.mjs"), nodeBytes, {
    mode: 0o600,
  });
  const sharedEnvironment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CREWON_CONTROL_DB_PATH: join(f.dataDirectory, "control.sqlite"),
    CREWON_CONTROL_SECURITY_MODE: "standalone",
    CREWON_CONTROL_SESSION_TOKEN: "native-control-secret-canary",
    CREWON_CONTROL_CSRF_TOKEN: "native-control-csrf-canary",
    CREWON_PRINCIPAL_ID: f.input.actor.principalId,
    CREWON_ACTOR_ID: f.input.actor.actorId,
    CREWON_TENANT_ID: f.input.actor.tenantId,
    CREWON_SPACE_ID: f.input.actor.spaceId,
    CREWON_AGENT_VERSION_ID: release.defaultAgentVersionId,
    CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: join(
      f.dataDirectory,
      "original-bindings.json",
    ),
    CREWON_MODEL_ID: provider.modelId,
    CREWON_MODEL_API_KEY: provider.apiKey,
    CREWON_RESPONSES_ENDPOINT: `${provider.endpoint}/responses`,
    NATIVE_INSTALLED_AUTHORITY_TOKEN: "native-authority-secret-canary-".repeat(
      2,
    ),
  };
  function writeInputs() {
    writeFileSync(workerPath, JSON.stringify(workerConfiguration), {
      mode: 0o600,
    });
    writeFileSync(releasePath, JSON.stringify(release), { mode: 0o600 });
    writeFileSync(configurationPath, JSON.stringify(configuration), {
      mode: 0o600,
    });
  }
  writeInputs();
  const controller = new AbortController();
  const input = {
    dataDirectory: f.dataDirectory,
    bootstrap,
    provider,
    sharedEnvironment,
    workerEnvironment: { ...sharedEnvironment },
    signal: controller.signal,
  };
  function prepare() {
    const config = loadDesktopInstalledPluginRuntimeConfiguration(
      f.dataDirectory,
    );
    if (!config.enabled) throw new Error("fixture configuration disabled");
    return prepareDesktopInstalledPluginRuntime({
      ...input,
      configuration: config,
    });
  }
  return {
    ...f,
    bootstrap,
    provider,
    workerPath,
    releasePath,
    configurationPath,
    configuration,
    workerConfiguration,
    release,
    installedDirectory,
    controller,
    input,
    writeInputs,
    prepare,
  };
}
