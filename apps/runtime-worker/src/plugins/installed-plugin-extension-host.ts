import { isAbsolute, resolve } from "node:path";
import type {
  ActorContext,
  AgentVersionDeploymentStore,
  AuthorizationPort,
  ExtensionHostPort,
  ExtensionReadiness,
  ExtensionRegistration,
  ExtensionStore,
  PluginInstallationStore,
} from "@crewon/application";
import { parseExtensionHostActor } from "@crewon/contracts";
import {
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionManifest,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  type ExtensionConfiguration,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  PluginExecutionPackage,
  pluginExecutionPackageFailureOwner,
  type PluginActivationCandidate,
  type PluginExecutionPackageFailureOwner,
} from "@crewon/plugin-host";
import type { InstalledPluginExecutionReadinessPort } from "./installed-plugin-execution-readiness-types.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "../store-backed-agent-version-runtime-resolver.ts";
import {
  assertInstalledPluginBusinessRegistration,
  revalidateInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
  type InstalledPluginBusinessRegistration,
} from "./installed-plugin-business-registration.ts";
import {
  evaluateInstalledPluginReadiness,
  type InstalledPluginReadinessRequest,
} from "./installed-plugin-readiness-core.ts";

export type InstalledPluginExtensionHostDependencies = Readonly<{
  scope: PluginProfileScope;
  registrations: readonly InstalledPluginBusinessRegistration[];
  installRoot: string;
  installations: Pick<PluginInstallationStore, "loadSelection" | "loadPackage">;
  authorization: AuthorizationPort;
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
      purpose: "submit";
    }>,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
  /** Preparation is revision-bound and never conveys permission to submit a Run. */
  authorizeCandidatePackage?(
    input: Readonly<{
      candidate: PluginActivationCandidate;
      scope: PluginProfileScope;
      expectedSelectionRevision: number;
    }>,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
  runtimeResolver: StoreBackedAgentVersionRuntimeResolver;
  deployments: Pick<AgentVersionDeploymentStore, "loadAgentVersionDeployment">;
  /** Candidate preparation alone requires the same parent's saved configuration store. */
  configurations?: Pick<ExtensionStore, "loadLatestExtensionConfiguration">;
  /** Includes pending setup and failed physical cleanup, never more than 32. */
  maximumPackages?: number;
  /** Actual deployment-owned IO preflight. Legacy factories without declared services remain compatible. */
  executionReadiness?: InstalledPluginExecutionReadinessPort;
}>;

type Request = InstalledPluginReadinessRequest;
export type InstalledPluginPrepareCandidateInput = Readonly<{
  actor: ActorContext;
  registration: ExtensionRegistration;
  configuration: ExtensionConfiguration;
  agentVersionId: string;
  expectedSelectionRevision: number;
}>;
type PackageEntry = {
  loading: Promise<PluginExecutionPackage>;
  candidate: PluginActivationCandidate | null;
  owner: PluginExecutionPackage | PluginExecutionPackageFailureOwner | null;
  failed: boolean;
};

