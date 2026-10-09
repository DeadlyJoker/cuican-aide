import type {
  InstalledPluginPackage,
  PluginProfileScope,
  PluginSelection,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { PluginCompositionStore } from "./plugin-composition-store-port.ts";

export type PluginInstallationReceipt = Readonly<{
  idempotencyKey: string;
  requestDigest: string;
}>;
export type PluginInstallationMutationKind = "install" | "select";
export type InstalledPluginPackageResult = Readonly<{
  kind: "install";
  disposition: "committed" | "replayed";
  package: InstalledPluginPackage;
  selection: PluginSelection;
}>;
export type PluginSelectionResult = Readonly<{
  kind: "select";
  disposition: "committed" | "replayed";
  selection: PluginSelection;
}>;
export type PluginInstallationMutationResult =
  | InstalledPluginPackageResult
  | PluginSelectionResult;

type MutationIdentity = Readonly<{
  scope: PluginProfileScope;
  actor: ActorContext;
  receipt: PluginInstallationReceipt;
}>;

export type RecordInstalledPluginPackageInput = MutationIdentity &
  Readonly<{
    package: InstalledPluginPackage;
    /** Null requires an absent selection; otherwise compare the stored positive revision. */
    expectedSelectionRevision: number | null;
  }>;
export type CommitPluginSelectionInput = MutationIdentity &
  Readonly<{
    selection: PluginSelection;
    expectedSelectionRevision: number;
    /** Internal synchronous callback, never part of a persisted receipt or public JSON shape.
     * Called after receipt/CAS/full-record checks within the owned transaction, before writes.
     * A throw or non-undefined return aborts the transaction; receipt replay skips the callback. */
    beforeCommit?(input: Readonly<{ selection: PluginSelection }>): void;
  }>;

/**
 * Internal persistence only; host installation, trust, authorization and Node preflight are separate.
 * Every mutation checks actor tenant/space and the audit of newly written records, with receipt lookup
 * before CAS. Reused immutable packages and unchanged selections retain their original installer audit.
 * Receipt scope includes profile, full actor/principal, kind and key; a changed request digest conflicts.
 * Implementations atomically commit records and the complete immutable result snapshot. Replay returns
 * that snapshot, even if the current selection has since changed. Installed package audits never change.
 */
export interface PluginInstallationStore {
  /** Feature-detect on legacy stores. Shares this exact host connection and profile ownership. */
  compositionStore?(): PluginCompositionStore;
  loadPackage(
    input: Readonly<{
      scope: PluginProfileScope;
      packageDigest: string;
    }>,
  ): Promise<InstalledPluginPackage | null>;
  loadSelection(
    input: Readonly<{
      scope: PluginProfileScope;
      pluginId: string;
    }>,
  ): Promise<PluginSelection | null>;
  listPackages(
    input: Readonly<{
      scope: PluginProfileScope;
      pluginId: string | null;
      afterPackageDigest: string | null;
      /** Integer from 1 through 50. Results ascend by packageDigest. */
      limit: number;
    }>,
  ): Promise<
    Readonly<{
      packages: readonly InstalledPluginPackage[];
      /** Last returned digest only when another page exists. */
      next: string | null;
    }>
  >;
  listSelections(
    input: Readonly<{
      scope: PluginProfileScope;
      afterPluginId: string | null;
      /** Integer from 1 through 50. Results ascend by pluginId. */
      limit: number;
    }>,
  ): Promise<
    Readonly<{
      selections: readonly PluginSelection[];
      /** Last returned plugin ID only when another page exists. */
      next: string | null;
    }>
  >;
  loadReceipt(
    input: MutationIdentity &
      Readonly<{ kind: PluginInstallationMutationKind }>,
  ): Promise<PluginInstallationMutationResult | null>;
  /**
   * First install creates a disabled selection at revision 1. Later versions preserve a live selection;
   * install after logical uninstall selects this installed digest as disabled and increments revision.
   * Publisher is permanently pinned per namespace, and a version cannot be rebound to different bytes.
   * Reinstalling an existing digest retains its original record and audit, including for a fresh receipt.
   */
  recordInstalledPackage(
    input: RecordInstalledPluginPackageInput,
  ): Promise<InstalledPluginPackageResult>;
  /**
   * Requires an existing namespace, expected CAS revision and exactly its next revision; publisher stays
   * pinned. Uninstalled requires a null digest; enabled/disabled require a saved package in this scope
   * and namespace.
   * Logical uninstall removes neither historical packages nor business data and invokes no plugin code.
   */
  commitSelection(
    input: CommitPluginSelectionInput,
  ): Promise<PluginSelectionResult>;
}
