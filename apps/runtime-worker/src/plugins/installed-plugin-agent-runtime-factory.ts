import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  parseCompiledAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type {
  AgentVersionDeploymentCandidate,
  ExtensionRegistration,
} from "@crewon/application";
import type { GovernedContextBundle } from "@crewon/context";
import {
  extensionCanonicalJson,
  extensionDigest,
  extensionOpaqueId,
  parsePluginProfileScope,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  CompositeToolRuntime,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolExecutionResolution,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  ConfiguredAgentVersionRuntimeFactory,
  type AgentVersionRuntimeBinding,
} from "../configured-agent-version-runtime-factory.ts";
import type { AgentVersionRuntime } from "../agent-version-runtime.ts";
import type { AgentVersionRuntimeFactoryPort } from "../durable-agent-version-runtime-loader.ts";
import type { FailedRuntimeCreationCleanup } from "../agent-runtime-capacity.ts";
import { scopeToolRuntimeToAgentVersion } from "../agent-version-tool-runtime.ts";
import {
  registerRuntimeExtensionMaterializations,
  readRuntimeExtensionMaterializations,
} from "../extensions/extension-runtime-proof.ts";
import { extensionToolDefinitions } from "../extensions/extension-tool-catalog.ts";
import {
  RuntimeCreationCleanup,
  type RuntimeCreationOptions,
} from "../runtime-creation-cleanup.ts";
import { compileInstalledPluginAgentVersion } from "./installed-plugin-agent-version.ts";
import {
  assertInstalledPluginBusinessRegistration,
  revalidateInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
  type InstalledPluginBusinessRegistration,
} from "./installed-plugin-business-registration.ts";
import { registerInstalledPluginAgentRuntimeScope } from "./installed-plugin-agent-runtime-factory-proof.ts";

export { readInstalledPluginAgentRuntimeScope } from "./installed-plugin-agent-runtime-factory-proof.ts";

export type InstalledPluginAgentRuntimeFailureOwner = Readonly<{
  /** Only proven physical cleanup can release the failed creation's reservation. */
  close(): Promise<void>;
}>;
const failureOwners = new WeakMap<
  object,
  Readonly<{
    runtime: AgentVersionRuntime;
    owner: InstalledPluginAgentRuntimeFailureOwner;
  }>
>();

/** Matching error text or copied runtime DTOs never establish failed resource ownership. */
export function installedPluginAgentRuntimeFailureOwner(
  error: unknown,
): InstalledPluginAgentRuntimeFailureOwner | null {
  return error !== null && typeof error === "object"
    ? (failureOwners.get(error)?.owner ?? null)
    : null;
}

type CreationInput = Parameters<
  ConfiguredAgentVersionRuntimeFactory["create"]
>[0];

/** Explicit host materializers; returned transports and tools transfer their resource ownership. */
export type InstalledPluginAgentRuntimeEntry = Readonly<{
  scope: PluginProfileScope;
  registration: InstalledPluginBusinessRegistration;
  configuration: ExtensionConfiguration;
  approvalRequirement: "none" | "perAction";
  base: Readonly<{
    executionAuthority: "crewonKernel";
    version: CompiledAgentVersion;
    /** The real, immutable base deployment; callbacks alone do not establish this digest. */
    deployment: AgentVersionDeploymentCandidate;
  }>;
  version: CompiledAgentVersion;
  authorityId: string;
  workspaceBindingId: string | null;
  transportOwnership?: "runtime" | "request";
  createTransport(
    version: CompiledAgentVersion,
    options?: RuntimeCreationOptions,
  ): ModelTransportPort | Promise<ModelTransportPort>;
  createBaseToolRuntime(
    baseVersion: CompiledAgentVersion,
    options?: RuntimeCreationOptions,
  ): ToolRuntimePort | Promise<ToolRuntimePort>;
  createGovernedContext?(
    version: CompiledAgentVersion,
  ):
    | GovernedContextBundle
    | undefined
    | Promise<GovernedContextBundle | undefined>;
}>;

