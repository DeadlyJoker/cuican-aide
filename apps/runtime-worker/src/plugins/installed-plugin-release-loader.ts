import { isDeepStrictEqual } from "node:util";
import { isAbsolute, resolve } from "node:path";
import {
  parseAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { AgentVersionDeploymentCandidate } from "@crewon/application";
import {
  parseInstalledPluginPackage,
  type PluginProfileScope,
} from "@crewon/domain";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { RemoteMcpCompositionDependencies } from "../remote-mcp-composition.ts";
import { createAgentVersionRuntimeBindings } from "../runtime-binding-config.ts";
import {
  createInstalledPluginAgentVersionRuntimeFactory,
  installedPluginAgentRuntimeTarget,
  type InstalledPluginAgentRuntimeEntry,
} from "./installed-plugin-agent-runtime-factory.ts";
import {
  loadInstalledPluginBusinessRegistration,
  revalidateInstalledPluginBusinessRegistration,
  type InstalledPluginBusinessRegistration,
} from "./installed-plugin-business-registration.ts";
import { compileInstalledPluginAgentVersion } from "./installed-plugin-agent-version.ts";
import {
  installedPluginReleaseDigester as digester,
  installedPluginReleaseFailure as fail,
  parseInstalledPluginReleaseDeployment,
  parseInstalledPluginReleaseDocument,
  type InstalledPluginReleaseDocument,
  type InstalledPluginReleaseEntry,
  type InstalledPluginReleaseIdentity,
} from "./installed-plugin-release-document.ts";
import {
  composeInstalledPluginReleaseFactories,
  guardInstalledPluginReleaseFactory,
  type InstalledPluginReleaseRuntimeFactory,
} from "./installed-plugin-release-factory.ts";
import type { AgentVersionRuntimeFactoryPort } from "../durable-agent-version-runtime-loader.ts";
import type { ConfiguredAgentVersionRuntimeFactory } from "../configured-agent-version-runtime-factory.ts";
import { InstalledPluginReleaseLifetime } from "./installed-plugin-release-lifetime.ts";

export type InstalledPluginReleaseReadRequest = Readonly<{
  identity: InstalledPluginReleaseIdentity;
  scope: PluginProfileScope;
  purpose: "read";
}>;
export type InstalledPluginReleaseLoadInput = Readonly<{
  document: InstalledPluginReleaseDocument;
  installRoot: string;
  authorizeRead(
    input: InstalledPluginReleaseReadRequest,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
  environment: Readonly<Record<string, string | undefined>>;
  remoteMcpDependencies?: RemoteMcpCompositionDependencies;
  nativeProviderApiKey?: string | null;
  signal?: AbortSignal;
}>;
export type LoadedInstalledPluginRelease = Readonly<{
  document: InstalledPluginReleaseDocument;
  factory: ConfiguredAgentVersionRuntimeFactory;
  versions: readonly CompiledAgentVersion[];
  deployments: readonly AgentVersionDeploymentCandidate[];
  registrations: readonly InstalledPluginBusinessRegistration[];
  /** Synchronously withdraws new factory work and joins every actual metadata/creation Promise. */
  close(): Promise<void>;
}>;
type ParentStore = SqliteRunStore | PostgresDomainStore;
type LoadedState = {
  store: ParentStore | null;
  verificationStore: ParentStore | null;
  entries: readonly InstalledPluginReleaseEntry[];
  registrations: readonly InstalledPluginBusinessRegistration[];
  lifetime: InstalledPluginReleaseLifetime;
};
const loaded = new WeakMap<LoadedInstalledPluginRelease, LoadedState>();

/** Real installed metadata + existing model/tool materializers. Loading allocates no provider or Node runtime. */
export async function loadInstalledPluginRelease(
  input: InstalledPluginReleaseLoadInput,
): Promise<LoadedInstalledPluginRelease> {
  const document = parseInstalledPluginReleaseDocument(input.document);
  if (
    typeof input.installRoot !== "string" ||
    !isAbsolute(input.installRoot) ||
    input.installRoot.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(input.installRoot) ||
    typeof input.authorizeRead !== "function"
  )
    fail("configuration_invalid");
  const installRoot = resolve(input.installRoot);
  const authorizeRead = input.authorizeRead.bind(input);
  const environment = Object.freeze({ ...input.environment });
  const remoteMcpDependencies = input.remoteMcpDependencies;
  const nativeProviderApiKey = input.nativeProviderApiKey;
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const registrations: InstalledPluginBusinessRegistration[] = [];
  const entries: InstalledPluginAgentRuntimeEntry[] = [];
  for (const expected of document.entries) {
    signal.throwIfAborted();
    const registration = await loadInstalledPluginBusinessRegistration({
      installRoot,
      expectedPluginId: expected.packageIdentity.pluginId,
      expectedPublisherId: expected.packageIdentity.publisherId,
      expectedVersion: expected.packageIdentity.version,
      expectedPackageDigest: expected.packageIdentity.packageDigest,
      authorizeRead: (candidate, signal) =>
        authorizeRead(
          Object.freeze({
            identity: Object.freeze({
              pluginId: candidate.descriptor.pluginId,
              publisherId: candidate.descriptor.publisherId,
              version: candidate.descriptor.version,
              packageDigest: candidate.packageDigest,
            }),
            scope: expected.scope,
            purpose: "read",
          }),
          signal,
        ),
      signal,
    });
    signal.throwIfAborted();
    const binding = createAgentVersionRuntimeBindings({
      config: {
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [expected.modelSource.runtimeBinding],
      },
      environment,
      ...(remoteMcpDependencies === undefined ? {} : { remoteMcpDependencies }),
      ...(nativeProviderApiKey === undefined ? {} : { nativeProviderApiKey }),
    })[0]!;
    const actualBaseDeployment: AgentVersionDeploymentCandidate = {
      schemaVersion: "crewon.agent-version-deployment.v0",
      tenantId: binding.tenantId,
      agentVersionId: binding.agentVersionId,
      contentDigest: binding.contentDigest,
      materializationDigest: binding.materializationDigest,
      authorityId: binding.authorityId,
      workspaceBindingId: binding.workspaceBindingId,
    };
    if (
      binding.executionAuthority !== "crewonKernel" ||
      !isDeepStrictEqual(actualBaseDeployment, expected.modelSource.deployment)
    )
      fail("model_source_mismatch");
    if (
      expected.modelSource.version.resources.governedContextDigest !== null &&
      binding.createGovernedContext === undefined
    )
      fail("governed_context_unavailable");
    const version = compileInstalledPluginAgentVersion({
      base: {
        executionAuthority: "crewonKernel",
        version: expected.modelSource.version,
      },
      registration,
      agentVersionId: expected.version.agentVersionId,
      runtimeGeneration: expected.version.runtimeGeneration,
      policySnapshotId: expected.version.policySnapshotId,
      digester,
    });
    if (!isDeepStrictEqual(version, expected.version)) fail("version_mismatch");
    const entry: InstalledPluginAgentRuntimeEntry = Object.freeze({
      scope: expected.scope,
      registration,
      configuration: expected.configuration,
      approvalRequirement: expected.approvalRequirement,
      base: {
        executionAuthority: "crewonKernel" as const,
        version: expected.modelSource.version,
        deployment: actualBaseDeployment,
      },
      version,
      authorityId: expected.target.authorityId,
      workspaceBindingId: expected.target.workspaceBindingId,
      ...(binding.transportOwnership === undefined
        ? {}
        : { transportOwnership: binding.transportOwnership }),
      createTransport: binding.createTransport.bind(binding),
      createBaseToolRuntime: binding.createToolRuntime.bind(binding),
      ...(binding.createGovernedContext === undefined
        ? {}
        : {
            createGovernedContext: binding.createGovernedContext.bind(binding),
          }),
    });
    const target = installedPluginAgentRuntimeTarget({
      defaultAgentVersionId: document.defaultAgentVersionId,
      entry,
    });
    if (!isDeepStrictEqual(target, expected.target)) fail("target_mismatch");
    registrations.push(registration);
    entries.push(entry);
  }
  const state: LoadedState = {
    store: null,
    verificationStore: null,
    entries: document.entries,
    registrations: Object.freeze(registrations),
    lifetime: new InstalledPluginReleaseLifetime(),
  };
  const actualFactory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: document.defaultAgentVersionId,
    entries,
  });
  const factory = guardInstalledPluginReleaseFactory({
    factory: actualFactory,
    lifetime: state.lifetime,
    verifyCreation: async (input, signal) => {
      const index = state.entries.findIndex(
        (entry) =>
          entry.version.agentVersionId === input.version.agentVersionId,
      );
      if (state.store === null) fail("publication_unverified");
      if (
        index < 0 ||
        input.tenantId !== document.tenantId ||
        !isDeepStrictEqual(input.version, state.entries[index]!.version)
      )
        fail("factory_version_mismatch");
      await verifyEntry(
        state.store,
        state.entries[index]!,
        state.registrations[index]!,
        signal,
      );
    },
  });
  const release: LoadedInstalledPluginRelease = Object.freeze({
    document,
    factory,
    versions: Object.freeze(entries.map((entry) => entry.version)),
    deployments: Object.freeze(
      factory
        .deploymentBindings(document.tenantId)
        .map((value) => Object.freeze(value)),
    ),
    registrations: state.registrations,
    close: () => state.lifetime.close(),
  });
  loaded.set(release, state);
  signal.throwIfAborted();
  return release;
}

