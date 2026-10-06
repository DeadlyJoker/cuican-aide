import {
  captureProjectMediaInputAuthorization,
  captureProjectMediaWorkflowReviews,
  captureProjectGenerationImageResultVerifier,
  materialPreparationFields,
  projectMediaInputBound,
  type ActorContext,
  type ProjectMediaInputAuthorizationPort,
  type ProjectMediaGenerationAuthorizationPort,
  type ProjectGenerationImageResultVerifier,
  type ProjectMediaWorkflowReview,
} from "@crewon/application";
import { projectAssetId } from "@crewon/domain";
import type { ProjectMediaMaterialPreparer } from "@crewon/media-runtime";
import type { SqliteRunStore, PostgresDomainStore } from "@crewon/store";

/** Trusted host composition, never plugin JSON. Each material PDP must call these guards around its own purpose check. */
export type ProjectMediaGenerationMaterialScope = Readonly<{
  store: SqliteRunStore | PostgresDomainStore;
  signal: AbortSignal;
  metadataAuthorization: ProjectMediaInputAuthorizationPort;
  assertCurrent(actor: ActorContext): Promise<void>;
  /** Policy/lifetime only. Use for projectMaterial:prepare, whose PDP also runs inside SQL. */
  assertTransactionCurrent(actor: ActorContext): Promise<void>;
  assertActive(actor: ActorContext): void;
}>;
export type InstalledProjectMediaGenerationConfiguration = Readonly<{
  version: "crewon.project-media-generation-control.v1";
  profileId: string;
  reviews: readonly ProjectMediaWorkflowReview[];
  metadataAuthorization: ProjectMediaInputAuthorizationPort;
  /** Independent generation purpose; callbacks must be transaction-safe. */
  authorization: ProjectMediaGenerationAuthorizationPort;
  verifier: ProjectGenerationImageResultVerifier;
  createMaterials(scope: ProjectMediaGenerationMaterialScope): Promise<
    Readonly<{
      materials: ProjectMediaMaterialPreparer;
      /** Joins factory resources only; never closes the borrowed parent or Core. */
      close(): Promise<void>;
    }>
  >;
}>;
export function captureInstalledProjectMediaGenerationConfiguration(
  input: InstalledProjectMediaGenerationConfiguration,
): InstalledProjectMediaGenerationConfiguration {
  const r = materialPreparationFields(input, [
    "version",
    "profileId",
    "reviews",
    "metadataAuthorization",
    "authorization",
    "verifier",
    "createMaterials",
  ]);
  if (r.version !== "crewon.project-media-generation-control.v1")
    throw new Error("installed_project_media_generation_configuration_invalid");
  return Object.freeze({
    version: r.version,
    profileId: projectAssetId(r.profileId),
    reviews: captureProjectMediaWorkflowReviews(
      r.reviews as readonly ProjectMediaWorkflowReview[],
    ),
    metadataAuthorization: captureProjectMediaInputAuthorization(
      r.metadataAuthorization as ProjectMediaInputAuthorizationPort,
    ),
    authorization: Object.freeze({
      authorize: projectMediaInputBound<
        ProjectMediaGenerationAuthorizationPort["authorize"]
      >(r.authorization, "authorize"),
      assertActive: projectMediaInputBound<
        ProjectMediaGenerationAuthorizationPort["assertActive"]
      >(r.authorization, "assertActive"),
    }),
    verifier: captureProjectGenerationImageResultVerifier(
      r.verifier as ProjectGenerationImageResultVerifier,
    ),
    createMaterials: projectMediaInputBound<
      InstalledProjectMediaGenerationConfiguration["createMaterials"]
    >(input, "createMaterials"),
  });
}
