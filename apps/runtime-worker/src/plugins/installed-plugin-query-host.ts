import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type {
  ActorContext,
  AgentVersionDeploymentStore,
  AuthorizationPort,
  ExtensionStore,
  ExternalOperationStore,
  PluginInstallationStore,
  PluginQueryHostPort,
  PluginQuerySource,
  RunStore,
  ExtensionRegistration,
  ExtensionReadiness,
} from "@crewon/application";
import { loadPluginQuerySource } from "@crewon/application";
import { parseExtensionHostActor } from "@crewon/contracts";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseExtensionRunBinding,
  parsePluginProfileScope,
  parsePluginTaskAdmission,
  parseExtensionActivation,
  parsePluginSelection,
  parseExtensionManifest,
  extensionDigest,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  PluginExecutionPackage,
  pluginExecutionPackageFailureOwner,
  type PluginActivationCandidate,
  type PluginExecutionPackageFailureOwner,
} from "@crewon/plugin-host";
import { StoreBackedAgentVersionRuntimeResolver } from "../store-backed-agent-version-runtime-resolver.ts";
import { extensionToolDefinitions } from "../extensions/extension-tool-catalog.ts";
import { parseRuntimeExtensionMaterialization } from "../extensions/extension-runtime-proof.ts";
import { readInstalledPluginAgentRuntimeScope } from "./installed-plugin-agent-runtime-factory-proof.ts";
import {
  loadInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
  type InstalledPluginBusinessRegistration,
} from "./installed-plugin-business-registration.ts";
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export type InstalledPluginQueryHostDependencies = Readonly<{
  scope: PluginProfileScope;
  installRoot: string;
  extensions: ExtensionStore;
  runs: Pick<RunStore, "loadRunInSpace">;
  operations: Pick<ExternalOperationStore, "loadExternalOperation">;
  installations: PluginInstallationStore;
  authorization: AuthorizationPort;
  runtimeResolver: StoreBackedAgentVersionRuntimeResolver;
  deployments: Pick<AgentVersionDeploymentStore, "loadAgentVersionDeployment">;
  resolveActor(
    owner: Readonly<{ tenantId: string; spaceId: string; actorId: string }>,
    signal: AbortSignal,
  ): Promise<ActorContext | null>;
  resolveProfile(
    actor: ActorContext,
    signal: AbortSignal,
  ): Promise<PluginProfileScope | null>;
  authorizePackage(
    input: Readonly<{
      candidate: PluginActivationCandidate;
      scope: PluginProfileScope;
      purpose: "observe";
    }>,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
}>;
type Dependencies = InstalledPluginQueryHostDependencies;
/** Installed historical observation never becomes a current catalog or a generation authority. */
export class InstalledPluginQueryHost implements PluginQueryHostPort {
  readonly #d: Dependencies;
  readonly #scope: PluginProfileScope;
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #packages = new Map<string, Promise<PluginExecutionPackage>>();
  readonly #owners = new Set<
    PluginExecutionPackage | PluginExecutionPackageFailureOwner
  >();
  #closed = false;
  #closing: Promise<void> | null = null;
  constructor(input: Dependencies) {
    if (
      !(
        input.runtimeResolver instanceof StoreBackedAgentVersionRuntimeResolver
      ) ||
      typeof input.installRoot !== "string" ||
      !isAbsolute(input.installRoot) ||
      resolve(input.installRoot) !== input.installRoot
    )
      throw new Error("installed_plugin_query_runtime_unavailable");
    this.#scope = parsePluginProfileScope(input.scope);
    this.#d = Object.freeze({
      ...input,
      scope: this.#scope,
      installRoot: input.installRoot,
      authorization: Object.freeze({
        authorize: input.authorization.authorize.bind(input.authorization),
      }),
      resolveActor: input.resolveActor.bind(input),
      resolveProfile: input.resolveProfile.bind(input),
      authorizePackage: input.authorizePackage.bind(input),
      runs: Object.freeze({
        loadRunInSpace: input.runs.loadRunInSpace.bind(input.runs),
      }),
      operations: Object.freeze({
        loadExternalOperation: input.operations.loadExternalOperation.bind(
          input.operations,
        ),
      }),
      deployments: Object.freeze({
        loadAgentVersionDeployment:
          input.deployments.loadAgentVersionDeployment.bind(input.deployments),
      }),
      installations: Object.freeze({
        ...input.installations,
        loadSelection: input.installations.loadSelection.bind(
          input.installations,
        ),
        loadPackage: input.installations.loadPackage.bind(input.installations),
      }),
      extensions: Object.freeze({
        ...input.extensions,
        loadPluginTaskAdmission: input.extensions.loadPluginTaskAdmission?.bind(
          input.extensions,
        ),
        loadExtensionRunBinding: input.extensions.loadExtensionRunBinding.bind(
          input.extensions,
        ),
        loadExtensionTurnReceipt:
          input.extensions.loadExtensionTurnReceipt.bind(input.extensions),
        loadExtensionConfiguration:
          input.extensions.loadExtensionConfiguration.bind(input.extensions),
        loadExtensionActivation: input.extensions.loadExtensionActivation.bind(
          input.extensions,
        ),
      }),
    });
  }
  #capture(
    input: Readonly<{ actor: ActorContext; source: PluginQuerySource }>,
  ) {
    const rawSource = checkedRecord(input.source, [
      "admission",
      "binding",
      "operationId",
    ]);
    const actor = parseExtensionHostActor(input.actor);
    if (
      typeof rawSource.operationId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
        rawSource.operationId,
      )
    )
      throw new Error("installed_plugin_query_source_invalid");
    const source = Object.freeze({
      admission: parsePluginTaskAdmission(rawSource.admission),
      binding: parseExtensionRunBinding(rawSource.binding, digester),
      operationId: rawSource.operationId,
    });
    return Object.freeze({ actor, source });
  }
  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed)
      return Promise.reject(new Error("installed_plugin_query_host_closed"));
    const work = operation().finally(() => this.#pending.delete(work));
    this.#pending.add(work);
    return work;
  }
  async #assert(
    input: Readonly<{ actor: ActorContext; source: PluginQuerySource }>,
  ): Promise<void> {
    const d = this.#d,
      s = this.#lifetime.signal;
    s.throwIfAborted();
    const resolved = await d.resolveActor(
      {
        tenantId: input.actor.tenantId,
        spaceId: input.actor.spaceId,
        actorId: input.actor.actorId,
      },
      s,
    );
    s.throwIfAborted();
    if (
      resolved === null ||
      !same(parseExtensionHostActor(resolved), input.actor)
    )
      throw new Error("installed_plugin_query_identity_invalid");
    const profile = await d.resolveProfile(input.actor, s);
    s.throwIfAborted();
    if (
      profile === null ||
      !same(parsePluginProfileScope(profile), this.#scope) ||
      input.actor.tenantId !== this.#scope.tenantId ||
      input.actor.spaceId !== this.#scope.spaceId
    )
      throw new Error("installed_plugin_query_profile_invalid");
    const actual = await loadPluginQuerySource({
      actor: input.actor,
      pluginId: input.source.admission.pluginId,
      profileId: this.#scope.profileId,
      publisherId: input.source.admission.publisherId,
      sourceRunId: input.source.binding.runId,
      operationId: input.source.operationId,
      extensions: d.extensions,
      runs: d.runs,
      operations: d.operations,
      authorization: d.authorization,
      digester,
    });
    s.throwIfAborted();
    if (!same(actual, input.source))
      throw new Error("installed_plugin_query_source_changed");
    const before = await this.#facts(input.source);
    for (const action of ["extension:query", "extension:read"] as const) {
      const decision = await d.authorization.authorize({
        actor: input.actor,
        action,
        resource: {
          kind: "extension",
          tenantId: this.#scope.tenantId,
          spaceId: this.#scope.spaceId,
          pluginId: actual.admission.pluginId,
        },
      });
      s.throwIfAborted();
      if (decision.outcome !== "allow")
        throw new Error("installed_plugin_query_forbidden");
    }
    if (!same(before, await this.#facts(input.source)))
      throw new Error("installed_plugin_query_authority_changed");
  }
  async #facts(source: PluginQuerySource) {
    const raw = await this.#d.extensions.loadExtensionActivation(
      source.binding,
    );
    this.#lifetime.signal.throwIfAborted();
    if (raw === null) throw new Error("installed_plugin_query_access_revoked");
    const activation = parseExtensionActivation(raw);
    if (
      activation.tenantId !== this.#scope.tenantId ||
      activation.spaceId !== this.#scope.spaceId ||
      activation.pluginId !== source.admission.pluginId ||
      activation.state === "revoked"
    )
      throw new Error("installed_plugin_query_access_revoked");
    const selectionRaw = await this.#d.installations.loadSelection({
      scope: this.#scope,
      pluginId: source.admission.pluginId,
    });
    this.#lifetime.signal.throwIfAborted();
    if (selectionRaw === null)
      throw new Error("installed_plugin_query_selection_missing");
    const selection = parsePluginSelection(selectionRaw);
    if (
      selection.tenantId !== this.#scope.tenantId ||
      selection.spaceId !== this.#scope.spaceId ||
      selection.profileId !== this.#scope.profileId ||
      selection.pluginId !== source.admission.pluginId ||
      selection.publisherId !== source.admission.publisherId ||
      selection.revision < source.admission.selectionRevision ||
      (selection.revision === source.admission.selectionRevision &&
        (selection.state !== "enabled" ||
          selection.selectedPackageDigest !== source.admission.packageDigest))
    )
      throw new Error("installed_plugin_query_selection_invalid");
    return Object.freeze({ activation, selection });
  }
  async #registration(
    input: Readonly<{ actor: ActorContext; source: PluginQuerySource }>,
  ): Promise<InstalledPluginBusinessRegistration> {
    await this.#assert(input);
    const a = input.source.admission;
    return loadInstalledPluginBusinessRegistration({
      installRoot: this.#d.installRoot,
      expectedPluginId: a.pluginId,
      expectedPublisherId: a.publisherId,
      expectedVersion: a.version,
      expectedPackageDigest: a.packageDigest,
      signal: this.#lifetime.signal,
      authorizeRead: async (candidate, signal) => {
        await this.#assert(input);
        return this.#d.authorizePackage(
          { candidate, scope: this.#scope, purpose: "observe" },
          signal,
        );
      },
    });
  }
  resolveRegistration(
    raw: Parameters<PluginQueryHostPort["resolveRegistration"]>[0],
  ): Promise<ExtensionRegistration | null> {
    const input = this.#capture(raw);
    return this.#run(async () => {
      const registration = await this.#registration(input);
      await this.#assert(input);
      return project(registration);
    });
  }
  evaluate(
    raw: Parameters<PluginQueryHostPort["evaluate"]>[0],
  ): Promise<ExtensionReadiness> {
    const input = this.#capture(raw),
      configuration = parseExtensionConfiguration(raw.configuration, digester),
      target = parseExtensionExecutionTarget(raw.expectedTarget),
      registration = project(raw.registration);
    return this.#run(async () => {
      await this.#assert(input);
      const installed = await this.#registration(input);
      validateInstalledPluginConfiguration(installed, configuration);
      if (
        !same(project(installed), registration) ||
        !same(target, input.source.binding.target) ||
        configuration.revision !== input.source.binding.configurationRevision ||
        configuration.contentDigest !== input.source.binding.configurationDigest
      )
        throw new Error("installed_plugin_query_target_mismatch");
      const d = this.#d,
        s = this.#lifetime.signal,
        locator = {
          tenantId: this.#scope.tenantId,
          agentVersionId: target.agentVersionId,
        };
      const decision = await d.authorization.authorize({
        actor: input.actor,
        action: "agentVersion:read",
        resource: {
          kind: "agentVersion",
          tenantId: this.#scope.tenantId,
          spaceId: this.#scope.spaceId,
          agentVersionId: target.agentVersionId,
        },
      });
      s.throwIfAborted();
      if (decision.outcome !== "allow")
        throw new Error("installed_plugin_query_forbidden");
      const deployment =
        await d.deployments.loadAgentVersionDeployment(locator);
      s.throwIfAborted();
      const lease = await d.runtimeResolver.acquire(locator);
      if (lease === null) return unavailable();
      try {
        s.throwIfAborted();
        const runtime = lease.resource;
        const proof =
          runtime.extensions?.length === 1
            ? parseRuntimeExtensionMaterialization(runtime.extensions[0])
            : null;
        if (
          deployment === null ||
          proof === null ||
          runtime.executionAuthority !== "crewonKernel" ||
          !same(readInstalledPluginAgentRuntimeScope(runtime), this.#scope) ||
          !same(proof.configuration, configuration) ||
          !same(project(proof.registration), registration) ||
          !same(proof.target, target) ||
          runtime.version.agentVersionId !== target.agentVersionId ||
          runtime.version.contentDigest !== target.agentVersionContentDigest ||
          runtime.version.runtimeGeneration !== target.runtimeGeneration ||
          runtime.version.policySnapshotId !== target.policySnapshotId ||
          deployment.tenantId !== locator.tenantId ||
          deployment.agentVersionId !== target.agentVersionId ||
          deployment.contentDigest !== target.agentVersionContentDigest ||
          deployment.materializationDigest !== target.materializationDigest ||
          deployment.authorityId !== target.authorityId ||
          deployment.workspaceBindingId !== target.workspaceBindingId ||
          !same(runtime.toolRuntime.definitions(), runtime.version.tools) ||
          !extensionToolDefinitions(installed.manifest).every((tool) =>
            runtime.version.tools.some((actual) => same(tool, actual)),
          )
        )
          return unavailable();
        let owner = this.#packages.get(installed.identity.packageDigest);
        if (owner === undefined) {
          if (this.#packages.size >= 32)
            throw new Error("installed_plugin_query_capacity_exceeded");
          let candidate: PluginActivationCandidate | null = null;
          owner = PluginExecutionPackage.open({
            activation: {
              installRoot: d.installRoot,
              expectedPluginId: installed.identity.pluginId,
              expectedPackageDigest: installed.identity.packageDigest,
              authorizeActivation: async (value) => {
                candidate = value;
                await this.#assert(input);
                return d.authorizePackage(
                  { candidate: value, scope: this.#scope, purpose: "observe" },
                  s,
                );
              },
            },
            beforeCommit: async () => {
              await this.#assert(input);
              if (
                candidate === null ||
                (await d.authorizePackage(
                  { candidate, scope: this.#scope, purpose: "observe" },
                  s,
                )) !== "allow"
              )
                throw new Error("installed_plugin_query_package_denied");
            },
            commit: {
              authorizeCommit: (value) =>
                !this.#closed &&
                value.identity.packageDigest ===
                  installed.identity.packageDigest
                  ? "allow"
                  : "deny",
            },
          }).then(
            (value) => {
              this.#owners.add(value);
              return value;
            },
            (error) => {
              const failure = pluginExecutionPackageFailureOwner(error);
              if (failure !== null) this.#owners.add(failure);
              else if (
                this.#packages.get(installed.identity.packageDigest) === owner
              )
                this.#packages.delete(installed.identity.packageDigest);
              throw error;
            },
          );
          this.#packages.set(installed.identity.packageDigest, owner);
        }
        const pkg = await owner;
        s.throwIfAborted();
        await this.#assert(input);
        const latest = await this.#registration(input);
        if (
          !same(project(latest), registration) ||
          !same(
            await d.deployments.loadAgentVersionDeployment(locator),
            deployment,
          )
        )
          return unavailable();
        const borrow = pkg.acquire({
          purpose: "historicalOperation",
          authorizeBorrow: (identity) =>
            !this.#closed &&
            identity.pluginId === installed.identity.pluginId &&
            identity.version === installed.identity.version &&
            identity.packageDigest === installed.identity.packageDigest
              ? "allow"
              : "deny",
        });
        borrow.release();
        return Object.freeze({ outcome: "ready", target });
      } finally {
        lease.release();
      }
    });
  }
  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#lifetime.abort();
    this.#closing = (async () => {
      await Promise.allSettled([...this.#pending]);
      const results = await Promise.allSettled(
        [...this.#owners].map((owner) => owner.close()),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          "installed_plugin_query_cleanup_failed",
        );
      this.#owners.clear();
      this.#packages.clear();
    })();
    return this.#closing;
  }
}
function project(registration: ExtensionRegistration): ExtensionRegistration {
  const manifest = parseExtensionManifest(registration.manifest),
    manifestDigest = extensionDigest(registration.manifestDigest);
  if (digester.sha256(extensionCanonicalJson(manifest)) !== manifestDigest)
    throw new Error("installed_plugin_query_registration_invalid");
  return Object.freeze({
    manifest,
    manifestDigest,
    implementationDigest: extensionDigest(registration.implementationDigest),
  });
}
function checkedRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    throw new Error("installed_plugin_query_source_invalid");
  const fields = Object.getOwnPropertyDescriptors(input),
    actual = Reflect.ownKeys(input);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("installed_plugin_query_source_invalid");
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const field = fields[key];
    if (field === undefined || !field.enumerable || !("value" in field))
      throw new Error("installed_plugin_query_source_invalid");
    copy[key] = field.value;
  }
  return copy;
}
function same(a: unknown, b: unknown): boolean {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function unavailable(): ExtensionReadiness {
  return Object.freeze({
    outcome: "unavailable",
    reasonCode: "extension_runtime_unavailable",
  });
}