type Prepared = Readonly<{
  scope: PluginProfileScope;
  registration: InstalledPluginBusinessRegistration;
  proofRegistration: ExtensionRegistration;
  configuration: ExtensionConfiguration;
  approvalRequirement: "none" | "perAction";
  baseVersion: CompiledAgentVersion;
  version: CompiledAgentVersion;
  target: ExtensionExecutionTarget;
  definitions: readonly ToolDefinition[];
  createTransport: InstalledPluginAgentRuntimeEntry["createTransport"];
  createBaseToolRuntime: InstalledPluginAgentRuntimeEntry["createBaseToolRuntime"];
  createGovernedContext?: InstalledPluginAgentRuntimeEntry["createGovernedContext"];
  transportOwnership?: InstalledPluginAgentRuntimeEntry["transportOwnership"];
}>;
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

/** Adds independent deployment bindings. It never registers or changes a default Agent. */
export function createInstalledPluginAgentVersionRuntimeFactory(input: {
  defaultAgentVersionId: string;
  entries: readonly InstalledPluginAgentRuntimeEntry[];
}): ConfiguredAgentVersionRuntimeFactory {
  extensionOpaqueId(input.defaultAgentVersionId);
  if (
    !Array.isArray(input.entries) ||
    input.entries.length < 1 ||
    input.entries.length > 32
  )
    fail("installed_plugin_agent_runtime_entries_invalid");
  const prepared = input.entries.map((entry) =>
    prepare(input.defaultAgentVersionId, entry),
  );
  return new InstalledFactory(prepared);
}

/** The same deterministic target used by readiness, deployment and runtime construction. */
export function installedPluginAgentRuntimeTarget(input: {
  defaultAgentVersionId: string;
  entry: InstalledPluginAgentRuntimeEntry;
}): ExtensionExecutionTarget {
  return prepare(input.defaultAgentVersionId, input.entry).target;
}

class InstalledFactory extends ConfiguredAgentVersionRuntimeFactory {
  readonly #entries: ReadonlyMap<string, Prepared>;

  constructor(entries: readonly Prepared[]) {
    super(entries.map(binding));
    this.#entries = new Map(
      entries.map((entry) => [
        key(entry.scope.tenantId, entry.version.agentVersionId),
        entry,
      ]),
    );
  }

  override async create(
    input: Parameters<ConfiguredAgentVersionRuntimeFactory["create"]>[0],
  ): Promise<AgentVersionRuntime> {
    return this.#createAttested(input, (captured) => super.create(captured));
  }

  override bindSharedToolRuntime(
    runtime: ToolRuntimePort,
  ): AgentVersionRuntimeFactoryPort {
    const factory = super.bindSharedToolRuntime(runtime);
    return {
      ...factory,
      create: (input) =>
        this.#createAttested(input, (captured) => factory.create(captured)),
    };
  }

  async #createAttested(
    input: CreationInput,
    create: (
      captured: CreationInput,
    ) => AgentVersionRuntime | Promise<AgentVersionRuntime>,
  ): Promise<AgentVersionRuntime> {
    const captured = captureCreation(input);
    const entry = this.#entries.get(
      key(captured.tenantId, captured.version.agentVersionId),
    );
    const runtime = await create(captured);
    try {
      return this.#attest(runtime, captured.tenantId);
    } catch (error) {
      const method = Object.getOwnPropertyDescriptor(runtime, "close");
      const close =
        method !== undefined &&
        "value" in method &&
        typeof method.value === "function"
          ? (method.value.bind(runtime) as () => Promise<void>)
          : async () =>
              fail("installed_plugin_agent_runtime_cleanup_unavailable");
      const cleanup = async () => {
        await close();
        // The underlying factory treats governed-context allocation as unknown:
        // its bundle has no close contract. Closing tools/transport cannot prove
        // that a callback's external resources ended after attestation failed.
        if (entry === undefined || entry.createGovernedContext !== undefined)
          fail("installed_plugin_agent_runtime_cleanup_unproven");
        captured.failedCreationCleanup?.confirmReleased();
      };
      try {
        await cleanup();
      } catch (failure) {
        const failed = new AggregateError(
          [error, failure],
          "installed_plugin_agent_runtime_attestation_failed",
        );
        failureOwners.set(
          failed,
          Object.freeze({ runtime, owner: Object.freeze({ close: cleanup }) }),
        );
        throw failed;
      }
      throw error;
    }
  }

  #attest(runtime: AgentVersionRuntime, tenantId: string): AgentVersionRuntime {
    const entry = this.#entries.get(
      key(tenantId, runtime.version.agentVersionId),
    );
    if (entry === undefined)
      fail("installed_plugin_agent_runtime_not_deployed");
    registerInstalledPluginAgentRuntimeScope(runtime, entry.scope);
    return runtime;
  }
}

