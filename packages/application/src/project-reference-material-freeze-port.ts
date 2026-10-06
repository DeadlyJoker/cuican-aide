import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { ProjectAssetReferenceImageQuery } from "./project-asset-reference-image-store-port.ts";
import type { ProjectReferenceMaterialObservation } from "./project-reference-material-read-port.ts";

/** Host-owned source archive. A supplier transfer and media admission are separate operations. */
export type ProjectReferenceMaterialFreezeRequest = Readonly<{
  actor: ActorContext;
  query: ProjectAssetReferenceImageQuery;
  idempotencyKey: string;
}>;
export type FrozenProjectReferenceMaterial = Readonly<{
  schemaVersion: "crewon.project-reference-frozen-material.v1";
  archiveId: string;
  materialId: string;
  requestDigest: string;
  request: ProjectReferenceMaterialFreezeRequest;
  source: ProjectReferenceMaterialObservation;
}>;
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