export function assertLoadedInstalledPluginRelease(
  input: unknown,
): asserts input is LoadedInstalledPluginRelease {
  if (
    !input ||
    typeof input !== "object" ||
    !loaded.has(input as LoadedInstalledPluginRelease)
  )
    fail("unverified_document");
}

/** Called after migrations on the actual composition parent, before runtime registration/allocation. Never publishes. */
export async function verifyInstalledPluginRelease(
  input: Readonly<{
    release: LoadedInstalledPluginRelease;
    store: ParentStore;
    signal?: AbortSignal;
  }>,
): Promise<void> {
  return verifyLoadedRelease(input, "published");
}

/** Publication preflight checks installed inputs without granting a factory permission to allocate. */
export async function verifyInstalledPluginReleaseInputs(
  input: Readonly<{
    release: LoadedInstalledPluginRelease;
    store: ParentStore;
    signal?: AbortSignal;
  }>,
): Promise<void> {
  return verifyLoadedRelease(input, "inputs");
}

async function verifyLoadedRelease(
  input: Readonly<{
    release: LoadedInstalledPluginRelease;
    store: ParentStore;
    signal?: AbortSignal;
  }>,
  mode: "inputs" | "published",
): Promise<void> {
  const release = input.release,
    store = input.store;
  assertLoadedInstalledPluginRelease(release);
  if (
    !(store instanceof SqliteRunStore) &&
    !(store instanceof PostgresDomainStore)
  )
    fail("store_invalid");
  const state = loaded.get(release)!;
  if (state.verificationStore !== null && state.verificationStore !== store)
    fail("store_owner_mismatch");
  state.verificationStore = store;
  const suppliedSignal = input.signal;
  await state.lifetime.run(async (lifetimeSignal) => {
    const signal =
      suppliedSignal === undefined
        ? lifetimeSignal
        : AbortSignal.any([suppliedSignal, lifetimeSignal]);
    for (let index = 0; index < state.entries.length; index++) {
      signal.throwIfAborted();
      await (mode === "published" ? verifyEntry : verifyEntryInputs)(
        store,
        state.entries[index]!,
        state.registrations[index]!,
        signal,
      );
    }
    state.lifetime.assertLive();
    signal.throwIfAborted();
    if (mode === "published") state.store = store;
  });
}

