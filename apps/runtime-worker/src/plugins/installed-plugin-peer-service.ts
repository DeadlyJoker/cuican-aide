import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ApplicationError,
  loadPluginQuerySource,
  type ActorContext,
  type ExtensionRegistration,
  type PluginQuerySource,
} from "@crewon/application";
import {
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  parseInstalledPluginPeerRequest,
  parseInstalledPluginPeerResponse,
  type InstalledPluginPeerIdentity,
  type InstalledPluginPeerRequest,
  type InstalledPluginPeerResponse,
} from "@crewon/contracts/plugins";
import {
  extensionCanonicalJson,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionRunBinding,
  parsePluginProfileScope,
  parsePluginSelection,
  parsePluginTaskAdmission,
  type PluginProfileScope,
} from "@crewon/domain";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { StoreBackedAgentVersionRuntimeResolver } from "../store-backed-agent-version-runtime-resolver.ts";
import {
  assertLoadedInstalledPluginRelease,
  type LoadedInstalledPluginRelease,
} from "./installed-plugin-release-loader.ts";
import type { InstalledPluginReleaseEntry } from "./installed-plugin-release-document.ts";
import {
  assertInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
  type InstalledPluginBusinessRegistration,
} from "./installed-plugin-business-registration.ts";
import {
  InstalledPluginExtensionHost,
  type InstalledPluginExtensionHostDependencies,
} from "./installed-plugin-extension-host.ts";
import { InstalledPluginQueryHost } from "./installed-plugin-query-host.ts";
import type { InstalledPluginExecutionReadinessPort } from "./installed-plugin-execution-readiness-types.ts";
import {
  captureInstalledPluginExecutionConfig,
  type InstalledPluginExecutionConfig,
} from "./installed-plugin-runtime-composition.ts";

export type InstalledPluginPeerServiceDependencies = Readonly<{
  release: LoadedInstalledPluginRelease;
  store: SqliteRunStore | PostgresDomainStore;
  runtimeResolver: StoreBackedAgentVersionRuntimeResolver;
  execution: InstalledPluginExecutionConfig;
  resolveProfile: InstalledPluginExtensionHostDependencies["resolveProfile"];
  executionReadiness?: InstalledPluginExecutionReadinessPort;
}>;
type Entry = Readonly<{
  entry: InstalledPluginReleaseEntry;
  registration: InstalledPluginBusinessRegistration;
  identity: InstalledPluginPeerIdentity;
}>;
type ScopeHosts = Readonly<{
  scope: PluginProfileScope;
  entries: readonly Entry[];
  generation: InstalledPluginExtensionHost;
  query: InstalledPluginQueryHost;
}>;
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

export class InstalledPluginPeerError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "InstalledPluginPeerError";
    this.code = code;
  }
}

