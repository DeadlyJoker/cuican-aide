import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { ProjectAssetReferenceImageQuery } from "./project-asset-reference-image-store-port.ts";
import type { ProjectReferenceMaterialObservation } from "./project-reference-material-read-port.ts";
import type { ProjectAssetMediaImageSource } from "@crewon/domain";

/** Host-owned source archive. A supplier transfer and media admission are separate operations. */
export type ProjectReferenceMaterialFreezeRequest = Readonly<{
  actor: ActorContext;
  query: ProjectAssetReferenceImageQuery;
  idempotencyKey: string;
}>;
export type FrozenProjectConceptReferenceMaterial = Readonly<{
  schemaVersion: "crewon.project-reference-frozen-material.v1";
  archiveId: string;
  materialId: string;
  requestDigest: string;
  request: ProjectReferenceMaterialFreezeRequest;
  source: ProjectReferenceMaterialObservation;
}>;
/** Saved media has its own provenance; concept result links are never manufactured. */
export type ProjectAdoptedMediaMaterialObservation = Readonly<{
  actor: ActorContext;
  projectId: string;
  assetId: string;
  assetRevision: number;
  contentRevision: number;
  contentDigest: string;
  referenceRevision: number;
  referenceDigest: string;
  media: ProjectAssetMediaImageSource;
  byteDigest: string;
  byteLength: number;
  mediaType: "image/png";
  width: number;
  height: number;
  observedAt: string;
}>;
export type FrozenProjectAdoptedMediaMaterial = Readonly<{
  schemaVersion: "crewon.project-reference-frozen-material.v2";
  archiveId: string;
  materialId: string;
  requestDigest: string;
  request: ProjectReferenceMaterialFreezeRequest;
  source: ProjectAdoptedMediaMaterialObservation;
}>;
export type FrozenProjectReferenceMaterial =
  | FrozenProjectConceptReferenceMaterial
  | FrozenProjectAdoptedMediaMaterial;
export type FrozenProjectReferenceMaterialContent = Readonly<{
  record: FrozenProjectReferenceMaterial;
  bytes: Uint8Array;
}>;
export interface ProjectReferenceMaterialArchivePort {
  readonly archiveId: string;
  load(
    request: ProjectReferenceMaterialFreezeRequest,
  ): Promise<FrozenProjectReferenceMaterialContent | null>;
  save(input: FrozenProjectReferenceMaterialContent): Promise<
    Readonly<{
      disposition: "created" | "replayed";
      record: FrozenProjectReferenceMaterial;
    }>
  >;
}
export interface ProjectReferenceMaterialFreezeAuthorizationPort {
  authorize(
    input: Readonly<{
      actor: ActorContext;
      action: "projectReferenceMaterial:freeze";
      resource: Readonly<{
        archiveId: string;
        materialId: string;
        query: ProjectAssetReferenceImageQuery;
        referenceDigest: string;
        resultLinkDigest: string;
        sourceBindingDigest: string;
        packageDigest: string;
        configurationDigest: string;
      }>;
    }>,
  ): Promise<AuthorizationDecision>;
}
export interface ProjectAdoptedMediaMaterialFreezeAuthorizationPort {
  authorize(
    input: Readonly<{
      actor: ActorContext;
      action: "projectReferenceMaterial:freeze";
      resource: Readonly<{
        sourceKind: "media-result";
        archiveId: string;
        materialId: string;
        query: ProjectAssetReferenceImageQuery;
        referenceDigest: string;
        media: ProjectAssetMediaImageSource;
      }>;
    }>,
  ): Promise<AuthorizationDecision>;
}