async function verifyEntry(
  store: ParentStore,
  entry: InstalledPluginReleaseEntry,
  registration: InstalledPluginBusinessRegistration,
  signal: AbortSignal,
): Promise<void> {
  for (const version of [entry.modelSource.version, entry.version]) {
    const asset = await store.loadAgentVersion({
      tenantId: entry.scope.tenantId,
      agentVersionId: version.agentVersionId,
    });
    signal.throwIfAborted();
    if (asset === null) fail("asset_missing");
    if (
      asset.tenantId !== entry.scope.tenantId ||
      asset.agentVersionId !== version.agentVersionId ||
      !isDeepStrictEqual(parseAgentVersionAsset(asset, digester), version)
    )
      fail("asset_mismatch");
  }
  const derived: AgentVersionDeploymentCandidate = {
    schemaVersion: "crewon.agent-version-deployment.v0",
    tenantId: entry.scope.tenantId,
    agentVersionId: entry.version.agentVersionId,
    contentDigest: entry.version.contentDigest,
    materializationDigest: entry.target.materializationDigest,
    authorityId: entry.target.authorityId,
    workspaceBindingId: entry.target.workspaceBindingId,
  };
  for (const expected of [entry.modelSource.deployment, derived]) {
    const actual = await store.loadAgentVersionDeployment({
      tenantId: expected.tenantId,
      agentVersionId: expected.agentVersionId,
    });
    signal.throwIfAborted();
    if (actual === null) fail("deployment_missing");
    const { deployedAt, ...candidate } = actual;
    if (
      typeof deployedAt !== "string" ||
      !Number.isFinite(Date.parse(deployedAt)) ||
      !isDeepStrictEqual(
        parseInstalledPluginReleaseDeployment(candidate),
        expected,
      )
    )
      fail("deployment_mismatch");
  }
  await verifyEntryInputs(store, entry, registration, signal);
}

