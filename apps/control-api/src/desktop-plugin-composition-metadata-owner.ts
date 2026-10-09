import type {
  ActorContext,
  SelectPluginPackageResult,
} from "@crewon/application";
import { publishInstalledPluginComposition } from "@crewon/plugin-host";
import type { SqlitePluginInstallationProfileOwner } from "@crewon/store";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import type { DesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";

export type DesktopPluginCompositionMetadataState =
  | Readonly<{ outcome: "unknown" }>
  | Readonly<{ outcome: "published"; lockDigest: string; revision: number }>
  | Readonly<{ outcome: "unavailable"; code: string }>;
type Dependencies = Readonly<{
  configuration: DesktopPluginConfiguration;
  registry: DesktopPluginSourceRegistry;
  authority: DesktopPluginAuthority;
  owner: SqlitePluginInstallationProfileOwner;
  signal: AbortSignal;
}>;

/** Profile-owned metadata projection. Does not publish Node/UI instances or issue task grants. */
export class DesktopPluginCompositionMetadataOwner {
  readonly #input: Dependencies;
  #state: DesktopPluginCompositionMetadataState = Object.freeze({
    outcome: "unknown",
  });
  constructor(input: Dependencies) {
    this.#input = Object.freeze({ ...input });
  }

  state(actor: ActorContext): DesktopPluginCompositionMetadataState {
    this.#input.signal.throwIfAborted();
    this.#input.authority.assertScope(actor, this.#input.configuration.scope);
    this.#input.owner.assertOwnership();
    return this.#state;
  }

  async observeSelection(
    actor: ActorContext,
    result: SelectPluginPackageResult,
  ): Promise<void> {
    if (result.mutation.disposition !== "committed") return;
    if (result.projection.outcome !== "applied") {
      this.#state = Object.freeze({
        outcome: "unavailable",
        code: "plugin_projection_pending",
      });
      return;
    }
    try {
      this.#assertOwner(actor);
      const { configuration, registry, authority, owner, signal } = this.#input;
      const compositions = owner.store.compositionStore?.();
      if (compositions === undefined)
        throw new Error("plugin_composition_store_unavailable");
      const published = await publishInstalledPluginComposition({
        actor,
        scope: {
          ...configuration.scope,
          authorityEpoch: configuration.authorityEpoch,
        },
        installRoot: configuration.installRoot,
        // The installation NodeHost has no host services. UI availability cannot
        // be relabeled as Node service identity; unresolved graphs stay unavailable.
        hostServices: [],
        installations: owner.store,
        compositions,
        signal,
        authorizeSnapshot: async (lock) => {
          this.#assertOwner(actor);
          const epoch = await authority.epoch({
            actor,
            scope: configuration.scope,
            action: "pluginInstallation:select",
            pluginId: null,
            packageDigest: null,
          });
          this.#assertOwner(actor);
          if (epoch !== lock.scope.authorityEpoch) return "deny";
          return lock.nodes.every(
            (node) => registry.authorizeIdentity(node) === "allow",
          )
            ? "allow"
            : "deny";
        },
      });
      this.#assertOwner(actor);
      this.#state = Object.freeze({
        outcome: "published",
        lockDigest: published.lock.lockDigest,
        revision: published.lock.revision,
      });
    } catch (error) {
      // Selection has already committed. Preserve its known receipt and report
      // metadata failure separately; never claim rollback or mask it as readiness.
      const value =
        error !== null && typeof error === "object"
          ? Object.getOwnPropertyDescriptor(error, "code")?.value
          : null;
      const code =
        typeof value === "string" &&
        /^(?:plugin|desktop_plugin)_[a-z0-9_]{1,100}$/u.test(value)
          ? value
          : "plugin_composition_metadata_unavailable";
      this.#state = Object.freeze({ outcome: "unavailable", code });
    }
  }

  #assertOwner(actor: ActorContext): void {
    const { configuration, authority, owner, signal } = this.#input;
    signal.throwIfAborted();
    authority.assertScope(actor, configuration.scope);
    owner.snapshot();
    authority.assertScope(actor, configuration.scope);
    signal.throwIfAborted();
  }
}