/** Actual installed metadata and same-Store readiness; this peer never creates a task or a payment. */
export class InstalledPluginPeerService {
  readonly #store: SqliteRunStore | PostgresDomainStore;
  readonly #execution: InstalledPluginExecutionConfig;
  readonly #resolveProfile: InstalledPluginExtensionHostDependencies["resolveProfile"];
  readonly #scopes = new Map<string, ScopeHosts>();
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(input: InstalledPluginPeerServiceDependencies) {
    assertLoadedInstalledPluginRelease(input.release);
    if (
      (!(input.store instanceof SqliteRunStore) &&
        !(input.store instanceof PostgresDomainStore)) ||
      !(
        input.runtimeResolver instanceof StoreBackedAgentVersionRuntimeResolver
      ) ||
      typeof input.resolveProfile !== "function"
    )
      fail("configuration_invalid");
    this.#store = input.store;
    this.#execution = captureInstalledPluginExecutionConfig(input.execution);
    this.#resolveProfile = input.resolveProfile.bind(input);
    const groups = new Map<
      string,
      { scope: PluginProfileScope; entries: Entry[] }
    >();
    for (let i = 0; i < input.release.document.entries.length; i++) {
      const entry = input.release.document.entries[i]!;
      const registration = input.release.registrations[i]!;
      assertInstalledPluginBusinessRegistration(registration);
      if (!isDeepStrictEqual(registration.identity, entry.packageIdentity))
        fail("identity_invalid");
      const identity = Object.freeze({
        ...registration.identity,
        manifestDigest: registration.manifestDigest,
        implementationDigest: registration.implementationDigest,
      });
      const key = scopeKey(entry.scope);
      const group = groups.get(key) ?? { scope: entry.scope, entries: [] };
      group.entries.push(Object.freeze({ entry, registration, identity }));
      groups.set(key, group);
    }
    if (groups.size === 0 || groups.size > 32) fail("configuration_invalid");
    for (const [key, group] of groups) {
      const unique = new Map<string, InstalledPluginBusinessRegistration>();
      for (const row of group.entries)
        unique.set(extensionCanonicalJson(row.identity), row.registration);
      const common = {
        scope: group.scope,
        installRoot: this.#execution.installRoot,
        installations: input.store.pluginInstallationStore(),
        authorization: this.#execution.authorization,
        resolveActor: this.#execution.resolveActor,
        resolveProfile: this.#resolveProfile,
        authorizePackage: this.#execution.authorizePackage,
        runtimeResolver: input.runtimeResolver,
        deployments: input.store,
        ...(input.executionReadiness === undefined
          ? {}
          : { executionReadiness: input.executionReadiness }),
      };
      this.#scopes.set(
        key,
        Object.freeze({
          scope: group.scope,
          entries: Object.freeze(group.entries),
          generation: new InstalledPluginExtensionHost({
            ...common,
            configurations: input.store.extensionStore(),
            registrations: [...unique.values()],
            maximumPackages: unique.size,
          }),
          query: new InstalledPluginQueryHost({
            ...common,
            extensions: input.store.extensionStore(),
            runs: input.store,
            operations: input.store.externalOperationStore(),
          }),
        }),
      );
    }
  }

  handle(
    input: unknown,
    requestSignal: AbortSignal,
  ): Promise<InstalledPluginPeerResponse> {
    if (this.#closed)
      return Promise.reject(
        new InstalledPluginPeerError("installed_plugin_peer_closed"),
      );
    const request = parseInstalledPluginPeerRequest(input);
    const signal = AbortSignal.any([requestSignal, this.#lifetime.signal]);
    // Register the physical Promise before any injected authority callback can
    // reenter close. A logical request cancellation never drops this ownership.
    const work = Promise.resolve()
      .then(() => this.#handle(request, signal))
      .catch((error: unknown) => {
        if (
          error instanceof ApplicationError &&
          error.category === "authorization"
        )
          fail("authorization_denied", error);
        if (
          error instanceof Error &&
          /(?:identity_invalid|profile_invalid|forbidden|authorization_denied|access_revoked|selection_invalid)$/u.test(
            error.message,
          )
        )
          fail("authorization_denied", error);
        throw error;
      })
      .finally(() => this.#pending.delete(work));
    this.#pending.add(work);
    return work;
  }

  async #handle(
    request: InstalledPluginPeerRequest,
    signal: AbortSignal,
  ): Promise<InstalledPluginPeerResponse> {
    const hosts = this.#scopes.get(scopeKey(request.scope));
    if (hosts === undefined) fail("scope_invalid");
    await this.#current(request.actor, hosts.scope, signal);
    const response = {
      protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
      requestId: request.requestId,
      operation: request.operation,
      actor: request.actor,
      scope: hosts.scope,
    };
    if (request.operation === "catalog") {
      const entries = [];
      for (const row of hosts.entries) {
        const facts = await this.#catalogFacts(
          hosts.scope,
          row.identity.pluginId,
        );
        signal.throwIfAborted();
        if (facts === null) continue;
        const { selection, activation, configuration } = facts;
        if (
          !isDeepStrictEqual(scopeOf(selection), hosts.scope) ||
          selection.pluginId !== row.identity.pluginId ||
          selection.publisherId !== row.identity.publisherId
        )
          fail("identity_invalid");
        if (
          selection.state !== "enabled" ||
          selection.selectedPackageDigest !== row.identity.packageDigest
        )
          continue;
        const activatedRow =
          activation?.state === "enabled" && activation.target !== null
            ? hosts.entries.find(
                (candidate) =>
                  isDeepStrictEqual(
                    candidate.entry.configuration,
                    configuration,
                  ) &&
                  isDeepStrictEqual(candidate.entry.target, activation.target),
              )
            : undefined;
        if (
          activatedRow !== undefined &&
          isDeepStrictEqual(activatedRow.identity, row.identity) &&
          (configuration === null ||
            !isDeepStrictEqual(activation!.target, row.entry.target) ||
            !isDeepStrictEqual(configuration, row.entry.configuration) ||
            activation!.configurationDigest !== configuration.contentDigest)
        )
          continue;
        await hosts.generation.validateConfiguration({
          actor: request.actor,
          registration: project(row.registration),
          configuration: row.entry.configuration,
        });
        signal.throwIfAborted();
        if (
          !isDeepStrictEqual(
            facts,
            await this.#catalogFacts(hosts.scope, row.identity.pluginId),
          )
        )
          fail("source_changed");
        entries.push({
          identity: row.identity,
          manifest: row.registration.manifest,
          configuration: row.entry.configuration,
          configuredTarget: row.entry.target,
        });
      }
      await this.#current(request.actor, hosts.scope, signal);
      return parseInstalledPluginPeerResponse({ ...response, entries });
    }
    if (
      request.operation === "validateConfiguration" ||
      request.operation === "readiness" ||
      request.operation === "prepareCandidate"
    ) {
      const rows = hosts.entries.filter((row) =>
        isDeepStrictEqual(row.identity, request.identity),
      );
      const row =
        request.operation !== "validateConfiguration"
          ? rows.find(
              (row) =>
                isDeepStrictEqual(row.entry.target, request.expectedTarget) &&
                isDeepStrictEqual(
                  row.entry.configuration,
                  request.configuration,
                ),
            )
          : rows[0];
      if (row === undefined) fail("identity_invalid");
      const configuration = validateInstalledPluginConfiguration(
        row.registration,
        request.configuration,
      );
      if (request.operation === "validateConfiguration") {
        await hosts.generation.validateConfiguration({
          actor: request.actor,
          registration: project(row.registration),
          configuration,
        });
        await this.#current(request.actor, hosts.scope, signal);
        return parseInstalledPluginPeerResponse({
          ...response,
          identity: row.identity,
          configurationDigest: configuration.contentDigest,
        });
      }
      const readinessInput = {
        actor: request.actor,
        registration: project(row.registration),
        configuration,
        agentVersionId: row.entry.target.agentVersionId,
      };
      if (request.operation === "prepareCandidate")
        await this.#current(request.actor, hosts.scope, signal);
      const result =
        request.operation === "prepareCandidate"
          ? await hosts.generation.prepareCandidate(
              {
                ...readinessInput,
                expectedSelectionRevision: request.expectedSelectionRevision,
              },
              { signal },
            )
          : await hosts.generation.evaluate(readinessInput);
      if (
        result.outcome === "ready" &&
        !isDeepStrictEqual(result.target, request.expectedTarget)
      )
        fail("target_mismatch");
      // The candidate host's last actual facts check includes actor/profile and
      // its fixed selection/configuration/deployment. No identity await may
      // follow its final factory borrow and create a new metadata race window.
      if (request.operation === "prepareCandidate") signal.throwIfAborted();
      else await this.#current(request.actor, hosts.scope, signal);
      return parseInstalledPluginPeerResponse({
        ...response,
        identity: row.identity,
        configurationDigest: configuration.contentDigest,
        expectedTarget: request.expectedTarget,
        ...(request.operation === "prepareCandidate"
          ? { expectedSelectionRevision: request.expectedSelectionRevision }
          : {}),
        result,
      });
    }
    const expectedSource: PluginQuerySource = {
      admission: parsePluginTaskAdmission(request.expectedSource.admission),
      binding: parseExtensionRunBinding(
        request.expectedSource.binding,
        digester,
      ),
      operationId: request.expectedSource.operationId,
    };
    if (!isDeepStrictEqual(scopeOf(expectedSource.admission), hosts.scope))
      fail("scope_invalid");
    const actualSource = await loadPluginQuerySource({
      actor: request.actor,
      pluginId: expectedSource.admission.pluginId,
      profileId: hosts.scope.profileId,
      publisherId: expectedSource.admission.publisherId,
      sourceRunId: expectedSource.binding.runId,
      operationId: expectedSource.operationId,
      extensions: this.#store.extensionStore(),
      runs: this.#store,
      operations: this.#store.externalOperationStore(),
      authorization: this.#execution.authorization,
      digester,
    });
    signal.throwIfAborted();
    if (!isDeepStrictEqual(actualSource, expectedSource))
      fail("source_changed");
    const registration = await hosts.query.resolveRegistration({
      actor: request.actor,
      source: actualSource,
    });
    signal.throwIfAborted();
    const identity =
      registration === null
        ? null
        : {
            pluginId: actualSource.admission.pluginId,
            publisherId: actualSource.admission.publisherId,
            version: actualSource.admission.version,
            packageDigest: actualSource.admission.packageDigest,
            manifestDigest: registration.manifestDigest,
            implementationDigest: registration.implementationDigest,
          };
    if (request.operation === "queryResolveRegistration") {
      await this.#current(request.actor, hosts.scope, signal);
      return parseInstalledPluginPeerResponse({
        ...response,
        expectedSource: actualSource,
        registration:
          registration === null
            ? null
            : { identity, manifest: registration.manifest },
      });
    }
    if (
      identity === null ||
      registration === null ||
      !isDeepStrictEqual(identity, request.identity)
    )
      fail("identity_invalid");
    // A historical observation may use an unselected original package. A Node
    // readiness borrower still needs its exact immutable materialization in this
    // actual release; catalog metadata or a latest-version substitution is insufficient.
    const row = hosts.entries.find(
      (row) =>
        isDeepStrictEqual(row.identity, identity) &&
        isDeepStrictEqual(row.entry.configuration, request.configuration) &&
        isDeepStrictEqual(row.entry.target, request.expectedTarget),
    );
    const result =
      row === undefined
        ? {
            outcome: "unavailable" as const,
            reasonCode: "extension_runtime_unavailable" as const,
          }
        : await hosts.query.evaluate({
            actor: request.actor,
            source: actualSource,
            registration,
            configuration: validateInstalledPluginConfiguration(
              row.registration,
              request.configuration,
            ),
            expectedTarget: row.entry.target,
          });
    if (
      result.outcome === "ready" &&
      !isDeepStrictEqual(result.target, request.expectedTarget)
    )
      fail("target_mismatch");
    await this.#current(request.actor, hosts.scope, signal);
    return parseInstalledPluginPeerResponse({
      ...response,
      expectedSource: actualSource,
      identity,
      configurationDigest: request.configuration.contentDigest,
      expectedTarget: request.expectedTarget,
      result,
    });
  }

  async #current(
    actor: ActorContext,
    scope: PluginProfileScope,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const actual = await this.#execution.resolveActor(
      {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        actorId: actor.actorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!isDeepStrictEqual(actual, actor)) fail("identity_invalid");
    const current = await this.#resolveProfile(actor, signal);
    signal.throwIfAborted();
    if (
      current === null ||
      !isDeepStrictEqual(parsePluginProfileScope(current), scope) ||
      actor.tenantId !== scope.tenantId ||
      actor.spaceId !== scope.spaceId
    )
      fail("scope_invalid");
  }

  async #catalogFacts(scope: PluginProfileScope, pluginId: string) {
    const selected = await this.#store
      .pluginInstallationStore()
      .loadSelection({ scope, pluginId });
    const extensions = this.#store.extensionStore();
    const locator = {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId,
    };
    const active = await extensions.loadExtensionActivation(locator);
    if (selected === null) return null;
    const selection = parsePluginSelection(selected);
    if (active === null)
      return { selection, activation: null, configuration: null };
    const activation = parseExtensionActivation(active);
    const configured = await extensions.loadExtensionConfiguration({
      ...locator,
      revision: activation.configurationRevision,
    });
    if (configured === null) return null;
    const configuration = parseExtensionConfiguration(configured, digester);
    if (
      activation.tenantId !== scope.tenantId ||
      activation.spaceId !== scope.spaceId ||
      activation.pluginId !== pluginId ||
      configuration.tenantId !== scope.tenantId ||
      configuration.spaceId !== scope.spaceId ||
      configuration.pluginId !== pluginId
    )
      fail("identity_invalid");
    return { selection, activation, configuration };
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.#closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.#closed = true;
    this.#lifetime.abort(
      new InstalledPluginPeerError("installed_plugin_peer_closed"),
    );
    // Start actual host shutdown synchronously before joining callers that borrow
    // those hosts. Request deadlines alone cannot cancel their private signals.
    const cleanup = [...this.#scopes.values()].flatMap((scope) => [
      scope.generation.close(),
      scope.query.close(),
    ]);
    void (async () => {
      await Promise.allSettled([...this.#pending]);
      const results = await Promise.allSettled(cleanup);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          "installed_plugin_peer_cleanup_failed",
        );
    })().then(resolve, reject);
    return this.#closing;
  }
}
function scopeKey(scope: PluginProfileScope): string {
  return extensionCanonicalJson(parsePluginProfileScope(scope));
}
function scopeOf(input: PluginProfileScope): PluginProfileScope {
  return {
    tenantId: input.tenantId,
    spaceId: input.spaceId,
    profileId: input.profileId,
  };
}
function project(registration: ExtensionRegistration): ExtensionRegistration {
  return Object.freeze({
    manifest: registration.manifest,
    manifestDigest: registration.manifestDigest,
    implementationDigest: registration.implementationDigest,
  });
}
function fail(code: string, cause?: unknown): never {
  throw new InstalledPluginPeerError(
    `installed_plugin_peer_${code}`,
    cause === undefined ? undefined : { cause },
  );
}