/** Fixed-profile readiness authority. Metadata validation never executes a plugin. */
export class InstalledPluginExtensionHost implements ExtensionHostPort {
  readonly #scope: PluginProfileScope;
  readonly #dependencies: InstalledPluginExtensionHostDependencies;
  readonly #registrations = new Map<
    string,
    InstalledPluginBusinessRegistration
  >();
  readonly #packages = new Map<string, PackageEntry>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #controllers = new Set<AbortController>();
  readonly #candidateFacts = new WeakMap<Request, string>();
  readonly #maximumPackages: number;
  readonly #acquire: StoreBackedAgentVersionRuntimeResolver["acquire"];
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(input: InstalledPluginExtensionHostDependencies) {
    const scope = parsePluginProfileScope(input.scope);
    if (
      typeof input.installRoot !== "string" ||
      input.installRoot.length === 0 ||
      input.installRoot.length > 4096 ||
      input.installRoot.includes("\0") ||
      !isAbsolute(input.installRoot) ||
      !(
        input.runtimeResolver instanceof StoreBackedAgentVersionRuntimeResolver
      ) ||
      !Array.isArray(input.registrations) ||
      input.registrations.length < 1 ||
      input.registrations.length > 32
    )
      fail("installed_plugin_extension_host_configuration_invalid");
    const maximum = input.maximumPackages ?? 32;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32)
      fail("installed_plugin_extension_host_capacity_invalid");
    for (const registration of input.registrations) {
      assertInstalledPluginBusinessRegistration(registration);
      const key = registrationKey(registration);
      if (
        this.#registrations.has(key) ||
        [...this.#registrations.values()].some(
          (other) =>
            other.identity.pluginId === registration.identity.pluginId &&
            other.identity.publisherId !== registration.identity.publisherId,
        )
      )
        fail("installed_plugin_extension_host_registration_conflict");
      this.#registrations.set(key, registration);
    }
    // Capture methods and receivers before asynchronous work. Mutating a caller's
    // configuration later cannot replace the port or the private installation root.
    this.#dependencies = Object.freeze({
      scope,
      registrations: Object.freeze([...this.#registrations.values()]),
      installRoot: resolve(input.installRoot),
      installations: Object.freeze({
        loadSelection: method(input.installations, "loadSelection"),
        loadPackage: method(input.installations, "loadPackage"),
      }),
      authorization: Object.freeze({
        authorize: method(input.authorization, "authorize"),
      }),
      resolveActor: method(input, "resolveActor"),
      resolveProfile: method(input, "resolveProfile"),
      authorizePackage: method(input, "authorizePackage"),
      ...(input.authorizeCandidatePackage === undefined
        ? {}
        : {
            authorizeCandidatePackage: method(
              input,
              "authorizeCandidatePackage",
            ),
          }),
      runtimeResolver: input.runtimeResolver,
      ...(input.executionReadiness === undefined
        ? {}
        : {
            executionReadiness: Object.freeze({
              assertReady: method(input.executionReadiness, "assertReady"),
            }),
          }),
      deployments: Object.freeze({
        loadAgentVersionDeployment: method(
          input.deployments,
          "loadAgentVersionDeployment",
        ),
      }),
      ...(input.configurations === undefined
        ? {}
        : {
            configurations: Object.freeze({
              loadLatestExtensionConfiguration: method(
                input.configurations,
                "loadLatestExtensionConfiguration",
              ),
            }),
          }),
    });
    this.#scope = scope;
    this.#maximumPackages = maximum;
    this.#acquire = method(input.runtimeResolver, "acquire");
  }

  taskAdmissionMode(
    input: Readonly<{ registration: ExtensionRegistration }>,
  ): "installed" {
    if (this.#closed) fail("installed_plugin_extension_host_closed");
    const snapshot = JSON.parse(extensionCanonicalJson(input));
    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      Array.isArray(snapshot) ||
      !same(Object.keys(snapshot), ["registration"])
    )
      fail("installed_plugin_extension_host_registration_mismatch");
    const registration: unknown = snapshot.registration;
    if (
      registration === null ||
      typeof registration !== "object" ||
      Array.isArray(registration) ||
      !same(Object.keys(registration).sort(), [
        "implementationDigest",
        "manifest",
        "manifestDigest",
      ])
    )
      fail("installed_plugin_extension_host_registration_mismatch");
    this.#registration(registration as ExtensionRegistration);
    return "installed";
  }

  validateConfiguration(
    input: Parameters<ExtensionHostPort["validateConfiguration"]>[0],
  ): Promise<void> {
    const request = this.#request(input, null);
    return this.#run(async (signal) => {
      await this.#authorize(request, signal);
      await revalidateInstalledPluginBusinessRegistration(
        request.registration,
        signal,
      );
      await this.#authorize(request, signal);
    });
  }

  evaluate(
    input: Parameters<ExtensionHostPort["evaluate"]>[0],
  ): Promise<ExtensionReadiness> {
    const request = this.#request(
      input,
      extensionOpaqueId(input.agentVersionId),
    );
    return this.#run((signal) => this.#evaluate(request, signal));
  }

  /** Real disabled-package preflight. This does not enable, activate or execute a task. */
  prepareCandidate(
    input: InstalledPluginPrepareCandidateInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ExtensionReadiness> {
    const value = ownFields(input, [
      "actor",
      "registration",
      "configuration",
      "agentVersionId",
      "expectedSelectionRevision",
    ]);
    const revision = value.expectedSelectionRevision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1)
      fail("installed_plugin_extension_host_selection_revision_invalid");
    if (this.#dependencies.configurations === undefined)
      fail("installed_plugin_extension_host_configurations_unavailable");
    const registration = ownFields(value.registration, [
      "manifest",
      "manifestDigest",
      "implementationDigest",
    ]);
    const candidateInput = {
      actor: value.actor,
      registration: {
        manifest: parseExtensionManifest(registration.manifest),
        manifestDigest: registration.manifestDigest,
        implementationDigest: registration.implementationDigest,
      },
      configuration: value.configuration,
    };
    const request: Request = Object.freeze({
      ...this.#request(
        candidateInput as Parameters<
          ExtensionHostPort["validateConfiguration"]
        >[0],
        extensionOpaqueId(value.agentVersionId),
      ),
      kind: "candidate",
      agentVersionId: extensionOpaqueId(value.agentVersionId),
      expectedSelectionRevision: revision as number,
    });
    const signal = candidateSignal(options);
    return this.#run(
      (ownedSignal) => this.#evaluate(request, ownedSignal),
      signal,
    );
  }

  #evaluate(
    request: Request,
    signal: AbortSignal,
  ): Promise<ExtensionReadiness> {
    return evaluateInstalledPluginReadiness({
      request,
      scope: this.#scope,
      signal,
      acquire: this.#acquire,
      loadDeployment: this.#dependencies.deployments.loadAgentVersionDeployment,
      authorize: () => this.#authorize(request, signal),
      authorizeCandidate: (candidate) =>
        this.#authorizeCandidate(request, candidate, signal),
      openPackage: () => this.#package(request, signal),
      isOpen: () => !this.#closed,
      ...(this.#dependencies.executionReadiness === undefined
        ? {}
        : { executionReadiness: this.#dependencies.executionReadiness }),
    });
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    for (const controller of this.#controllers)
      controller.abort(new Error("installed_plugin_extension_host_closed"));
    this.#closing = (async () => {
      await Promise.allSettled([...this.#pending]);
      const entries = [...this.#packages.entries()];
      const results = await Promise.allSettled(
        entries.map(async ([key, entry]) => {
          if (entry.owner !== null) await entry.owner.close();
          if (entry.failed)
            fail("installed_plugin_extension_host_cleanup_failed");
          this.#packages.delete(key);
        }),
      );
      const errors = results.filter(
        (item): item is PromiseRejectedResult => item.status === "rejected",
      );
      if (errors.length)
        throw new AggregateError(
          errors.map((item) => item.reason),
          "installed_plugin_extension_host_cleanup_failed",
        );
    })();
    return this.#closing;
  }

  #request(
    input: Parameters<ExtensionHostPort["validateConfiguration"]>[0],
    agentVersionId: string | null,
  ): Request {
    if (this.#closed) fail("installed_plugin_extension_host_closed");
    const actor = parseExtensionHostActor(input.actor);
    const registration = this.#registration(input.registration);
    const configuration = validateInstalledPluginConfiguration(
      registration,
      input.configuration,
    );
    if (
      actor.tenantId !== this.#scope.tenantId ||
      actor.spaceId !== this.#scope.spaceId ||
      configuration.tenantId !== this.#scope.tenantId ||
      configuration.spaceId !== this.#scope.spaceId
    )
      fail("installed_plugin_extension_host_scope_mismatch");
    return Object.freeze({
      kind: "execution",
      actor,
      registration,
      configuration,
      agentVersionId,
    });
  }

  #registration(
    input: ExtensionRegistration,
  ): InstalledPluginBusinessRegistration {
    const registration = this.#registrations.get(registrationKey(input));
    if (
      registration === undefined ||
      !same(project(input), project(registration))
    )
      fail("installed_plugin_extension_host_registration_mismatch");
    return registration;
  }

  #run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const signal =
      externalSignal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, externalSignal]);
    this.#controllers.add(controller);
    const pending = Promise.resolve()
      .then(() => operation(signal))
      .finally(() => {
        this.#pending.delete(pending);
        this.#controllers.delete(controller);
      });
    this.#pending.add(pending);
    return pending;
  }

  async #facts(request: Request, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const current = await this.#dependencies.resolveActor(
      {
        tenantId: request.actor.tenantId,
        spaceId: request.actor.spaceId,
        actorId: request.actor.actorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      current === null ||
      !same(parseExtensionHostActor(current), request.actor)
    )
      fail("installed_plugin_extension_host_identity_invalid");
    const profile = await this.#dependencies.resolveProfile(
      request.actor,
      signal,
    );
    signal.throwIfAborted();
    if (
      profile === null ||
      !same(parsePluginProfileScope(profile), this.#scope)
    )
      fail("installed_plugin_extension_host_profile_invalid");
    const identity = request.registration.identity;
    const rawSelection = await this.#dependencies.installations.loadSelection({
      scope: this.#scope,
      pluginId: identity.pluginId,
    });
    signal.throwIfAborted();
    if (rawSelection === null)
      fail("installed_plugin_extension_host_selection_unavailable");
    const selection = parsePluginSelection(rawSelection);
    const rawPackage = await this.#dependencies.installations.loadPackage({
      scope: this.#scope,
      packageDigest: identity.packageDigest,
    });
    signal.throwIfAborted();
    if (rawPackage === null)
      fail("installed_plugin_extension_host_package_unavailable");
    const installed = parseInstalledPluginPackage(rawPackage);
    if (
      !same(scopeOf(selection), this.#scope) ||
      !same(scopeOf(installed), this.#scope) ||
      (request.kind === "execution"
        ? selection.state !== "enabled"
        : selection.state !== "disabled" ||
          selection.revision !== request.expectedSelectionRevision) ||
      selection.pluginId !== identity.pluginId ||
      selection.publisherId !== identity.publisherId ||
      selection.selectedPackageDigest !== identity.packageDigest ||
      installed.pluginId !== identity.pluginId ||
      installed.publisherId !== identity.publisherId ||
      installed.version !== identity.version ||
      installed.packageDigest !== identity.packageDigest
    )
      fail("installed_plugin_extension_host_selection_unavailable");
    const facts = {
      actor: request.actor,
      profile,
      selection,
      installed,
    };
    if (request.kind === "execution") return extensionCanonicalJson(facts);
    const configurations = this.#dependencies.configurations;
    if (configurations === undefined)
      fail("installed_plugin_extension_host_configurations_unavailable");
    const latest = await configurations.loadLatestExtensionConfiguration({
      tenantId: this.#scope.tenantId,
      spaceId: this.#scope.spaceId,
      pluginId: identity.pluginId,
    });
    signal.throwIfAborted();
    if (
      latest === null ||
      !same(
        validateInstalledPluginConfiguration(request.registration, latest),
        request.configuration,
      )
    )
      fail("installed_plugin_extension_host_configuration_unavailable");
    const deployment =
      await this.#dependencies.deployments.loadAgentVersionDeployment({
        tenantId: this.#scope.tenantId,
        agentVersionId: request.agentVersionId,
      });
    signal.throwIfAborted();
    const snapshot = extensionCanonicalJson({
      ...facts,
      configuration: latest,
      deployment,
    });
    const original = this.#candidateFacts.get(request);
    if (original === undefined) this.#candidateFacts.set(request, snapshot);
    else if (original !== snapshot)
      fail("installed_plugin_extension_host_authority_changed");
    return snapshot;
  }

  async #authorize(request: Request, signal: AbortSignal): Promise<void> {
    const before = await this.#facts(request, signal);
    const decision = await this.#dependencies.authorization.authorize({
      actor: request.actor,
      action: "extension:read",
      resource: {
        kind: "extension",
        tenantId: this.#scope.tenantId,
        spaceId: this.#scope.spaceId,
        pluginId: request.registration.identity.pluginId,
      },
    });
    signal.throwIfAborted();
    if (outcome(decision) !== "allow")
      fail("installed_plugin_extension_host_forbidden");
    if (request.agentVersionId !== null) {
      const agentDecision = await this.#dependencies.authorization.authorize({
        actor: request.actor,
        action: "agentVersion:read",
        resource: {
          kind: "agentVersion",
          tenantId: this.#scope.tenantId,
          spaceId: this.#scope.spaceId,
          agentVersionId: request.agentVersionId,
        },
      });
      signal.throwIfAborted();
      if (outcome(agentDecision) !== "allow")
        fail("installed_plugin_extension_host_forbidden");
    }
    if (before !== (await this.#facts(request, signal)))
      fail("installed_plugin_extension_host_authority_changed");
  }

  async #authorizeCandidate(
    request: Request,
    candidate: PluginActivationCandidate,
    signal: AbortSignal,
  ): Promise<void> {
    const identity = request.registration.identity;
    if (
      candidate.packageDigest !== identity.packageDigest ||
      candidate.descriptor.pluginId !== identity.pluginId ||
      candidate.descriptor.publisherId !== identity.publisherId ||
      candidate.descriptor.version !== identity.version
    )
      fail("installed_plugin_extension_host_package_mismatch");
    await this.#authorize(request, signal);
    await revalidateInstalledPluginBusinessRegistration(
      request.registration,
      signal,
    );
    const decision =
      request.kind === "candidate" &&
      this.#dependencies.authorizeCandidatePackage !== undefined
        ? await this.#dependencies.authorizeCandidatePackage(
            {
              candidate,
              scope: this.#scope,
              expectedSelectionRevision: request.expectedSelectionRevision,
            },
            signal,
          )
        : await this.#dependencies.authorizePackage(
            { candidate, scope: this.#scope, purpose: "submit" },
            signal,
          );
    signal.throwIfAborted();
    if (decision !== "allow")
      fail("installed_plugin_extension_host_package_forbidden");
    await revalidateInstalledPluginBusinessRegistration(
      request.registration,
      signal,
    );
    await this.#authorize(request, signal);
  }

  async #package(request: Request, signal: AbortSignal): Promise<PackageEntry> {
    signal.throwIfAborted();
    const key = request.registration.identity.packageDigest;
    let entry = this.#packages.get(key);
    if (entry === undefined) {
      if (this.#closed) fail("installed_plugin_extension_host_closed");
      if (this.#packages.size >= this.#maximumPackages)
        fail("installed_plugin_extension_host_capacity_exceeded");
      entry = { loading: null!, candidate: null, owner: null, failed: false };
      this.#packages.set(key, entry);
      entry.loading = this.#open(request, signal, key, entry);
    }
    await entry.loading;
    signal.throwIfAborted();
    return entry;
  }

  async #open(
    request: Request,
    signal: AbortSignal,
    key: string,
    entry: PackageEntry,
  ): Promise<PluginExecutionPackage> {
    let verified = false;
    try {
      const owner = await PluginExecutionPackage.open({
        activation: {
          installRoot: this.#dependencies.installRoot,
          expectedPluginId: request.registration.identity.pluginId,
          expectedPackageDigest: key,
          authorizeActivation: async (candidate) => {
            entry.candidate = candidate;
            await this.#authorizeCandidate(request, candidate, signal);
            return "allow" as const;
          },
        },
        beforeCommit: async () => {
          if (entry.candidate === null)
            fail("installed_plugin_extension_host_candidate_missing");
          await this.#authorizeCandidate(request, entry.candidate, signal);
          verified = true;
        },
        commit: {
          authorizeCommit: (candidate) =>
            verified &&
            !this.#closed &&
            !signal.aborted &&
            same(
              {
                descriptor: candidate.descriptor,
                packageDigest: candidate.packageDigest,
              },
              entry.candidate,
            )
              ? "allow"
              : "deny",
        },
      });
      entry.owner = owner;
      if (this.#closed || signal.aborted) {
        await owner.close();
        this.#packages.delete(key);
        signal.throwIfAborted();
        fail("installed_plugin_extension_host_closed");
      }
      return owner;
    } catch (error) {
      const failedOwner = pluginExecutionPackageFailureOwner(error);
      if (failedOwner !== null) {
        entry.owner = failedOwner;
        entry.failed = true;
      } else if (entry.owner !== null && this.#packages.has(key))
        entry.failed = true;
      else this.#packages.delete(key);
      throw error;
    }
  }
}

