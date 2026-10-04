import {
  ApplicationError,
  type ActorContext,
  type AuthorizationDecision,
  type ExtensionHostPort,
  type ExtensionReadiness,
  type PluginInstallationPrepareSelectionInput,
} from "@crewon/application";
import { createHash } from "node:crypto";
import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  parseExtensionConfiguration,
  type ExtensionConfiguration,
  type PluginSelection,
} from "@crewon/domain";
import {
  capturePluginUiHostServiceAvailability,
  loadInstalledPluginBusinessRegistration,
  validateInstalledPluginConfiguration,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import {
  parsePluginUiJsonValue,
  type DesktopInstalledPluginActivationConfiguration,
} from "@crewon/contracts/plugins";
import {
  assertDesktopInstalledPluginActivationConfigCurrent,
  type DesktopInstalledPluginActivationConfig,
} from "./desktop-installed-plugin-activation-environment.ts";
import { DesktopInstalledPluginActivationAuthority } from "./desktop-installed-plugin-activation-authority.ts";
import { DesktopNativePluginActivationAuthority } from "./desktop-native-plugin-activation-authority.ts";
import {
  assertDesktopNativePluginControlConfigCurrent,
  isDesktopNativePluginControlConfig,
  type DesktopNativePluginControlConfig,
} from "./desktop-native-plugin-control-environment.ts";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import {
  parseDesktopPluginConfiguration,
  type DesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import {
  assertDesktopPluginSourceRegistry,
  type DesktopPluginSourceRegistry,
} from "./desktop-plugin-source-registry.ts";
import {
  assertDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import {
  InstalledPluginPeerClient,
  type InstalledPluginPeerPrepared,
} from "./installed-plugin-peer-client.ts";
import { installedPeerOwnRecord } from "./installed-plugin-peer-transport.ts";
import { pluginSecurityActor } from "./plugin-security-validation.ts";
import { verifyDesktopInstalledPackage } from "./desktop-plugin-runtime-support.ts";

type Entry = Omit<
  DesktopInstalledPluginActivationConfiguration["entries"][number],
  "configuration"
> &
  Readonly<{ configuration: ExtensionConfiguration }>;
const digester = Object.freeze({
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
});
type OwnerDependencies = Readonly<{
  configuration: DesktopPluginConfiguration;
  activation: DesktopPluginActivationConfig;
  registry: DesktopPluginSourceRegistry;
  authority: DesktopPluginAuthority;
  installation: DesktopPluginInstallationRuntime;
  store: SqliteRunStore;
}>;
export type DesktopPluginActivationConfig =
  | DesktopInstalledPluginActivationConfig
  | DesktopNativePluginControlConfig;
export type DesktopPreparedBusinessCandidate = Readonly<{
  refreshBeforeSelectionCommit(signal: AbortSignal): Promise<void>;
  assertBeforeSelectionCommit(selection: PluginSelection): void;
  assertBeforePublication(
    selection: PluginSelection,
    signal: AbortSignal,
  ): Promise<void>;
}>;
const owners = new WeakSet<object>();

/** A preparation remains owned by the actual native profile and exact published business tuple. */
export class DesktopInstalledPluginActivationOwner {
  readonly #dependencies: OwnerDependencies;
  readonly #hostUiServices: PluginUiHostServiceAvailabilityPort | undefined;
  readonly #peer: InstalledPluginPeerClient;
  readonly #policy:
    | DesktopInstalledPluginActivationAuthority
    | DesktopNativePluginActivationAuthority;
  readonly #entries: readonly Entry[];
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | null = null;
  constructor(
    input: OwnerDependencies,
    transports: Readonly<{
      fetch?: typeof globalThis.fetch;
      hostUiServices?: PluginUiHostServiceAvailabilityPort;
    }> = {},
  ) {
    assertActivation(input.activation);
    const configuration = parseDesktopPluginConfiguration(input.configuration);
    assertDesktopPluginSourceRegistry(input.registry, configuration);
    assertDesktopPluginInstallationRuntime(input.installation, {
      configuration,
      registry: input.registry,
      authority: input.authority,
      store: input.store,
    });
    if (
      !(input.store instanceof SqliteRunStore) ||
      !(input.authority instanceof DesktopPluginAuthority)
    )
      denied();
    const publication = input.activation.publication;
    if (
      !same(publication.actor, configuration.actor) ||
      !same(publication.scope, configuration.scope) ||
      publication.installRoot !== configuration.installRoot ||
      publication.entries.some(
        (entry) =>
          !configuration.sources.some(
            (source) =>
              source.pluginId === entry.identity.pluginId &&
              source.publisherId === entry.identity.publisherId &&
              source.version === entry.identity.version &&
              source.packageDigest === entry.identity.packageDigest,
          ),
      )
    )
      denied();
    this.#dependencies = Object.freeze({ ...input, configuration });
    this.#hostUiServices = capturePluginUiHostServiceAvailability(
      transports.hostUiServices,
    );
    this.#entries = Object.freeze(
      publication.entries.map((entry) => {
        const compiled = parseExtensionConfiguration(
          entry.configuration,
          digester,
        );
        if (
          compiled.tenantId !== configuration.scope.tenantId ||
          compiled.spaceId !== configuration.scope.spaceId ||
          compiled.pluginId !== entry.identity.pluginId ||
          compiled.pluginVersion !== entry.identity.version ||
          compiled.manifestDigest !== entry.identity.manifestDigest ||
          compiled.implementationDigest !== entry.identity.implementationDigest
        )
          denied();
        return Object.freeze({ ...entry, configuration: compiled });
      }),
    );
    this.#peer = new InstalledPluginPeerClient(
      {
        origin: publication.peer.origin,
        token: input.activation.peerToken,
        deadlineMs: publication.timeoutMs,
        maximumRequests: 128,
      },
      { fetch: transports.fetch },
    );
    this.#policy = isDesktopNativePluginControlConfig(input.activation)
      ? new DesktopNativePluginActivationAuthority(input.activation)
      : new DesktopInstalledPluginActivationAuthority(input.activation, {
          fetch: transports.fetch,
        });
    this.#assertOwner(configuration.actor);
    owners.add(this);
  }
  assertBinding(
    input: Pick<
      OwnerDependencies,
      "configuration" | "registry" | "authority" | "installation" | "store"
    >,
  ): void {
    if (
      !owners.has(this) ||
      input.installation !== this.#dependencies.installation ||
      input.registry !== this.#dependencies.registry ||
      input.authority !== this.#dependencies.authority ||
      input.store !== this.#dependencies.store ||
      !same(input.configuration, this.#dependencies.configuration)
    )
      denied();
    this.#assertOwner(input.configuration.actor);
  }
  readonly peer = Object.freeze({
    prepare: (
      input: Parameters<InstalledPluginPeerClient["prepare"]>[0],
      options: Parameters<InstalledPluginPeerClient["prepare"]>[1] = {},
    ): Promise<InstalledPluginPeerPrepared> =>
      this.#operation(options.signal, async (signal) => {
        this.#assertOwner(input.actor);
        if (!same(input.scope, this.#dependencies.configuration.scope))
          denied();
        const result = await this.#peer.prepare(input, { signal });
        this.#assertOwner(input.actor);
        return this.#prepared(result, signal);
      }),
  });
  /** Borrowing the peer requires this exact issued activation configuration; it lends no task permission. */
  assertTaskPeerBorrow(
    input: Pick<
      OwnerDependencies,
      | "configuration"
      | "registry"
      | "authority"
      | "installation"
      | "store"
      | "activation"
    >,
  ): void {
    if (input.activation !== this.#dependencies.activation) denied();
    this.assertBinding(input);
  }
  authorizeActivate(
    actor: ActorContext,
    pluginId: string,
    signal: AbortSignal,
  ): Promise<AuthorizationDecision> {
    return this.#operation(signal, async (current) => {
      const entry = this.#entry(pluginId);
      await this.#facts(actor, entry, current);
      const decision = await this.#policy.decide({ actor, pluginId }, current);
      await this.#facts(actor, entry, current);
      return decision;
    });
  }
  prepareSelection(
    input: PluginInstallationPrepareSelectionInput,
    signal: AbortSignal,
  ): Promise<DesktopPreparedBusinessCandidate | null> {
    return this.#operation(signal, async (current) => {
      this.#assertOwner(input.actor);
      if (!same(input.scope, this.#dependencies.configuration.scope)) denied();
      if (input.nextSelection.state !== "enabled" || input.package === null)
        return null;
      const descriptor = await verifyDesktopInstalledPackage({
        installRoot: this.#dependencies.configuration.installRoot,
        package: input.package,
        registry: this.#dependencies.registry,
        signal: current,
        ...(this.#hostUiServices === undefined
          ? {}
          : { hostUiServices: this.#hostUiServices }),
      });
      this.#assertOwner(input.actor);
      if (descriptor.businessManifestPath === null) return null;
      const entry = this.#entry(input.package.pluginId);
      const before = await this.#facts(input.actor, entry, current);
      if (
        input.currentSelection === null ||
        input.currentSelection.state !== "disabled" ||
        !same(before.selection, input.currentSelection) ||
        !same(before.package, input.package) ||
        input.nextSelection.selectedPackageDigest !==
          input.package.packageDigest
      )
        conflict("desktop_plugin_candidate_selection_changed");
      const permission = await this.#policy.decide(
        { actor: input.actor, pluginId: entry.identity.pluginId },
        current,
      );
      if (permission.outcome !== "allow") denied();
      await this.#unchanged(input.actor, entry, before.selection, current);
      let readiness: ExtensionReadiness;
      try {
        readiness = await this.#peer.prepareCandidate(
          {
            actor: input.actor,
            scope: input.scope,
            identity: entry.identity,
            configuration: entry.configuration,
            expectedTarget: entry.target,
            expectedSelectionRevision: input.currentSelection.revision,
          },
          { signal: current },
        );
      } catch (error) {
        // A peer can reject a stale release before returning readiness. Preserve its
        // failure unless the actual Native facts independently prove a conflict.
        await this.#unchanged(input.actor, entry, before.selection, current);
        throw error;
      }
      await this.#unchanged(input.actor, entry, before.selection, current);
      if (readiness.outcome !== "ready") conflict(readiness.reasonCode);
      if (!same(readiness.target, entry.target))
        conflict("extension_execution_target_mismatch");
      const permissionAfterIo = await this.#policy.decide(
        { actor: input.actor, pluginId: entry.identity.pluginId },
        current,
      );
      if (permissionAfterIo.outcome !== "allow") denied();
      await this.#unchanged(input.actor, entry, before.selection, current);
      let commitPrepared = false;
      // The final publication still rechecks the real current owner, bytes, configuration and decision.
      return Object.freeze({
        refreshBeforeSelectionCommit: (nextSignal: AbortSignal) =>
          this.#operation(nextSignal, async (active) => {
            commitPrepared = false;
            await this.#unchanged(input.actor, entry, before.selection, active);
            const final = await this.#policy.decide(
              { actor: input.actor, pluginId: entry.identity.pluginId },
              active,
            );
            if (final.outcome !== "allow") denied();
            await this.#unchanged(input.actor, entry, before.selection, active);
            commitPrepared = true;
          }),
        assertBeforeSelectionCommit: (selection: PluginSelection) => {
          if (!commitPrepared || !same(selection, input.nextSelection))
            denied();
          commitPrepared = false;
          this.#syncUnchanged(
            input.actor,
            entry,
            before.selection,
            before.package,
          );
        },
        assertBeforePublication: (
          selection: PluginSelection,
          nextSignal: AbortSignal,
        ) =>
          this.#operation(nextSignal, async (active) => {
            if (!same(selection, input.nextSelection)) denied();
            await this.#unchanged(input.actor, entry, selection, active);
            const final = await this.#policy.decide(
              { actor: input.actor, pluginId: entry.identity.pluginId },
              active,
            );
            if (final.outcome !== "allow") denied();
            await this.#unchanged(input.actor, entry, selection, active);
          }),
      });
    });
  }
  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#lifetime.abort();
    const peer = this.#peer.close(),
      policy = this.#policy.close();
    return (this.#closing = Promise.allSettled([
      peer,
      policy,
      ...this.#pending,
    ]).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          "desktop_plugin_activation_cleanup_failed",
        );
    }));
  }
  #entry(pluginId: string): Entry {
    const found = this.#entries.filter(
      (entry) => entry.identity.pluginId === pluginId,
    );
    if (found.length !== 1) denied();
    return found[0]!;
  }
  #prepared(
    prepared: InstalledPluginPeerPrepared,
    signal: AbortSignal,
  ): InstalledPluginPeerPrepared {
    return Object.freeze({
      ...prepared,
      host: Object.freeze({
        ...prepared.host,
        evaluate: (input: Parameters<ExtensionHostPort["evaluate"]>[0]) =>
          this.#operation(signal, async (current) => {
            const fields = installedPeerOwnRecord(input, [
              "actor",
              "registration",
              "configuration",
              "agentVersionId",
            ]);
            const actor = pluginSecurityActor(fields.actor);
            const configuration = parseExtensionConfiguration(
              parsePluginUiJsonValue(fields.configuration),
              digester,
            );
            const entry = this.#entry(configuration.pluginId);
            await this.#facts(actor, entry, current);
            if (!same(configuration, entry.configuration))
              conflict("desktop_plugin_candidate_configuration_changed");
            const registration = prepared.catalog.resolve(configuration);
            if (
              registration === null ||
              !same(parsePluginUiJsonValue(fields.registration), registration)
            )
              conflict("extension_implementation_unavailable");
            // This is an authorized Native activation of a real published release,
            // so another valid Agent version is a business conflict, not bad wire.
            if (fields.agentVersionId !== entry.target.agentVersionId)
              conflict("extension_execution_target_mismatch");
            const result = await prepared.host.evaluate(input);
            await this.#facts(actor, entry, current);
            return result;
          }),
      }),
    });
  }
  #assertOwner(actorInput: ActorContext): void {
    this.#lifetime.signal.throwIfAborted();
    assertActivation(this.#dependencies.activation);
    const actor = pluginSecurityActor(actorInput);
    this.#dependencies.authority.assertScope(
      actor,
      this.#dependencies.configuration.scope,
    );
    assertActivation(this.#dependencies.activation);
    this.#dependencies.installation.assertProfileOwnership(actor);
    this.#dependencies.authority.assertScope(
      actor,
      this.#dependencies.configuration.scope,
    );
    this.#lifetime.signal.throwIfAborted();
  }
  #assertSelectionCommitOwner(actorInput: ActorContext): void {
    this.#lifetime.signal.throwIfAborted();
    assertActivation(this.#dependencies.activation);
    const actor = pluginSecurityActor(actorInput);
    this.#dependencies.authority.assertScope(
      actor,
      this.#dependencies.configuration.scope,
    );
    this.#dependencies.installation.assertProfileOwnershipForSelectionCommit(
      actor,
    );
    this.#dependencies.authority.assertScope(
      actor,
      this.#dependencies.configuration.scope,
    );
    assertActivation(this.#dependencies.activation);
    this.#lifetime.signal.throwIfAborted();
  }
  async #facts(actor: ActorContext, entry: Entry, signal: AbortSignal) {
    signal.throwIfAborted();
    this.#assertOwner(actor);
    const scope = this.#dependencies.configuration.scope;
    const ledger = this.#dependencies.store.pluginInstallationStore();
    const rawSelection = await ledger.loadSelection({
      scope,
      pluginId: entry.identity.pluginId,
    });
    if (rawSelection === null)
      conflict("desktop_plugin_candidate_selection_changed");
    const selection = parsePluginSelection(rawSelection);
    if (
      (selection.state !== "disabled" && selection.state !== "enabled") ||
      selection.selectedPackageDigest !== entry.identity.packageDigest
    )
      conflict("desktop_plugin_candidate_selection_changed");
    const rawPackage = await ledger.loadPackage({
      scope,
      packageDigest: entry.identity.packageDigest,
    });
    if (rawPackage === null)
      conflict("desktop_plugin_candidate_package_changed");
    const pkg = parseInstalledPluginPackage(rawPackage);
    if (
      !same(
        {
          tenantId: pkg.tenantId,
          spaceId: pkg.spaceId,
          profileId: pkg.profileId,
        },
        scope,
      ) ||
      pkg.pluginId !== entry.identity.pluginId ||
      pkg.publisherId !== entry.identity.publisherId ||
      pkg.version !== entry.identity.version
    )
      denied();
    const registration = await loadInstalledPluginBusinessRegistration({
      installRoot: this.#dependencies.configuration.installRoot,
      expectedPluginId: pkg.pluginId,
      expectedPublisherId: pkg.publisherId,
      expectedVersion: pkg.version,
      expectedPackageDigest: pkg.packageDigest,
      signal,
      authorizeRead: async (candidate, current) => {
        current.throwIfAborted();
        this.#assertOwner(actor);
        return this.#dependencies.registry.authorizeCandidate(candidate);
      },
    });
    if (
      !same(
        {
          ...registration.identity,
          manifestDigest: registration.manifestDigest,
          implementationDigest: registration.implementationDigest,
        },
        entry.identity,
      )
    )
      conflict("desktop_plugin_candidate_package_changed");
    const latest = await this.#dependencies.store
      .extensionStore()
      .loadLatestExtensionConfiguration({
        tenantId: scope.tenantId,
        spaceId: scope.spaceId,
        pluginId: pkg.pluginId,
      });
    if (!same(latest, entry.configuration))
      conflict("desktop_plugin_candidate_configuration_changed");
    validateInstalledPluginConfiguration(registration, entry.configuration);
    signal.throwIfAborted();
    this.#assertOwner(actor);
    this.#syncUnchanged(actor, entry, selection, pkg);
    return Object.freeze({ selection, package: pkg });
  }
  async #unchanged(
    actor: ActorContext,
    entry: Entry,
    selection: PluginSelection,
    signal: AbortSignal,
  ): Promise<void> {
    const facts = await this.#facts(actor, entry, signal);
    if (!same(facts.selection, selection))
      conflict("desktop_plugin_candidate_selection_changed");
  }
  #syncUnchanged(
    actor: ActorContext,
    entry: Entry,
    selection: PluginSelection,
    pkg: ReturnType<typeof parseInstalledPluginPackage>,
  ): void {
    this.#assertSelectionCommitOwner(actor);
    const scope = this.#dependencies.configuration.scope;
    const ledger = this.#dependencies.store.pluginInstallationStore();
    const currentSelection = ledger.currentSelection({
      scope,
      pluginId: entry.identity.pluginId,
    });
    const currentPackage = ledger.currentPackage({
      scope,
      packageDigest: entry.identity.packageDigest,
    });
    const latest = this.#dependencies.store
      .extensionStore()
      .currentLatestExtensionConfiguration({
        tenantId: scope.tenantId,
        spaceId: scope.spaceId,
        pluginId: entry.identity.pluginId,
      });
    if (!same(currentSelection, selection))
      conflict("desktop_plugin_candidate_selection_changed");
    if (!same(currentPackage, pkg))
      conflict("desktop_plugin_candidate_package_changed");
    if (!same(latest, entry.configuration))
      conflict("desktop_plugin_candidate_configuration_changed");
    const locator = {
      tenantId: scope.tenantId,
      agentVersionId: entry.target.agentVersionId,
    };
    const asset = this.#dependencies.store.currentAgentVersion(locator);
    const deployment =
      this.#dependencies.store.currentAgentVersionDeployment(locator);
    if (asset === null || deployment === null)
      conflict("extension_execution_target_mismatch");
    let definition: Record<string, unknown>;
    try {
      definition = JSON.parse(asset.definitionJson) as Record<string, unknown>;
    } catch {
      conflict("extension_execution_target_mismatch");
    }
    if (
      entry.target.executionAuthority !== "crewonKernel" ||
      asset.contentDigest !== entry.target.agentVersionContentDigest ||
      deployment.agentVersionId !== entry.target.agentVersionId ||
      deployment.contentDigest !== entry.target.agentVersionContentDigest ||
      deployment.materializationDigest !== entry.target.materializationDigest ||
      deployment.authorityId !== entry.target.authorityId ||
      deployment.workspaceBindingId !== entry.target.workspaceBindingId ||
      definition?.agentVersionId !== entry.target.agentVersionId ||
      definition?.runtimeGeneration !== entry.target.runtimeGeneration ||
      definition?.policySnapshotId !== entry.target.policySnapshotId
    )
      conflict("extension_execution_target_mismatch");
    this.#assertSelectionCommitOwner(actor);
  }
  #operation<T>(
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.#lifetime.signal.throwIfAborted();
    if (signal !== undefined && !(signal instanceof AbortSignal)) denied();
    if (this.#pending.size >= 128) conflict("desktop_plugin_activation_busy");
    const current = AbortSignal.any([
      this.#lifetime.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    current.throwIfAborted();
    const physical = Promise.resolve().then(() => {
      current.throwIfAborted();
      return work(current);
    });
    this.#pending.add(physical);
    void physical.finally(() => this.#pending.delete(physical)).catch(() => {});
    return physical;
  }
}
function same(a: unknown, b: unknown) {
  return extensionCanonicalJson(a) === extensionCanonicalJson(b);
}
function assertActivation(value: DesktopPluginActivationConfig): void {
  if (isDesktopNativePluginControlConfig(value))
    assertDesktopNativePluginControlConfigCurrent(value);
  else assertDesktopInstalledPluginActivationConfigCurrent(value);
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_plugin_activation_authority_denied",
  );
}
function conflict(code: string): never {
  throw new ApplicationError("conflict", code);
}
