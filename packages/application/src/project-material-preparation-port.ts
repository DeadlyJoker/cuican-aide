import type {
  ExtensionConfiguration,
  InstalledPluginPackage,
  PluginSelection,
} from "@crewon/domain";
import type {
  ProjectReferenceMaterialFreezeRequest,
  FrozenProjectReferenceMaterial,
} from "./project-reference-material-freeze-port.ts";
import type { ProjectToolInstallationPin } from "./creative-project-run-commit-authority.ts";

/** Business request only. Neither a URL nor a supplier path can be supplied by UI/Agent. */
export type ProjectMaterialPreparationRequest = Readonly<{
  source: ProjectReferenceMaterialFreezeRequest;
  target: Readonly<{
    profileId: string;
    pluginId: string;
    configurationRevision: number;
  }>;
  idempotencyKey: string;
}>;
/** Actual host installation/config snapshot, requalified from storage at each transaction. */
export type ProjectMaterialPreparationTarget = Readonly<{
  installation: ProjectToolInstallationPin;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  configuration: ExtensionConfiguration;
}>;
export type ProjectMaterialPreparationInitial = Readonly<{
  schemaVersion:
    | "crewon.project-material-preparation.v1"
    | "crewon.project-material-preparation.v2";
  intentId: string;
  requestDigest: string;
  request: ProjectMaterialPreparationRequest;
  source: FrozenProjectReferenceMaterial;
  target: ProjectMaterialPreparationTarget;
  transfer: Readonly<{
    adapter: "comfyui-image-upload.v1";
    preparationId: string;
    origin: string;
    output: Readonly<{ filename: string; subfolder: string; type: "output" }>;
    requestDigest: string;
  }>;
  createdAt: string;
  contentDigest: string;
}>;
export type ProjectMaterialPreparationPhase =
  | "reserved"
  | "dispatching"
  | "unknownOutcome"
  | "verified"
  | "rejected";
/** Verified is a past byte observation, never a current media/Run admission grant. */
export type ProjectMaterialPreparationEvent = Readonly<{
  intentId: string;
  initialDigest: string;
  revision: number;
  phase: ProjectMaterialPreparationPhase;
  observation: Readonly<{
    byteDigest: string;
    byteLength: number;
    width: number;
    height: number;
    checkedAt: string;
  }> | null;
  failureCode: string | null;
  at: string;
}>;
export type ProjectMaterialPreparationState = Readonly<{
  initial: ProjectMaterialPreparationInitial;
  event: ProjectMaterialPreparationEvent;
}>;
/** New purpose only. External profile/owner/PDP callbacks must not borrow the committing pool.
 * Captured callbacks are mandatory; installation pins and persisted DTOs alone confer no authority.
 */
export type ProjectMaterialPreparationCommitAuthority = Readonly<{
  version: "crewon.project-material-preparation-commit.v1";
  request: ProjectMaterialPreparationRequest;
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
export type ProjectMaterialPreparationReservation = Readonly<{
  request: ProjectMaterialPreparationRequest;
  source: FrozenProjectReferenceMaterial;
  target: ProjectMaterialPreparationTarget;
  proposedTransfer: Readonly<{ preparationId: string; requestDigest: string }>;
  at: string;
}>;
export interface ProjectMaterialPreparationStore {
  load(
    request: ProjectMaterialPreparationRequest,
    authority: ProjectMaterialPreparationCommitAuthority,
  ): Promise<ProjectMaterialPreparationState | null>;
  reserve(
    input: ProjectMaterialPreparationReservation,
    authority: ProjectMaterialPreparationCommitAuthority,
  ): Promise<
    Readonly<{
      disposition: "created" | "replayed";
      state: ProjectMaterialPreparationState;
    }>
  >;
  /** Only disposition=claimed may proceed to an independently authorized send.
   * Existing dispatch/unknown/terminal state never claims again; a DTO is not a network grant. */
  claimDispatch(
    input: Readonly<{
      request: ProjectMaterialPreparationRequest;
      expectedRevision: number;
      at: string;
    }>,
    authority: ProjectMaterialPreparationCommitAuthority,
  ): Promise<
    Readonly<{
      disposition: "claimed" | "existing";
      state: ProjectMaterialPreparationState;
    }>
  >;
  advance(
    input: Readonly<{
      request: ProjectMaterialPreparationRequest;
      expectedRevision: number;
      phase: "unknownOutcome" | "verified" | "rejected";
      observation: ProjectMaterialPreparationEvent["observation"];
      failureCode: string | null;
      at: string;
    }>,
    authority: ProjectMaterialPreparationCommitAuthority,
  ): Promise<ProjectMaterialPreparationState>;
}
