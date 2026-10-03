import type {
  InstalledPluginPackage,
  PluginProfileScope,
  PluginSelection,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";

/** Host-issued current profile authority; a client profile selector is not accepted by these use cases. */
export interface PluginInstallationHostProfilePort {
  resolve(actor: ActorContext): Promise<PluginProfileScope>;
}

export type PluginInstallationHostIdentity = Readonly<{
  pluginId: string;
  version: string;
  publisherId: string;
  packageDigest: string;
}>;
export type PluginInstallationHostInstallInput = Readonly<{
  actor: ActorContext;
  scope: PluginProfileScope;
  /** Immutable opaque source reference issued and resolved by the host, never a filesystem path. */
  sourceId: string;
  expectedPluginId: string;
  expectedPackageDigest: string;
}>;
export type PluginInstallationPrepareSelectionInput = Readonly<{
  actor: ActorContext;
  scope: PluginProfileScope;
  currentSelection: PluginSelection;
  nextSelection: PluginSelection;
  package: InstalledPluginPackage | null;
}>;
export type PluginPreparedSelection = Readonly<{
  /** Synchronous local-facts fence inside the Store transaction, before any selection or receipt write.
   * Asynchronous authority decisions must finish during prepareSelection. Replay does not call this. */
  assertBeforeSelectionCommit?(
    input: Readonly<{ selection: PluginSelection }>,
  ): void;
  /** Optional current-authority refresh after confirmed Store COMMIT, before synchronous publication. */
  prepareCommit?(
    input: Readonly<{ selection: PluginSelection }>,
  ): Promise<void>;
  /**
   * Synchronous publication only after the Store confirms this exact durable selection. The adapter
   * must fence every new admission against the latest durable profile selection, including while
   * publication is pending, so the old projection cannot accept new tasks for stale desired state.
   */
  commit(input: Readonly<{ selection: PluginSelection }>): void;
  /** Discards only this prepared candidate; preserves previous instances and historical leases. */
  abort(): Promise<void>;
}>;

/** Required trusted integration; this port has no default compatibility, trust or runtime readiness. */
export interface PluginInstallationHostPort {
  /**
   * Resolves the immutable source within current authority, checks publisher policy and exact expected
   * identity, and installs verified bytes before returning. Source and install paths remain private.
   * This operation executes no plugin. A later DB failure may leave an unselected content-addressed
   * artifact; it must not delete shared artifacts or imply that filesystem publication rolled back.
   */
  install(
    input: PluginInstallationHostInstallInput,
  ): Promise<PluginInstallationHostIdentity>;
  /**
   * Stages selection without changing current discovery/admission. Must validate exact package,
   * runtime/dependencies/configuration/current data schema, including version switches while disabled.
   * Disable/uninstall also prepare withdrawal. Desired selection and observed runtime health remain
   * separate; successful preparation is not a permanent grant for any Run or external API call.
   */
  prepareSelection(
    input: PluginInstallationPrepareSelectionInput,
  ): Promise<PluginPreparedSelection>;
}