function captureCreation(input: CreationInput): CreationInput {
  if (input === null || typeof input !== "object")
    fail("installed_plugin_agent_runtime_creation_invalid");
  const value = (name: keyof CreationInput, required: boolean): unknown => {
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (field === undefined && !required) return undefined;
    if (field === undefined || !field.enumerable || !("value" in field))
      fail("installed_plugin_agent_runtime_creation_invalid");
    return field.value;
  };
  const rawCleanup = value("failedCreationCleanup", false);
  let cleanup: FailedRuntimeCreationCleanup | undefined;
  if (rawCleanup !== undefined) {
    if (rawCleanup === null || typeof rawCleanup !== "object")
      fail("installed_plugin_agent_runtime_creation_invalid");
    const method = Object.getOwnPropertyDescriptor(
      rawCleanup,
      "confirmReleased",
    );
    if (
      method === undefined ||
      !("value" in method) ||
      typeof method.value !== "function"
    )
      fail("installed_plugin_agent_runtime_creation_invalid");
    cleanup = Object.freeze({ confirmReleased: method.value.bind(rawCleanup) });
  }
  try {
    return Object.freeze({
      tenantId: extensionOpaqueId(value("tenantId", true)),
      version: parseCompiledAgentVersion(
        JSON.stringify(value("version", true)),
        digester,
      ),
      ...(cleanup === undefined ? {} : { failedCreationCleanup: cleanup }),
    });
  } catch (error) {
    cleanup?.confirmReleased();
    throw error;
  }
}