function registrationKey(registration: ExtensionRegistration): string {
  return extensionCanonicalJson([
    registration.manifest.pluginId,
    registration.manifest.version,
  ]);
}
function project(registration: ExtensionRegistration): ExtensionRegistration {
  return {
    manifest: registration.manifest,
    manifestDigest: registration.manifestDigest,
    implementationDigest: registration.implementationDigest,
  };
}
function scopeOf(value: PluginProfileScope): PluginProfileScope {
  return {
    tenantId: value.tenantId,
    spaceId: value.spaceId,
    profileId: value.profileId,
  };
}
function same(left: unknown, right: unknown): boolean {
  return extensionCanonicalJson(left) === extensionCanonicalJson(right);
}
function outcome(value: unknown): unknown {
  return value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "outcome")?.value
    : undefined;
}
function method<T extends object, K extends keyof T>(owner: T, key: K): T[K] {
  if (owner === null || typeof owner !== "object")
    fail("installed_plugin_extension_host_method_invalid");
  const callback = owner[key];
  if (typeof callback !== "function")
    fail("installed_plugin_extension_host_method_invalid");
  return callback.bind(owner) as T[K];
}
function fail(code: string): never {
  throw new Error(code);
}

function ownFields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    !same(
      Reflect.ownKeys(input)
        .filter((key) => typeof key === "string")
        .sort(),
      [...keys].sort(),
    ) ||
    Reflect.ownKeys(input).some((key) => typeof key !== "string")
  )
    fail("installed_plugin_extension_host_candidate_input_invalid");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    )
      fail("installed_plugin_extension_host_candidate_input_invalid");
    result[key] = descriptor.value;
  }
  return result;
}

function candidateSignal(
  options: Readonly<{ signal?: AbortSignal }> | undefined,
): AbortSignal | undefined {
  if (options === undefined) return undefined;
  const keys = Reflect.ownKeys(options);
  if (keys.length === 0) {
    ownFields(options, []);
    return undefined;
  }
  const value = ownFields(options, ["signal"]);
  if (value.signal === undefined) return undefined;
  if (!(value.signal instanceof AbortSignal))
    fail("installed_plugin_extension_host_candidate_input_invalid");
  return value.signal;
}
