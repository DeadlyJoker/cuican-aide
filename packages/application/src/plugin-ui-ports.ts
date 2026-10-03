import type {
  PluginPackageDescriptor,
  PluginUiJsonValue,
  PluginUiLease,
} from "@crewon/contracts/plugins";
import type {
  InstalledPluginPackage,
  PluginProfileScope,
  PluginSelection,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";

export type { PluginUiJsonValue } from "@crewon/contracts/plugins";

export type PluginUiPackageContext = Readonly<{
  actor: ActorContext;
  scope: PluginProfileScope;
  selection: PluginSelection;
  package: InstalledPluginPackage;
}>;
export type PluginUiVerifiedPackage = Readonly<{
  descriptor: PluginPackageDescriptor;
  /** Host-approved browser publication subset, not the entire Node/UI inventory by default. */
  publicAssets: readonly string[];
}>;
export interface PluginUiPackagePort {
  /** Derives the private directory from installed identity, verifies bytes and publisher policy. */
  verify(input: PluginUiPackageContext): Promise<PluginUiVerifiedPackage>;
  /** Reads only the lease's approved inventory path; rejects links, races, mismatched bytes and URLs. */
  readAsset(
    input: PluginUiPackageContext &
      Readonly<{ lease: PluginUiLease; path: string }>,
  ): Promise<Readonly<{ bytes: Uint8Array; contentType: string }>>;
}
export type PluginUiAuthorizationAction =
  | "catalog"
  | "mount"
  | "asset"
  | "invoke";
export type PluginUiAuthorizationResource = PluginProfileScope &
  Readonly<{
    kind: "pluginUi";
    pluginId: string | null;
    packageDigest: string | null;
    selectionRevision: number | null;
    contributionId: string | null;
  }>;
export type PluginUiAuthorizationDecision =
  | Readonly<{ outcome: "allow"; authorityEpoch: string }>
  | Readonly<{ outcome: "deny"; reasonCode: string }>;
export interface PluginUiAuthorizationPort {
  /** Current policy with a revocation epoch; metadata-read permission is not mount/action authority. */
  authorize(
    input: Readonly<{
      actor: ActorContext;
      action: PluginUiAuthorizationAction;
      resource: PluginUiAuthorizationResource;
    }>,
  ): Promise<PluginUiAuthorizationDecision>;
}
export interface PluginUiOpaqueIdPort {
  /** Unpredictable unique host-issued reference; 32..128 ASCII letters, digits, '_' or '-'. */
  nextId(): string;
}
export type PluginUiActionContext = PluginUiPackageContext &
  Readonly<{
    lease: PluginUiLease;
    authorityEpoch: string;
    action: string;
    input: PluginUiJsonValue;
  }>;
declare const pluginUiCommittedTaskOutcomeTag: unique symbol;
/** Host-only opaque capability. Neither its TypeScript shape nor plugin JSON proves a commit. */
export type PluginUiCommittedTaskOutcome = Readonly<{
  [pluginUiCommittedTaskOutcomeTag]: true;
}>;
export interface PluginUiCommittedTaskPort {
  /** Only a private registry membership check may recognize an issued outcome. */
  isOutcome(input: unknown): input is PluginUiCommittedTaskOutcome;
  /** Synchronous, single-use projection of an already verified durable task for this exact invocation. */
  verify(
    context: PluginUiActionContext,
    outcome: PluginUiCommittedTaskOutcome,
  ): PluginUiJsonValue;
}
declare const pluginUiCommittedMetadataOutcomeTag: unique symbol;
/** Host-only metadata receipt, separately owned from task/Run admission. */
export type PluginUiCommittedMetadataOutcome = Readonly<{
  [pluginUiCommittedMetadataOutcomeTag]: true;
}>;
export interface PluginUiCommittedMetadataPort {
  /** Recognizes only outcomes issued after the owner's actual metadata Service returned. */
  isOutcome(input: unknown): input is PluginUiCommittedMetadataOutcome;
  /** Single-use projection for the original invocation; never grants current action authority. */
  verify(
    context: PluginUiActionContext,
    outcome: PluginUiCommittedMetadataOutcome,
  ): PluginUiJsonValue;
}
export interface PluginUiActionPort {
  /**
   * Required host allowlist and dispatch fence. Rechecks current durable selection/authority at actual
   * dispatch, binds actions to this contribution, and never treats arbitrary names as Node services.
   * Actor/profile authority is taken from context, never from identity fields inside the JSON input.
   * Run/Tool/credit admission remains the responsibility of its existing authorized business boundary.
   */
  invoke(
    input: PluginUiActionContext,
  ): Promise<
    | PluginUiJsonValue
    | PluginUiCommittedTaskOutcome
    | PluginUiCommittedMetadataOutcome
  >;
}