function prepare(
  defaultAgentVersionId: string,
  entry: InstalledPluginAgentRuntimeEntry,
): Prepared {
  extensionOpaqueId(defaultAgentVersionId);
  assertInstalledPluginBusinessRegistration(entry.registration);
  const scope = parsePluginProfileScope(entry.scope);
  const configuration = validateInstalledPluginConfiguration(
    entry.registration,
    entry.configuration,
  );
  if (
    scope.tenantId !== configuration.tenantId ||
    scope.spaceId !== configuration.spaceId ||
    entry.base.executionAuthority !== "crewonKernel"
  )
    fail("installed_plugin_agent_runtime_scope_mismatch");
  if (
    entry.approvalRequirement !== "none" &&
    entry.approvalRequirement !== "perAction"
  )
    fail("installed_plugin_agent_runtime_approval_invalid");
  const baseVersion = parseCompiledAgentVersion(
    JSON.stringify(entry.base.version),
    digester,
  );
  const version = parseCompiledAgentVersion(
    JSON.stringify(entry.version),
    digester,
  );
  if (
    version.agentVersionId === defaultAgentVersionId ||
    version.agentVersionId === baseVersion.agentVersionId
  )
    fail("installed_plugin_agent_runtime_default_conflict");
  const deployment = checkedBaseDeployment(entry.base.deployment);
  if (
    deployment.tenantId !== scope.tenantId ||
    deployment.agentVersionId !== baseVersion.agentVersionId ||
    deployment.contentDigest !== baseVersion.contentDigest ||
    baseVersion.resources.workspaceRequired !==
      (deployment.workspaceBindingId !== null)
  )
    fail("installed_plugin_agent_runtime_base_mismatch");
  const expected = compileInstalledPluginAgentVersion({
    base: { executionAuthority: "crewonKernel", version: baseVersion },
    registration: entry.registration,
    agentVersionId: version.agentVersionId,
    runtimeGeneration: version.runtimeGeneration,
    policySnapshotId: version.policySnapshotId,
    digester,
  });
  if (!isDeepStrictEqual(expected, version))
    fail("installed_plugin_agent_runtime_version_mismatch");
  const authorityId = extensionOpaqueId(entry.authorityId);
  const workspaceBindingId =
    entry.workspaceBindingId === null
      ? null
      : extensionOpaqueId(entry.workspaceBindingId);
  if (version.resources.workspaceRequired !== (workspaceBindingId !== null))
    fail("installed_plugin_agent_runtime_workspace_mismatch");
  if (
    typeof entry.createTransport !== "function" ||
    typeof entry.createBaseToolRuntime !== "function" ||
    (entry.createGovernedContext !== undefined &&
      typeof entry.createGovernedContext !== "function") ||
    (entry.transportOwnership !== undefined &&
      entry.transportOwnership !== "runtime" &&
      entry.transportOwnership !== "request")
  )
    fail("installed_plugin_agent_runtime_materializers_invalid");
  const proofRegistration = Object.freeze({
    manifest: entry.registration.manifest,
    manifestDigest: entry.registration.manifestDigest,
    implementationDigest: entry.registration.implementationDigest,
  });
  // Only independently verified content digests enter this small identity recipe.
  // The installed materialization format never reinterprets an existing v0 digest.
  const materializationDigest = digester.sha256(
    extensionCanonicalJson({
      schemaVersion: "crewon.installed-plugin-agent-materialization.v1",
      scope,
      packageIdentity: entry.registration.identity,
      registration: {
        manifestDigest: proofRegistration.manifestDigest,
        implementationDigest: proofRegistration.implementationDigest,
      },
      configuration: {
        revision: configuration.revision,
        contentDigest: configuration.contentDigest,
      },
      approvalRequirement: entry.approvalRequirement,
      baseDeployment: deployment,
      baseVersionContentDigest: baseVersion.contentDigest,
      versionContentDigest: version.contentDigest,
      authorityId,
      workspaceBindingId,
      transportOwnership: entry.transportOwnership ?? "runtime",
    }),
  );
  return Object.freeze({
    scope,
    registration: entry.registration,
    proofRegistration,
    configuration,
    approvalRequirement: entry.approvalRequirement,
    baseVersion,
    version,
    definitions: extensionToolDefinitions(entry.registration.manifest),
    target: Object.freeze({
      executionAuthority: "crewonKernel",
      agentVersionId: version.agentVersionId,
      agentVersionContentDigest: version.contentDigest,
      materializationDigest,
      authorityId,
      runtimeGeneration: version.runtimeGeneration,
      policySnapshotId: version.policySnapshotId,
      workspaceBindingId,
    }),
    createTransport: entry.createTransport.bind(entry),
    createBaseToolRuntime: entry.createBaseToolRuntime.bind(entry),
    ...(entry.createGovernedContext === undefined
      ? {}
      : { createGovernedContext: entry.createGovernedContext.bind(entry) }),
    ...(entry.transportOwnership === undefined
      ? {}
      : { transportOwnership: entry.transportOwnership }),
  });
}

function binding(entry: Prepared): AgentVersionRuntimeBinding {
  return {
    tenantId: entry.scope.tenantId,
    agentVersionId: entry.version.agentVersionId,
    contentDigest: entry.version.contentDigest,
    authorityId: entry.target.authorityId,
    workspaceBindingId: entry.target.workspaceBindingId,
    materializationDigest: entry.target.materializationDigest,
    executionAuthority: "crewonKernel",
    toolRuntimeMode: "independent",
    ...(entry.transportOwnership === undefined
      ? {}
      : { transportOwnership: entry.transportOwnership }),
    ...(entry.createGovernedContext === undefined
      ? {}
      : { createGovernedContext: entry.createGovernedContext }),
    createTransport: (version, options = {}) =>
      createVerifiedTransport(entry, version, options),
    createToolRuntime: (_version, options = {}) =>
      createVerifiedTools(entry, options),
  };
}

async function createVerifiedTransport(
  entry: Prepared,
  version: CompiledAgentVersion,
  options: RuntimeCreationOptions,
): Promise<ModelTransportPort> {
  const creation = new RuntimeCreationCleanup(options.failedCreationCleanup);
  try {
    await revalidateInstalledPluginBusinessRegistration(
      entry.registration,
      new AbortController().signal,
    );
    const transport = await creation.create((child) =>
      entry.createTransport(version, child),
    );
    creation.transfer();
    return transport;
  } catch (error) {
    await creation.cleanup();
    throw error;
  }
}

