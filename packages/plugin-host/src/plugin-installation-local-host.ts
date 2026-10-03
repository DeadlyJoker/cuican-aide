import {
  ApplicationError,
  type ActorContext,
  type PluginInstallationHostPort,
  type PluginInstallationHostInstallInput,
  type PluginInstallationPrepareSelectionInput,
  type PluginPreparedSelection,
} from "@crewon/application";
import {
  assertPluginProfileScope,
  assertPluginSelectionPackage,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationNextRevision,
  pluginInstallationOpaqueId,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";
import { verifyInstalledSelectionPackage } from "./plugin-installation-package-support.ts";
import {
  LocalPluginPackageError,
  type PluginPackageInstallationCandidate,
} from "./local-plugin-package-types.ts";
import {
  PluginNodeHost,
  type PluginActivationCandidate,
  type PluginNodeCommitCandidate,
  type PluginNodePreparedActivation,
} from "./plugin-node-host.ts";
import {
  prepareInstalledSelectionRecovery,
  recoverInstalledSelections,
  type PluginInstalledSelectionRecoveryInput,
  type PluginInstalledSelectionRecoveryPolicy,
} from "./plugin-installation-recovery.ts";

type Authority = Readonly<{ actor: ActorContext; scope: PluginProfileScope }>;

export type LocalPluginInstallationHostDependencies = Readonly<{
  /** One trusted local coordinator and NodeHost per profile; not a distributed leader election. */
  profile: PluginProfileScope;
  installRoot: string;
  nodeHost: PluginNodeHost;
  /** Host registry must enforce immutable source ownership; clients never supply a directory. */
  resolveSource(
    input: Authority & Readonly<{ sourceId: string }>,
  ): Promise<string>;
  authorizeInstallation(
    input: Authority &
      Readonly<{ candidate: PluginPackageInstallationCandidate }>,
  ): Promise<"allow" | "deny">;
  authorizeActivation(
    input: Authority & Readonly<{ candidate: PluginActivationCandidate }>,
  ): Promise<"allow" | "deny">;
  /** Required exact runtime/configuration/current-data compatibility review; no default "ready". */
  validateCompatibility(
    input: PluginInstallationPrepareSelectionInput &
      Readonly<{ descriptor: PluginPackageDescriptor | null }>,
  ): Promise<void>;
  /**
   * Synchronous trusted fence for the confirmed durable selection, current authority epoch and
   * every dependency's durable identity. A null candidate means UI-only selection or Node withdrawal;
   * it still requires the exact durable selection and current permission, never a default grant.
   * Cannot call plugin code or rely only on Node's current map.
   * Real Run admission still has to recheck durable selection within its existing transaction.
   */
  authorizeCommit(
    input: Authority &
      Readonly<{
        selection: PluginSelection;
        candidate: PluginNodeCommitCandidate | null;
      }>,
  ): "allow" | "deny";
}>;

/** Bridges actual immutable package bytes and staged Node lifecycle to internal Application ports. */
export class LocalPluginInstallationHost implements PluginInstallationHostPort {
  readonly #dependencies: LocalPluginInstallationHostDependencies;
  readonly #profile: PluginProfileScope;
  readonly #cleanup = new Set<Promise<void>>();
  #selectionTail: Promise<void> = Promise.resolve();
  #waiting = 0;

  constructor(dependencies: LocalPluginInstallationHostDependencies) {
    this.#profile = parsePluginProfileScope(dependencies.profile);
    this.#dependencies = Object.freeze({
      ...dependencies,
      profile: this.#profile,
    });
    for (const name of [
      "resolveSource",
      "authorizeInstallation",
      "authorizeActivation",
      "validateCompatibility",
      "authorizeCommit",
    ] as const)
      if (typeof dependencies[name] !== "function")
        throw new ApplicationError("internal", "plugin_host_policy_missing");
    if (!(dependencies.nodeHost instanceof PluginNodeHost))
      throw new ApplicationError("internal", "plugin_node_host_missing");
  }

  async install(input: PluginInstallationHostInstallInput) {
    const value = record(input, [
      "actor",
      "scope",
      "sourceId",
      "expectedPluginId",
      "expectedPackageDigest",
    ]);
    const authority = this.#authority(value);
    const sourceId = pluginInstallationOpaqueId(value.sourceId);
    const pluginId = pluginInstallationNamespaceId(value.expectedPluginId);
    const packageDigest = pluginInstallationDigest(value.expectedPackageDigest);
    const directory = await this.#dependencies.resolveSource({
      ...authority,
      sourceId,
    });
    const installed = await installLocalPluginPackage({
      directory,
      installRoot: this.#dependencies.installRoot,
      authorization: async (candidate) => {
        if (
          candidate.descriptor.pluginId !== pluginId ||
          candidate.packageDigest !== packageDigest
        )
          throw new ApplicationError(
            "validation",
            "plugin_source_identity_mismatch",
          );
        if (
          (await this.#dependencies.authorizeInstallation({
            ...authority,
            candidate,
          })) !== "allow"
        )
          throw new ApplicationError(
            "authorization",
            "plugin_installation_denied",
          );
        return { outcome: "allow" };
      },
    }).catch((error: unknown) => {
      if (
        error instanceof LocalPluginPackageError &&
        error.cause instanceof ApplicationError
      )
        throw error.cause;
      if (
        error instanceof LocalPluginPackageError &&
        error.code === "plugin_package_installation_denied"
      )
        throw new ApplicationError(
          "authorization",
          "plugin_installation_denied",
          { cause: error },
        );
      throw error;
    });
    return Object.freeze({
      pluginId: installed.descriptor.pluginId,
      version: installed.descriptor.version,
      publisherId: installed.descriptor.publisherId,
      packageDigest: installed.packageDigest,
    });
  }

  async prepareSelection(
    input: PluginInstallationPrepareSelectionInput,
  ): Promise<PluginPreparedSelection> {
    const value = record(input, [
      "actor",
      "scope",
      "currentSelection",
      "nextSelection",
      "package",
    ]);
    const authority = this.#authority(value);
    const currentSelection = parsePluginSelection(value.currentSelection);
    const nextSelection = parsePluginSelection(value.nextSelection);
    assertPluginProfileScope(authority.scope, currentSelection);
    assertPluginProfileScope(authority.scope, nextSelection);
    if (
      currentSelection.pluginId !== nextSelection.pluginId ||
      currentSelection.publisherId !== nextSelection.publisherId ||
      nextSelection.revision !==
        pluginInstallationNextRevision(currentSelection.revision)
    )
      throw new ApplicationError(
        "conflict",
        "plugin_selection_identity_mismatch",
      );
    const pkg =
      value.package === null
        ? null
        : parseInstalledPluginPackage(value.package);
    assertPluginSelectionPackage({ selection: nextSelection, package: pkg });
    const preparedInput = Object.freeze({
      ...authority,
      currentSelection,
      nextSelection,
      package: pkg,
    });
    const release = await this.#lock();
    let node: PluginNodePreparedActivation | null = null;
    let uiOnly = false;
    // Only the coordinator owns new selection changes. This is not a Run-admission lock.
    const previous = this.#dependencies.nodeHost
      .snapshot()
      .find(
        (instance) =>
          instance.identity.pluginId === nextSelection.pluginId &&
          instance.phase === "accepting",
      )?.identity;
    try {
      const needsActivation = nextSelection.state === "enabled";
      const needsPackage =
        needsActivation ||
        (nextSelection.state === "disabled" &&
          nextSelection.selectedPackageDigest !==
            currentSelection.selectedPackageDigest);
      let descriptor: PluginPackageDescriptor | null = null;
      if (needsPackage) {
        if (pkg === null)
          throw new ApplicationError(
            "internal",
            "plugin_selection_package_missing",
          );
        descriptor = await verifyInstalledSelectionPackage({
          installRoot: this.#dependencies.installRoot,
          package: pkg,
        });
        uiOnly = descriptor.entrypoints.node === null;
      }
      await this.#dependencies.validateCompatibility({
        ...preparedInput,
        descriptor,
      });
      if (needsActivation && uiOnly) {
        if (
          (await this.#dependencies.authorizeActivation({
            ...authority,
            candidate: Object.freeze({
              descriptor: descriptor!,
              packageDigest: pkg!.packageDigest,
            }),
          })) !== "allow"
        )
          throw new ApplicationError(
            "authorization",
            "plugin_activation_denied",
          );
        // The authority await must not let changed installed bytes retain the previous grant.
        await verifyInstalledSelectionPackage({
          installRoot: this.#dependencies.installRoot,
          package: pkg!,
        });
      } else if (needsActivation) {
        node = await this.#dependencies.nodeHost.prepare({
          installRoot: this.#dependencies.installRoot,
          expectedPluginId: nextSelection.pluginId,
          expectedPackageDigest: nextSelection.selectedPackageDigest!,
          authorizeActivation: async (candidate) => {
            if (
              candidate.descriptor.publisherId !== nextSelection.publisherId ||
              candidate.descriptor.version !== pkg!.version ||
              candidate.packageDigest !== nextSelection.selectedPackageDigest
            )
              return "deny";
            return this.#dependencies.authorizeActivation({
              ...authority,
              candidate,
            });
          },
        });
      } else if (needsPackage) {
        // A disabled version change verifies bytes and compatibility without importing code
        // or requesting activation. Compatibility may await host policy, so recheck its bytes.
        await verifyInstalledSelectionPackage({
          installRoot: this.#dependencies.installRoot,
          package: pkg!,
        });
      }
    } catch (error) {
      try {
        await node?.abort();
      } finally {
        release();
      }
      throw error;
    }
    let phase: "prepared" | "committed" | "aborted" = "prepared";
    const candidate = node;
    const abort = async () => {
      if (phase === "committed") return;
      phase = "aborted";
      try {
        await candidate?.abort();
      } finally {
        release();
      }
    };
    return Object.freeze({
      abort,
      commit: (commitInput: Readonly<{ selection: PluginSelection }>) => {
        if (phase !== "prepared")
          throw new ApplicationError("conflict", "plugin_preparation_consumed");
        try {
          const checkPrevious = () => {
            const current = this.#dependencies.nodeHost
              .snapshot()
              .find(
                (instance) =>
                  instance.identity.pluginId === nextSelection.pluginId &&
                  instance.phase === "accepting",
              )?.identity;
            if (current !== previous)
              throw new ApplicationError(
                "conflict",
                "plugin_projection_current_changed",
              );
          };
          checkPrevious();
          const requested = parsePluginSelection(
            record(commitInput, ["selection"]).selection,
          );
          if (JSON.stringify(requested) !== JSON.stringify(nextSelection))
            throw new ApplicationError(
              "conflict",
              "plugin_selection_commit_mismatch",
            );
          if (nextSelection.state === "enabled" && !uiOnly) {
            if (!candidate)
              throw new ApplicationError(
                "internal",
                "plugin_preparation_missing",
              );
            candidate.commit({
              authorizeCommit: (commitCandidate) =>
                this.#dependencies.authorizeCommit({
                  ...authority,
                  selection: requested,
                  candidate: commitCandidate,
                }),
            });
          } else {
            if (
              this.#dependencies.authorizeCommit({
                ...authority,
                selection: requested,
                candidate: null,
              }) !== "allow"
            )
              throw new ApplicationError(
                "authorization",
                "plugin_selection_commit_denied",
              );
            checkPrevious();
            this.#dependencies.nodeHost.deactivate(nextSelection.pluginId);
            if (candidate) this.#trackCleanup(candidate.abort());
          }
          phase = "committed";
        } catch (error) {
          // DB selection is already durable. Revoke the old projection's new admission, preserving
          // historical borrowers. Never roll the DB back or disable a separately published version.
          const current = this.#dependencies.nodeHost
            .snapshot()
            .find(
              (instance) =>
                instance.identity.pluginId === nextSelection.pluginId &&
                instance.phase === "accepting",
            );
          if (current && current.identity === previous)
            this.#dependencies.nodeHost.deactivate(nextSelection.pluginId);
          phase = "aborted";
          if (candidate) this.#trackCleanup(candidate.abort());
          throw error;
        } finally {
          release();
        }
      },
    });
  }

  /** Cleanup diagnostics remain in NodeHost; failure never means a retired borrowed instance. */
  async drain(): Promise<void> {
    while (this.#cleanup.size) await Promise.all([...this.#cleanup]);
    await this.#dependencies.nodeHost.drain();
  }

  /** Restore the original durable revision without installing sources or creating a selection receipt. */
  prepareRecovery(
    input: PluginInstalledSelectionRecoveryInput,
    policy: PluginInstalledSelectionRecoveryPolicy,
  ): Promise<PluginPreparedSelection> {
    return prepareInstalledSelectionRecovery(
      this.#recoveryCoordinator(),
      input,
      policy,
    );
  }

  /** Provider-first startup restore, sharing this profile's selection publication coordinator. */
  recoverSelections(
    input: readonly PluginInstalledSelectionRecoveryInput[],
    policy: PluginInstalledSelectionRecoveryPolicy,
  ): Promise<readonly PluginSelection[]> {
    return recoverInstalledSelections(
      this.#recoveryCoordinator(),
      input,
      policy,
    );
  }

  #recoveryCoordinator() {
    return {
      dependencies: this.#dependencies,
      lock: () => this.#lock(),
      trackCleanup: (task: Promise<void>) => this.#trackCleanup(task),
    };
  }

  #trackCleanup(task: Promise<void>): void {
    // The Node host retains cleanupFailed and its dependency leases for drain() diagnostics.
    const tracked = task
      .catch(() => undefined)
      .finally(() => this.#cleanup.delete(tracked));
    this.#cleanup.add(tracked);
  }

  async #lock(): Promise<() => void> {
    if (this.#waiting >= 64)
      throw new ApplicationError("conflict", "plugin_selection_queue_full");
    this.#waiting += 1;
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const previous = this.#selectionTail;
    this.#selectionTail = previous.then(() => held);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#waiting -= 1;
      finish();
    };
  }

  #authority(input: Readonly<Record<string, unknown>>): Authority {
    const scope = parsePluginProfileScope(input.scope);
    assertPluginProfileScope(this.#profile, scope);
    const value = record(input.actor, [
      "tenantId",
      "spaceId",
      "principalId",
      "actorId",
    ]);
    const actor = Object.freeze({
      tenantId: pluginInstallationOpaqueId(value.tenantId),
      spaceId: pluginInstallationOpaqueId(value.spaceId),
      principalId: pluginInstallationOpaqueId(value.principalId),
      actorId: pluginInstallationOpaqueId(value.actorId),
    });
    if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
      throw new ApplicationError(
        "authorization",
        "plugin_profile_scope_mismatch",
      );
    return Object.freeze({ actor, scope });
  }
}

function record(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new ApplicationError("validation", "plugin_host_input_invalid");
  const prototype = Object.getPrototypeOf(input);
  const keys = Reflect.ownKeys(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new ApplicationError("validation", "plugin_host_input_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          !descriptor ||
          !Object.hasOwn(descriptor, "value") ||
          !descriptor.enumerable
        )
          throw new ApplicationError("validation", "plugin_host_input_invalid");
        return [field, descriptor.value];
      }),
    ),
  );
}
