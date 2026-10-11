import {
  ApplicationError,
  type ActorContext,
  type SelectPluginPackageResult,
} from "@crewon/application";
import type {
  PluginCompositionLock,
  PluginCompositionNode,
} from "@crewon/contracts/plugins";
import type { PluginProfileScope } from "@crewon/domain";
import type {
  PluginCompositionCoordinator,
  PluginNodeCommitCandidate,
  PluginNodeHostServiceCatalog,
  PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import type { SqlitePluginInstallationProfileOwner } from "@crewon/store";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { DesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import type { DesktopPluginCompositionMetadataOwner } from "./desktop-plugin-composition-metadata-owner.ts";
import { projectDesktopPluginNodeComposition } from "./desktop-plugin-node-composition-projection.ts";
import { installationSame } from "./production-plugin-installation-runtime-support.ts";

type PublicationStamp = Readonly<{
  node: PluginCompositionNode;
  identity: PluginNodeCommitCandidate["identity"];
  dependencies: PluginNodeCommitCandidate["dependencyIdentities"];
  epoch: string;
}>;
type Dependencies = Readonly<{
  configuration: DesktopPluginConfiguration;
  registry: DesktopPluginSourceRegistry;
  owner: SqlitePluginInstallationProfileOwner;
  metadata: DesktopPluginCompositionMetadataOwner;
  nodes: PluginCompositionCoordinator;
  catalog: PluginNodeHostServiceCatalog;
  hostUiServices?: PluginUiHostServiceAvailabilityPort;
  signal: AbortSignal;
  assertOperation(actor: ActorContext, scope: PluginProfileScope): void;
  refreshAuthority(
    actor: ActorContext,
    node: PluginCompositionNode | null,
  ): Promise<string>;
}>;

/** Runs inside the installation profile's original queue, with its actual held claim.
 * Reconciliation follows a newly committed selection; reading a graph or replaying
 * an old receipt never restores code. The private Node graph is never persisted.
 */
export class DesktopPluginInstanceCompositionOwner {
  readonly #input: Dependencies;
  constructor(input: Dependencies) {
    this.#input = Object.freeze({ ...input });
  }

  async observeSelection(
    actor: ActorContext,
    result: SelectPluginPackageResult,
  ): Promise<void> {
    if (result.mutation.disposition !== "committed") return;
    try {
      await this.#applySelection(actor, result);
    } catch {
      // A selection already committed. Preserve its known receipt even if
      // authority/close wins during post-commit metadata or instance projection.
      // Subsequent entries still check the real scope, claim and lifetime.
    }
  }

  async #applySelection(
    actor: ActorContext,
    result: SelectPluginPackageResult,
  ): Promise<void> {
    const input = this.#input;
    // This withdrawal precedes any metadata await. Desired enabled state must
    // not retain a previous generation when its actual publication is pending.
    if (
      result.mutation.selection.state !== "enabled" ||
      result.projection.outcome !== "applied"
    )
      input.nodes.revoke(result.mutation.selection.pluginId);
    await input.metadata.observeSelection(actor, result);
    if (result.projection.outcome !== "applied") return;
    const source = input.metadata.currentLock(actor);
    if (source === null) return;
    const snapshot = input.owner.snapshot();
    const compositions = input.owner.store.compositionStore();
    const assertCurrent = () => {
      input.signal.throwIfAborted();
      input.assertOperation(actor, input.configuration.scope);
      if (
        !installationSame(snapshot, input.owner.snapshot()) ||
        input.metadata.currentLock(actor)?.lockDigest !== source.lockDigest
      )
        denied("plugin_composition_selection_changed");
      compositions.assertCurrentLock({
        scope: input.configuration.scope,
        lockDigest: source.lockDigest,
      });
      for (const node of source.nodes) {
        const selection = snapshot.selections.find(
          (entry) => entry.pluginId === node.pluginId,
        );
        const pkg = snapshot.selectedPackages.find(
          (entry) => entry.pluginId === node.pluginId,
        );
        if (
          selection?.state !== "enabled" ||
          selection.revision !== node.selectionRevision ||
          selection.selectedPackageDigest !== node.packageDigest ||
          pkg?.version !== node.version ||
          pkg.packageDigest !== node.packageDigest ||
          pkg.publisherId !== node.publisherId ||
          input.registry.authorizeIdentity(pkg) !== "allow"
        )
          denied("plugin_composition_selection_changed");
      }
    };
    // The Store owned view checks the same physical SQLite profile claim; neither
    // the cached graph nor a renderer DTO can substitute for its current head.
    const refresh = async (
      node: PluginCompositionNode | null,
    ): Promise<string> => {
      assertCurrent();
      const head = await compositions.loadCurrent({
        scope: input.configuration.scope,
      });
      assertCurrent();
      if (head?.lockDigest !== source.lockDigest)
        denied("plugin_composition_head_changed");
      const epoch = await input.refreshAuthority(actor, node);
      assertCurrent();
      if (epoch !== source.scope.authorityEpoch)
        denied("plugin_composition_authority_changed");
      return epoch;
    };
    await refresh(null);
    const projection = await projectDesktopPluginNodeComposition({
      sourceLock: source,
      snapshot,
      scope: {
        ...input.configuration.scope,
        authorityEpoch: input.configuration.authorityEpoch,
      },
      hostServices: input.catalog.metadata,
      installRoot: input.configuration.installRoot,
      registry: input.registry,
      hostUiServices: input.hostUiServices,
      signal: input.signal,
      assertCurrent,
    });
    let stamp: PublicationStamp | null = null;
    await input.nodes.synchronizeInstalled({
      lock: projection.privateLock,
      authority: {
        authorizePreparation: async ({ lock, node, candidate }) => {
          stamp = null;
          assertPrivateBinding(lock, source, projection.privateLock);
          await refresh(node);
          return input.registry.authorizeCandidate(candidate);
        },
        beforePublication: async ({
          lock,
          node,
          identity,
          dependencyIdentities,
        }) => {
          stamp = null;
          assertPrivateBinding(lock, source, projection.privateLock);
          const epoch = await refresh(node);
          // The next publication is synchronous: pin the actual prepared
          // identity and provider objects, not just matching package strings.
          stamp = Object.freeze({
            node,
            identity,
            dependencies: dependencyIdentities,
            epoch,
          });
        },
        authorizePublication: ({ lock, node, candidate }) => {
          const proof = stamp;
          stamp = null;
          assertCurrent();
          assertPrivateBinding(lock, source, projection.privateLock);
          if (
            proof === null ||
            proof.epoch !== source.scope.authorityEpoch ||
            proof.node !== node ||
            proof.identity !== candidate.identity ||
            !sameDependencies(
              proof.dependencies,
              candidate.dependencyIdentities,
            ) ||
            input.registry.authorizeCandidate(candidate) !== "allow"
          )
            return "deny";
          return "allow";
        },
      },
    });
  }
}

function assertPrivateBinding(
  lock: PluginCompositionLock,
  source: PluginCompositionLock,
  expected: PluginCompositionLock,
): void {
  if (
    lock.lockDigest !== expected.lockDigest ||
    lock.revision !== source.revision ||
    !installationSame(lock.scope, source.scope) ||
    !installationSame(lock.hostServices, source.hostServices)
  )
    denied("plugin_composition_private_binding_changed");
}
function sameDependencies(
  a: PluginNodeCommitCandidate["dependencyIdentities"],
  b: PluginNodeCommitCandidate["dependencyIdentities"],
): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        entry.service === other.service &&
        entry.apiVersion === other.apiVersion &&
        entry.provider === other.provider
      );
    })
  );
}
function denied(code: string): never {
  throw new ApplicationError("authorization", code);
}
