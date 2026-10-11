import {
  ApplicationError,
  PluginInstallationApplicationService,
  type ActorContext,
  type ApplicationClock,
  type ContentDigester,
  type PluginInstallationPrepareSelectionInput,
  type PluginPreparedSelection,
  type SelectPluginPackageResult,
} from "@crewon/application";
import {
  parsePluginProfileScope,
  parsePluginSelection,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import {
  type LocalPluginInstallationHost,
  PluginCompositionCoordinator,
  assertPluginUiHostServiceAvailability,
  capturePluginUiHostServiceAvailability,
  type PluginActivationCandidate,
  type PluginNodeCommitCandidate,
  type PluginUiHostServiceAvailabilityPort,
  type PluginNodeLease,
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
import { DesktopPluginCompositionMetadataOwner } from "./desktop-plugin-composition-metadata-owner.ts";
import { DesktopPluginExecutionServiceOwner } from "./desktop-plugin-execution-service-owner.ts";
import { DesktopPluginProfileOperationQueue } from "./desktop-plugin-profile-operation-queue.ts";
import { captureDesktopPluginCompositionStatus } from "./desktop-plugin-composition-status-capture.ts";
import {
  createDesktopPluginInstallationHostPolicy,
  assertDesktopPluginInstallationDependencies,
} from "./desktop-plugin-installation-host-policy.ts";
import { DesktopPluginInstanceCompositionOwner } from "./desktop-plugin-instance-composition-owner.ts";
import {
  refreshDesktopPluginInstallationAuthority,
  type DesktopPluginAuthorityRequest,
} from "./desktop-plugin-installation-authority-refresh.ts";
import type {
  PluginCompositionStatusResponse,
  PluginSelectionListQuery,
} from "@crewon/contracts";
type Method =
  | "install"
  | "select"
  | "getPackage"
  | "getSelection"
  | "listPackages"
  | "listSelections";
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

export type DesktopPluginNodeBorrowInput = Readonly<{
  actor: ActorContext;
  scope: PluginProfileScope;
  pluginId: string;
  packageDigest: string;
  /** Existing Host identity/package/PDP policy; borrowing never grants task permission. */
  authorizeBorrow(identity: PluginNodeLease["identity"]): "allow" | "deny";
}>;
export type DesktopPluginNodeBorrow = Readonly<{
  /** The actual NodeHost-issued lease, without copying its identity or its private brand. */
  lease: PluginNodeLease;
  /** Releases both the actual lease and this Profile's physical-work join. */
  release(): void;
}>;

export class DesktopInstallationProfile {
  readonly #dependencies: ProfileDependencies;
  readonly #executionServices = new DesktopPluginExecutionServiceOwner();
  readonly #node: PluginCompositionCoordinator;
  readonly #removeAuthorityObserver: () => void;
  readonly #lifetime = new AbortController();
  #owner!: SqlitePluginInstallationProfileOwner;
  #local!: LocalPluginInstallationHost;
  #application!: PluginInstallationApplicationService;
  #compositionMetadata!: DesktopPluginCompositionMetadataOwner;
  #instances!: DesktopPluginInstanceCompositionOwner;
  #operation: Operation | null = null;
  readonly #queue = new DesktopPluginProfileOperationQueue(() =>
    this.#available(),
  );
  readonly #borrows = new Set<Promise<void>>();
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
    this.#node = new PluginCompositionCoordinator({
      scope: {
        ...dependencies.scope,
        authorityEpoch: dependencies.configuration.authorityEpoch,
      },
      installRoot: dependencies.configuration.installRoot,
      services: this.#executionServices.catalog.registrations,
    });
    this.#removeAuthorityObserver =
      dependencies.authority.registerWithdrawalObserver(() => this.withdraw());
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
      dependencies.authority.assertScope(
        dependencies.configuration.actor,
        dependencies.scope,
      );
      profile.#available();
      profile.#initialize();
      return profile;
    } catch (error) {
      profile.withdraw();
      profile.#removeAuthorityObserver();
      await profile.#node.close();
      await profile.#owner?.close();
      throw error;
    }
  }

  #initialize(): void {
    const dependencies = this.#dependencies;
    this.#compositionMetadata = new DesktopPluginCompositionMetadataOwner({
      configuration: dependencies.configuration,
      registry: dependencies.registry,
      authority: dependencies.authority,
      owner: this.#owner,
      signal: this.#lifetime.signal,
      hostServices: this.#executionServices.catalog.metadata,
    });
    this.#instances = new DesktopPluginInstanceCompositionOwner({
      configuration: dependencies.configuration,
      registry: dependencies.registry,
      owner: this.#owner,
      metadata: this.#compositionMetadata,
      nodes: this.#node,
      catalog: this.#executionServices.catalog,
      hostUiServices: dependencies.hostUiServices,
      signal: this.#lifetime.signal,
      assertOperation: (actor, scope) => {
        this.#assertOperation(actor, scope);
      },
      refreshAuthority: (actor, node) =>
        this.#fresh({
          actor,
          scope: dependencies.scope,
          action: "pluginInstallation:select",
          pluginId: node?.pluginId ?? null,
          packageDigest: node?.packageDigest ?? null,
        }),
    });
    this.#local = this.#node.createInstallationHost(
      createDesktopPluginInstallationHostPolicy({
        configuration: dependencies.configuration,
        registry: dependencies.registry,
        nodes: this.#node,
        signal: this.#lifetime.signal,
        hostUiServices: dependencies.hostUiServices,
        assertOperation: (actor, scope) => {
          this.#assertOperation(actor, scope);
        },
        assertAvailable: () => this.#available(),
        refreshAuthority: (request) => this.#fresh(request),
        checkUiServices: (candidate) => this.#checkUiServices(candidate),
        authorizeCommit: (selection, candidate) =>
          this.#consume(selection, candidate),
      }),
    );
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
    return this.#runOperation(actor, async () => {
      const call = this.#application[method] as (
        actor: ActorContext,
        input: unknown,
      ) => Promise<unknown>;
      const result = await call.call(this.#application, actor, input);
      if (method === "select")
        await this.#instances.observeSelection(
          actor,
          result as SelectPluginPackageResult,
        );
      return result;
    });
  }

  compositionStatus(
    actor: ActorContext,
    query: PluginSelectionListQuery,
  ): Promise<PluginCompositionStatusResponse> {
    return this.#runOperation(actor, () =>
      captureDesktopPluginCompositionStatus({
        actor,
        scope: this.#dependencies.scope,
        query,
        owner: this.#owner,
        application: this.#application,
        registry: this.#dependencies.registry,
        metadata: this.#compositionMetadata,
        nodes: this.#node,
        signal: this.#lifetime.signal,
        refreshAuthority: () =>
          this.#fresh({
            actor,
            scope: this.#dependencies.scope,
            action: "pluginInstallation:read",
            pluginId: null,
            packageDigest: null,
          }),
      }),
    );
  }

  #runOperation<T>(actor: ActorContext, work: () => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      this.#available();
      const operation: Operation = {
        actor,
        scope: this.#dependencies.scope,
        epoch: null,
        stamp: null,
      };
      this.#operation = operation;
      try {
        return await work();
      } finally {
        operation.stamp = null;
        this.#operation = null;
      }
    });
  }

  /** Metadata publication is separate from active Node/UI readiness. */
  compositionState(actor: ActorContext) {
    this.#available();
    return this.#compositionMetadata.state(actor);
  }

  /** Borrows an existing shared instance. Business work never holds the operation queue. */
  borrowNode(input: DesktopPluginNodeBorrowInput): DesktopPluginNodeBorrow {
    this.#available();
    if (this.#borrows.size >= 128)
      conflict("plugin_node_borrow_capacity_exceeded");
    if (!installationSame(input.scope, this.#dependencies.scope))
      denied("plugin_composition_scope_conflict");
    this.assertOwnership(input.actor);
    const lock = this.#instances.currentNodeLock(input.actor);
    if (lock === null) conflict("plugin_composition_node_unobserved");
    const check = () => {
      this.assertOwnership(input.actor);
      if (
        this.#instances.currentNodeLock(input.actor)?.lockDigest !==
        lock.lockDigest
      )
        denied("plugin_composition_source_changed");
    };
    const lease = this.#node.acquireScopedCurrent({
      scope: lock.scope,
      lockDigest: lock.lockDigest,
      pluginId: input.pluginId,
      authorizeBorrow: (identity) => {
        check();
        if (identity.packageDigest !== input.packageDigest) return "deny";
        const decision = input.authorizeBorrow(identity);
        check();
        return decision;
      },
    });
    let complete!: () => void;
    const physical = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.#borrows.add(physical);
    let released = false;
    return Object.freeze({
      lease,
      release: () => {
        if (released) return;
        lease.release();
        released = true;
        this.#borrows.delete(physical);
        complete();
      },
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
    this.#executionServices.close();
    if (this.#operation !== null) this.#operation.stamp = null;
    for (const value of this.#node.snapshot())
      if (value.phase === "accepting")
        this.#node.revoke(value.identity.pluginId);
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.withdraw();
    return (this.#closing = (async () => {
      await this.#queue.drain();
      await Promise.all([...this.#borrows]);
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
      } finally {
        this.#removeAuthorityObserver();
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
    try {
      this.#dependencies.authority.assertScope(actor, current);
    } catch (error) {
      // Withdrawal of our own Native authority revokes the instance lifetime.
      // A foreign actor's rejected request must not withdraw another owner.
      if (
        installationSame(actor, this.#dependencies.configuration.actor) &&
        installationSame(current, this.#dependencies.scope)
      ) {
        this.withdraw();
        this.#dependencies.authority.withdraw();
      }
      throw error;
    }
    this.#owner.assertOwnership();
    return operation;
  }
  #fresh(input: DesktopPluginAuthorityRequest): Promise<string> {
    const operation = this.#assertOperation(input.actor, input.scope);
    return refreshDesktopPluginInstallationAuthority({
      request: input,
      authority: this.#dependencies.authority,
      operation,
      assertCurrent: () => {
        if (this.#assertOperation(input.actor, input.scope) !== operation)
          denied("plugin_installation_operation_mismatch");
      },
    });
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
            this.#node.revoke(value.identity.pluginId);
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
          if (this.#confirmed(selection)) this.#node.revoke(selection.pluginId);
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
    if (operation === null) return "deny";
    this.#assertOperation(operation.actor, operation.scope);
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
    assertDesktopPluginInstallationDependencies({
      dependencies,
      scope: this.#dependencies.scope,
      owner: this.#owner,
      registry: this.#dependencies.registry,
      assertAvailable: () => this.#available(),
    });
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
          this.#node.revoke(identity.pluginId);
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
