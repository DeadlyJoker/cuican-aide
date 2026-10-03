import {
  ApplicationError,
  PluginInstallationApplicationService,
  type ActorContext,
  type ApplicationClock,
  type ContentDigester,
  type PluginInstallationAuthorizationAction,
  type PluginInstallationPrepareSelectionInput,
  type PluginPreparedSelection,
} from "@crewon/application";
import {
  parsePluginProfileScope,
  parsePluginSelection,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import {
  LocalPluginInstallationHost,
  PluginNodeHost,
  assertPluginUiHostServiceAvailability,
  capturePluginUiHostServiceAvailability,
  type PluginActivationCandidate,
  type PluginNodeCommitCandidate,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import type {
  SqlitePluginInstallationStore,
  SqlitePluginInstallationProfileOwner,
} from "@crewon/store";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import type { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import {
  installationSame,
  orderInstallationRecoveries,
  type InstallationRecoveryRecord,
} from "./production-plugin-installation-runtime-support.ts";
import { verifyDesktopInstalledPackage } from "./desktop-plugin-runtime-support.ts";
import type { DesktopPreparedBusinessCandidate } from "./desktop-installed-plugin-activation-owner.ts";
type Method =
  | "install"
  | "select"
  | "getPackage"
  | "getSelection"
  | "listPackages"
  | "listSelections";
type AuthorityRequest = Readonly<{
  actor: ActorContext;
  scope: PluginProfileScope;
  action: PluginInstallationAuthorizationAction;
  pluginId: string | null;
  packageDigest: string | null;
}>;
type Operation = {
  actor: ActorContext;
  scope: PluginProfileScope;
  epoch: string | null;
  stamp: PublicationStamp | null;
};
type PublicationStamp = Readonly<{
  handle: PluginPreparedSelection;
  selection: PluginSelection;
  identity: PluginNodeCommitCandidate["identity"] | null;
  dependencies: PluginNodeCommitCandidate["dependencyIdentities"];
  uiCandidate: PluginActivationCandidate | null;
  epoch: string;
}>;
type ProfileDependencies = Readonly<{
  configuration: DesktopPluginConfiguration;
  registry: DesktopPluginSourceRegistry;
  authority: DesktopPluginAuthority;
  ledger: SqlitePluginInstallationStore;
  clock: ApplicationClock;
  digester: ContentDigester;
  scope: PluginProfileScope;
  hostUiServices?: PluginUiHostServiceAvailabilityPort;
  prepareBusinessCandidate?(
    input: PluginInstallationPrepareSelectionInput,
    signal: AbortSignal,
  ): Promise<DesktopPreparedBusinessCandidate | null>;
}>;

export class DesktopInstallationProfile {
  readonly #dependencies: ProfileDependencies;
  readonly #node = new PluginNodeHost({ services: [] });
  readonly #lifetime = new AbortController();
  #owner!: SqlitePluginInstallationProfileOwner;
  #local!: LocalPluginInstallationHost;
  #application!: PluginInstallationApplicationService;
  #operation: Operation | null = null;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #closed = false;
  #recovered = false;
  #closing: Promise<void> | null = null;

  private constructor(dependencies: ProfileDependencies) {
    this.#dependencies = Object.freeze({
      ...dependencies,
      hostUiServices: capturePluginUiHostServiceAvailability(
        dependencies.hostUiServices,
      ),
    });
  }

  readonly prepareBusinessCandidate = (
    input: PluginInstallationPrepareSelectionInput,
    signal: AbortSignal,
  ): Promise<DesktopPreparedBusinessCandidate | null> =>
    this.#dependencies.prepareBusinessCandidate?.(input, signal) ??
    Promise.resolve(null);

  static async open(
    dependencies: ProfileDependencies,
  ): Promise<DesktopInstallationProfile> {
    const profile = new DesktopInstallationProfile(dependencies);
    try {
      profile.#owner = await dependencies.ledger.acquireProfileOwner({
        scope: dependencies.scope,
        onOwnershipLost: () => {
          profile.withdraw();
          dependencies.authority.withdraw();
        },
      });
      profile.#initialize();
      return profile;
    } catch (error) {
      await profile.#node.close();
      await profile.#owner?.close();
      throw error;
    }
  }

  #initialize(): void {
    const dependencies = this.#dependencies;
    this.#local = new LocalPluginInstallationHost({
      profile: dependencies.scope,
      installRoot: dependencies.configuration.installRoot,
      nodeHost: this.#node,
      hostUiServices: dependencies.hostUiServices,
      resolveSource: async ({ actor, scope, sourceId }) => {
        this.#assertOperation(actor, scope);
        const directory = await dependencies.registry.resolveSource(sourceId);
        this.#available();
        return directory;
      },
      authorizeInstallation: async ({ actor, scope, candidate }) => {
        this.#assertOperation(actor, scope);
        if (dependencies.registry.authorizeCandidate(candidate) !== "allow")
          return "deny";
        await this.#fresh({
          actor,
          scope,
          action: "pluginInstallation:install",
          pluginId: candidate.descriptor.pluginId,
          packageDigest: candidate.packageDigest,
        });
        return "allow";
      },
      authorizeActivation: async ({ actor, scope, candidate }) => {
        this.#assertOperation(actor, scope);
        if (dependencies.registry.authorizeCandidate(candidate) !== "allow")
          return "deny";
        await this.#fresh({
          actor,
          scope,
          action: "pluginInstallation:select",
          pluginId: candidate.descriptor.pluginId,
          packageDigest: candidate.packageDigest,
        });
        return "allow";
      },
      validateCompatibility: async (input) => {
        this.#assertOperation(input.actor, input.scope);
        if (input.descriptor !== null && input.package !== null)
          await verifyDesktopInstalledPackage({
            installRoot: dependencies.configuration.installRoot,
            package: input.package,
            registry: dependencies.registry,
            signal: this.#lifetime.signal,
            hostUiServices: dependencies.hostUiServices,
          });
        if (
          input.nextSelection.state === "enabled" &&
          input.descriptor !== null
        ) {
          if (input.descriptor.entrypoints.node === null)
            this.#checkUiServices({
              descriptor: input.descriptor,
              packageDigest: input.package!.packageDigest,
            });
          else
            for (const requirement of input.descriptor.requires)
              if (
                !requirement.optional &&
                !this.#node
                  .serviceIdentities()
                  .some(
                    (service) =>
                      service.service === requirement.service &&
                      service.apiVersion === requirement.apiVersion,
                  )
              )
                conflict("plugin_dependency_unavailable");
        }
        this.#available();
      },
      authorizeCommit: ({ actor, scope, selection, candidate }) => {
        this.#assertOperation(actor, scope);
        return this.#consume(selection, candidate);
      },
    });
    this.#application = new PluginInstallationApplicationService({
      store: this.#owner.store,
      clock: dependencies.clock,
      digester: dependencies.digester,
      profiles: {
        resolve: async (actor) => {
          this.#assertOperation(actor, dependencies.scope);
          const current = await dependencies.authority.profile(actor);
          this.#available();
          if (!installationSame(current, dependencies.scope))
            denied("plugin_profile_changed");
          return current;
        },
      },
      authorization: {
        authorize: async ({ actor, action, resource }) => {
          this.#assertOperation(actor, resource);
          await this.#fresh({
            actor,
            scope: dependencies.scope,
            action,
            pluginId: resource.pluginId,
            packageDigest: resource.packageDigest,
          });
          return { outcome: "allow" };
        },
      },
      host: {
        install: (input) => this.#local.install(input),
        prepareSelection: (input) => this.#prepare(input),
      },
    });
  }

  run(
    actor: ActorContext,
    method: Method,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    this.#available();
    if (this.#pending >= 32) conflict("plugin_installation_profile_busy");
    this.#pending++;
    const work = this.#tail.then(async () => {
      this.#available();
      const operation: Operation = {
        actor,
        scope: this.#dependencies.scope,
        epoch: null,
        stamp: null,
      };
      this.#operation = operation;
      try {
        const call = this.#application[method] as (
          actor: ActorContext,
          input: unknown,
        ) => Promise<unknown>;
        return await call.call(this.#application, actor, input);
      } finally {
        operation.stamp = null;
        this.#operation = null;
      }
    });
    this.#tail = work.then(
      () => {},
      () => {},
    );
    return work.finally(() => {
      this.#pending--;
    });
  }

  /** Observe the actual held SQLite claim, including its file and directory pins. */
  assertOwnership(actor: ActorContext): void {
    this.#available();
    this.#dependencies.authority.assertScope(actor, this.#dependencies.scope);
    this.#owner.snapshot();
    this.#available();
    this.#dependencies.authority.assertScope(actor, this.#dependencies.scope);
  }

  /** A selection transaction may verify its actual held claim without exposing a pending projection. */
  assertOwnershipForSelectionCommit(actor: ActorContext): void {
    this.#available();
    this.#dependencies.authority.assertScope(actor, this.#dependencies.scope);
    this.#owner.assertOwnership();
    this.#available();
    this.#dependencies.authority.assertScope(actor, this.#dependencies.scope);
  }

  withdraw(): void {
    this.#closed = true;
    this.#lifetime.abort();
    if (this.#operation !== null) this.#operation.stamp = null;
    for (const value of this.#node.snapshot())
      if (value.phase === "accepting")
        this.#node.deactivate(value.identity.pluginId);
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.withdraw();
    return (this.#closing = (async () => {
      await this.#tail;
      const failures: unknown[] = [];
      try {
        await this.#node.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#local?.drain();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#owner.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "plugin_installation_profile_cleanup_failed",
        );
    })());
  }

  #available(): void {
    if (this.#closed) conflict("plugin_installation_profile_unavailable");
    this.#lifetime.signal.throwIfAborted();
  }
  #assertOperation(actor: ActorContext, scope: PluginProfileScope): Operation {
    this.#available();
    const operation = this.#operation;
    const current = parsePluginProfileScope({
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      profileId: scope.profileId,
    });
    if (
      operation === null ||
      !installationSame(operation.actor, actor) ||
      !installationSame(operation.scope, current)
    )
      denied("plugin_installation_operation_mismatch");
    return operation;
  }
  async #fresh(input: AuthorityRequest): Promise<string> {
    const operation = this.#assertOperation(input.actor, input.scope);
    const current = await this.#dependencies.authority.profile(input.actor);
    this.#available();
    if (!installationSame(current, input.scope))
      denied("plugin_profile_changed");
    const before = await this.#dependencies.authority.epoch(input);
    const afterProfile = await this.#dependencies.authority.profile(
      input.actor,
    );
    this.#available();
    if (!installationSame(afterProfile, input.scope))
      denied("plugin_profile_changed");
    const epoch = await this.#dependencies.authority.epoch(input);
    const finalProfile = await this.#dependencies.authority.profile(
      input.actor,
    );
    this.#available();
    if (!installationSame(finalProfile, input.scope))
      denied("plugin_profile_changed");
    if (
      before !== epoch ||
      (operation.epoch !== null && operation.epoch !== epoch)
    )
      denied("plugin_installation_authority_changed");
    operation.epoch = epoch;
    return epoch;
  }

  #confirmed(selection: PluginSelection): boolean {
    this.#available();
    return installationSame(
      this.#owner.currentSelection({
        scope: this.#dependencies.scope,
        pluginId: selection.pluginId,
      }),
      selection,
    );
  }

  async #prepare(
    input: PluginInstallationPrepareSelectionInput,
  ): Promise<PluginPreparedSelection> {
    const operation = this.#assertOperation(input.actor, input.scope);
    // An explicitly published business candidate is proven while the durable selection is
    // still disabled. No CAS, Node accepting state or task authority precedes that proof.
    const business = await this.prepareBusinessCandidate(
      input,
      this.#lifetime.signal,
    );
    this.#assertOperation(input.actor, input.scope);
    // Only the actual new preparation may restore code: receipts, reads, install and withdrawal
    // have already taken their own paths in Application and never imply reactivation permission.
    if (!this.#recovered && input.nextSelection.state === "enabled") {
      try {
        await this.#recover(input.actor);
      } catch (error) {
        for (const value of this.#node.snapshot())
          if (value.phase === "accepting")
            this.#node.deactivate(value.identity.pluginId);
        try {
          await this.#node.drain();
        } catch (cleanupError) {
          this.withdraw();
          throw new AggregateError(
            [error, cleanupError],
            "plugin_installation_recovery_cleanup_failed",
          );
        }
        this.#recovered = true;
      } finally {
        this.#operation = operation;
      }
    }
    const local = await this.#local.prepareSelection(input);
    try {
      if (business !== null)
        await business.refreshBeforeSelectionCommit(this.#lifetime.signal);
      return this.#wrap(local, input, business);
    } catch (error) {
      await local.abort();
      throw error;
    }
  }

  #wrap(
    handle: PluginPreparedSelection,
    input: Pick<
      PluginInstallationPrepareSelectionInput,
      "actor" | "scope" | "nextSelection"
    >,
    business: DesktopPreparedBusinessCandidate | null = null,
  ): PluginPreparedSelection {
    const operation = this.#assertOperation(input.actor, input.scope);
    const selection = input.nextSelection;
    let prepared = false;
    let consumed = false;
    let wrapped!: PluginPreparedSelection;
    const invalidate = () => {
      if (operation.stamp?.handle === wrapped) operation.stamp = null;
    };
    wrapped = Object.freeze({
      ...(business === null
        ? {}
        : {
            assertBeforeSelectionCommit: ({
              selection: raw,
            }: Readonly<{ selection: PluginSelection }>) => {
              this.#assertOperation(input.actor, input.scope);
              business.assertBeforeSelectionCommit(parsePluginSelection(raw));
            },
          }),
      prepareCommit: async ({ selection: raw }) => {
        invalidate();
        if (
          prepared ||
          consumed ||
          !installationSame(parsePluginSelection(raw), selection) ||
          !this.#confirmed(selection)
        )
          conflict("plugin_installation_publication_invalid");
        prepared = true;
        const pkg = this.#owner.currentSelectedPackage({
          scope: input.scope,
          pluginId: selection.pluginId,
        });
        let candidate: PluginActivationCandidate | null = null;
        if (selection.state === "enabled") {
          if (pkg === null) conflict("plugin_installation_package_missing");
          candidate = {
            descriptor: await verifyDesktopInstalledPackage({
              installRoot: this.#dependencies.configuration.installRoot,
              package: pkg,
              registry: this.#dependencies.registry,
              signal: this.#lifetime.signal,
              hostUiServices: this.#dependencies.hostUiServices,
            }),
            packageDigest: pkg.packageDigest,
          };
        }
        const identity =
          candidate?.descriptor.entrypoints.node !== null && candidate !== null
            ? (this.#node
                .snapshot()
                .find(
                  (value) =>
                    (value.phase === "prepared" ||
                      value.phase === "accepting") &&
                    value.identity.pluginId === selection.pluginId &&
                    value.identity.packageDigest ===
                      selection.selectedPackageDigest,
                )?.identity ?? null)
            : null;
        if (candidate?.descriptor.entrypoints.node && identity === null)
          conflict("plugin_installation_candidate_missing");
        const dependencies = Object.freeze(
          candidate?.descriptor.requires.flatMap((requirement) => {
            if (candidate?.descriptor.entrypoints.node === null) return [];
            const actual = this.#node
              .serviceIdentities()
              .find(
                (service) =>
                  service.service === requirement.service &&
                  service.apiVersion === requirement.apiVersion,
              );
            return actual === undefined ? [] : [actual];
          }) ?? [],
        );
        this.#checkDependencies(dependencies);
        const uiCandidate =
          candidate?.descriptor.entrypoints.node === null ? candidate : null;
        this.#checkUiServices(uiCandidate);
        const epoch = await this.#fresh({
          actor: input.actor,
          scope: input.scope,
          action: "pluginInstallation:select",
          pluginId: selection.pluginId,
          packageDigest: selection.selectedPackageDigest,
        });
        if (business !== null)
          await business.assertBeforePublication(
            selection,
            this.#lifetime.signal,
          );
        // No asynchronous operation follows the final real authority decision before stamp publication.
        if (!this.#confirmed(selection))
          conflict("plugin_installation_selection_changed");
        this.#checkDependencies(dependencies);
        this.#checkUiServices(uiCandidate);
        operation.stamp = Object.freeze({
          handle: wrapped,
          selection,
          identity,
          dependencies,
          uiCandidate,
          epoch,
        });
      },
      commit: (value) => {
        if (consumed || operation.stamp?.handle !== wrapped)
          conflict("plugin_installation_publication_unprepared");
        consumed = true;
        try {
          handle.commit(value);
        } finally {
          invalidate();
        }
      },
      abort: async () => {
        invalidate();
        consumed = true;
        // A durable new desired selection must not keep the old Node accepting while projection is pending.
        try {
          if (this.#confirmed(selection))
            this.#node.deactivate(selection.pluginId);
        } finally {
          await handle.abort();
        }
      },
    });
    return wrapped;
  }

  #consume(
    selection: PluginSelection,
    candidate: PluginNodeCommitCandidate | null,
  ): "allow" | "deny" {
    const operation = this.#operation;
    const stamp = operation?.stamp ?? null;
    if (stamp === null) return "deny";
    operation!.stamp = null;
    if (
      operation!.epoch !== stamp.epoch ||
      !installationSame(stamp.selection, selection) ||
      !this.#confirmed(selection)
    )
      return "deny";
    this.#checkUiServices(stamp.uiCandidate);
    if (candidate === null) return stamp.identity === null ? "allow" : "deny";
    if (
      candidate.identity !== stamp.identity ||
      candidate.identity.pluginId !== selection.pluginId ||
      candidate.packageDigest !== selection.selectedPackageDigest ||
      this.#dependencies.registry.authorizeCandidate(candidate) !== "allow" ||
      candidate.dependencyIdentities.length !== stamp.dependencies.length
    )
      return "deny";
    for (let index = 0; index < stamp.dependencies.length; index++) {
      const a = stamp.dependencies[index]!;
      const b = candidate.dependencyIdentities[index]!;
      if (
        a.service !== b.service ||
        a.apiVersion !== b.apiVersion ||
        a.provider !== b.provider
      )
        return "deny";
    }
    this.#checkDependencies(stamp.dependencies);
    return "allow";
  }

  #checkUiServices(candidate: PluginActivationCandidate | null): void {
    this.#available();
    if (candidate !== null)
      assertPluginUiHostServiceAvailability({
        scope: this.#dependencies.scope,
        candidate,
        hostUiServices: this.#dependencies.hostUiServices,
      });
    this.#available();
  }

  #checkDependencies(
    dependencies: PluginNodeCommitCandidate["dependencyIdentities"],
  ): void {
    this.#available();
    for (const dependency of dependencies) {
      if (dependency.provider === null) continue;
      const provider = dependency.provider;
      const selection = this.#owner.currentSelection({
        scope: this.#dependencies.scope,
        pluginId: provider.pluginId,
      });
      const pkg = this.#owner.currentSelectedPackage({
        scope: this.#dependencies.scope,
        pluginId: provider.pluginId,
      });
      if (
        selection?.state !== "enabled" ||
        pkg === null ||
        pkg.packageDigest !== provider.packageDigest ||
        pkg.version !== provider.version ||
        !this.#dependencies.registry
          .list()
          .some(
            (source) =>
              source.pluginId === pkg.pluginId &&
              source.publisherId === pkg.publisherId &&
              source.version === pkg.version &&
              source.packageDigest === pkg.packageDigest,
          )
      )
        denied("plugin_installation_dependency_changed");
    }
  }

  async #recover(actor: ActorContext): Promise<void> {
    const original = this.#operation;
    const snapshot = this.#owner.snapshot();
    const records: InstallationRecoveryRecord[] = [];
    for (const selection of snapshot.selections) {
      this.#operation = {
        actor,
        scope: snapshot.scope,
        epoch: null,
        stamp: null,
      };
      const epoch = await this.#fresh({
        actor,
        scope: snapshot.scope,
        action: "pluginInstallation:select",
        pluginId: selection.pluginId,
        packageDigest: selection.selectedPackageDigest,
      });
      const pkg = this.#owner.currentSelectedPackage({
        scope: snapshot.scope,
        pluginId: selection.pluginId,
      });
      const descriptor =
        pkg === null
          ? null
          : await verifyDesktopInstalledPackage({
              installRoot: this.#dependencies.configuration.installRoot,
              package: pkg,
              registry: this.#dependencies.registry,
              signal: this.#lifetime.signal,
              hostUiServices: this.#dependencies.hostUiServices,
            });
      records.push(
        Object.freeze({ selection, package: pkg, descriptor, epoch }),
      );
    }
    const published: PluginNodeCommitCandidate["identity"][] = [];
    try {
      for (const record of orderInstallationRecoveries(
        records,
        this.#node,
        this.#dependencies.hostUiServices,
      )) {
        const operation: Operation = {
          actor,
          scope: snapshot.scope,
          epoch: record.epoch,
          stamp: null,
        };
        this.#operation = operation;
        const handle = await this.#local.prepareRecovery(
          {
            actor,
            scope: snapshot.scope,
            selection: record.selection,
            package: record.package,
          },
          {
            authorizeCurrent: ({ selection }) =>
              !this.#closed &&
              this.#operation === operation &&
              operation.epoch === record.epoch &&
              this.#confirmed(selection)
                ? "allow"
                : "deny",
            validateCompatibility: async () => {
              if (record.package !== null)
                await verifyDesktopInstalledPackage({
                  installRoot: this.#dependencies.configuration.installRoot,
                  package: record.package,
                  registry: this.#dependencies.registry,
                  signal: this.#lifetime.signal,
                  hostUiServices: this.#dependencies.hostUiServices,
                });
            },
          },
        );
        const wrapped = this.#wrap(handle, {
          actor,
          scope: snapshot.scope,
          nextSelection: record.selection,
        });
        try {
          await wrapped.prepareCommit!({ selection: record.selection });
          wrapped.commit({ selection: record.selection });
          const current = this.#node
            .snapshot()
            .find(
              (value) =>
                value.phase === "accepting" &&
                value.identity.pluginId === record.selection.pluginId,
            );
          if (current !== undefined) published.push(current.identity);
        } catch (error) {
          await wrapped.abort();
          throw error;
        }
      }
      this.#recovered = true;
    } catch (error) {
      for (const identity of published.reverse()) {
        if (
          this.#node
            .snapshot()
            .some(
              (value) =>
                value.identity === identity && value.phase === "accepting",
            )
        )
          this.#node.deactivate(identity.pluginId);
      }
      await this.#node.drain();
      throw error;
    } finally {
      this.#operation = original;
    }
  }
}

function conflict(code: string): never {
  throw new ApplicationError("conflict", code);
}
function denied(code: string): never {
  throw new ApplicationError("authorization", code);
}