async function verifyEntryInputs(
  store: ParentStore,
  entry: InstalledPluginReleaseEntry,
  registration: InstalledPluginBusinessRegistration,
  signal: AbortSignal,
): Promise<void> {
  const configuration = await store
    .extensionStore()
    .loadExtensionConfiguration({
      tenantId: entry.scope.tenantId,
      spaceId: entry.scope.spaceId,
      pluginId: entry.packageIdentity.pluginId,
      revision: entry.configuration.revision,
    });
  signal.throwIfAborted();
  if (
    configuration === null ||
    !isDeepStrictEqual(configuration, entry.configuration)
  )
    fail("configuration_mismatch");
  const installed = await store.pluginInstallationStore().loadPackage({
    scope: entry.scope,
    packageDigest: entry.packageIdentity.packageDigest,
  });
  signal.throwIfAborted();
  if (installed === null) fail("package_missing");
  const actualPackage = parseInstalledPluginPackage(installed);
  for (const [field, value] of Object.entries({
    ...entry.scope,
    ...entry.packageIdentity,
  }))
    if (actualPackage[field as keyof typeof actualPackage] !== value)
      fail("package_mismatch");
  await revalidateInstalledPluginBusinessRegistration(registration, signal);
  signal.throwIfAborted();
}

export function composeInstalledPluginReleaseRuntimeFactory(
  input: Readonly<{
    release: LoadedInstalledPluginRelease;
    base?: Readonly<{
      factory: AgentVersionRuntimeFactoryPort;
      deployments: readonly AgentVersionDeploymentCandidate[];
    }>;
  }>,
): InstalledPluginReleaseRuntimeFactory {
  assertLoadedInstalledPluginRelease(input.release);
  return composeInstalledPluginReleaseFactories({
    installed: {
      factory: input.release.factory,
      deployments: input.release.deployments,
    },
    ...(input.base === undefined ? {} : { base: input.base }),
  });
}