async function createVerifiedTools(
  entry: Prepared,
  options: RuntimeCreationOptions,
): Promise<ToolRuntimePort> {
  const creation = new RuntimeCreationCleanup(options.failedCreationCleanup);
  try {
    await revalidateInstalledPluginBusinessRegistration(
      entry.registration,
      new AbortController().signal,
    );
    const base = await creation.create((child) =>
      entry.createBaseToolRuntime(entry.baseVersion, child),
    );
    if (readRuntimeExtensionMaterializations(base) !== null)
      fail("installed_plugin_agent_runtime_base_extension_conflict");
    if (!isDeepStrictEqual(base.definitions(), entry.baseVersion.tools))
      fail("installed_plugin_agent_runtime_base_tools_mismatch");
    await revalidateInstalledPluginBusinessRegistration(
      entry.registration,
      new AbortController().signal,
    );
    const placeholder = creation.own(
      new InstalledPluginToolPlaceholder(entry.definitions),
    );
    const final = new CompositeToolRuntime([base, placeholder]);
    // Validate the complete catalog before publishing the actual owner proof.
    scopeToolRuntimeToAgentVersion(final, entry.version.tools);
    registerRuntimeExtensionMaterializations(final, [
      {
        configuration: entry.configuration,
        registration: entry.proofRegistration,
        target: entry.target,
        approvalRequirement: entry.approvalRequirement,
      },
    ]);
    creation.transfer();
    return final;
  } catch (error) {
    await creation.cleanup();
    throw error;
  }
}

/** Catalog presence is not an executable implementation. Only the per-Run SDK owner can replace it. */
class InstalledPluginToolPlaceholder implements ToolRuntimePort {
  readonly #definitions: readonly ToolDefinition[];
  #closed = false;
  constructor(definitions: readonly ToolDefinition[]) {
    this.#definitions = structuredClone(definitions);
  }
  definitions(): readonly ToolDefinition[] {
    if (this.#closed) fail("installed_plugin_agent_runtime_closed");
    return structuredClone(this.#definitions);
  }
  executionPolicy(): null {
    return null;
  }
  async execute(
    _command: ToolExecutionCommand,
    _signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return fail("installed_plugin_sdk_runtime_required");
  }
  async reconcile(
    _command: ToolExecutionCommand,
    _signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return fail("installed_plugin_sdk_runtime_required");
  }
  async cancel(
    _command: ToolExecutionCommand,
    _signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return fail("installed_plugin_sdk_runtime_required");
  }
  canRetire(): boolean {
    return !this.#closed;
  }
  async close(): Promise<void> {
    this.#closed = true;
  }
}

function checkedBaseDeployment(
  input: AgentVersionDeploymentCandidate,
): AgentVersionDeploymentCandidate {
  const value = JSON.parse(
    extensionCanonicalJson(input),
  ) as AgentVersionDeploymentCandidate;
  if (
    Object.keys(value).sort().join(",") !==
      "agentVersionId,authorityId,contentDigest,materializationDigest,schemaVersion,tenantId,workspaceBindingId" ||
    value.schemaVersion !== "crewon.agent-version-deployment.v0"
  )
    fail("installed_plugin_agent_runtime_base_deployment_invalid");
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    tenantId: extensionOpaqueId(value.tenantId),
    agentVersionId: extensionOpaqueId(value.agentVersionId),
    contentDigest: extensionDigest(value.contentDigest),
    materializationDigest: extensionDigest(value.materializationDigest),
    authorityId: extensionOpaqueId(value.authorityId),
    workspaceBindingId:
      value.workspaceBindingId === null
        ? null
        : extensionOpaqueId(value.workspaceBindingId),
  });
}
function key(tenantId: string, agentVersionId: string): string {
  return JSON.stringify([tenantId, agentVersionId]);
}
function fail(code: string): never {
  throw new Error(code);
}
