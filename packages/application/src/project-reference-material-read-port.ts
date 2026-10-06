import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { ProjectAssetReferenceImageSource } from "./project-asset-reference-image-store-port.ts";

/** Independently approved host I/O policy. Project-read permission alone does not permit network access. */
export interface ProjectReferenceMaterialReadAuthorizationPort {
  authorize(
    input: Readonly<{
      actor: ActorContext;
      action: "projectReferenceMaterial:read";
      resource: Readonly<{
        projectId: string;
        assetId: string;
        referenceRevision: number;
        referenceDigest: string;
        resultLinkDigest: string;
        sourceBindingDigest: string;
        pluginId: string;
        pluginVersion: string;
        packageDigest: string;
        configurationRevision: number;
        operationId: string;
        configurationDigest: string;
        origin: string;
        path: string;
      }>;
    }>,
  ): Promise<AuthorizationDecision>;
}

/** Pure trusted provider decoder. Its destination data is not an I/O or execution grant. */
export interface ProjectReferenceMaterialSourceAdapter {
  deriveReadDestination(source: ProjectAssetReferenceImageSource): Readonly<{
    origin: string;
    path: string;
    output: Readonly<{ filename: string; subfolder: string; type: "output" }>;
  }>;
}

/** A point-in-time byte observation. A mutable supplier file has not been frozen for execution. */
export type ProjectReferenceMaterialObservation = Readonly<{
  actor: ActorContext;
  projectId: string;
  assetId: string;
  assetRevision: number;
  contentRevision: number;
  contentDigest: string;
  referenceRevision: number;
  referenceDigest: string;
  resultLinkDigest: string;
  sourceBindingDigest: string;
  sourceRunId: string;
  operationId: string;
  pluginId: string;
  pluginVersion: string;
  packageDigest: string;
  configurationRevision: number;
  configurationDigest: string;
  origin: string;
  output: Readonly<{ filename: string; subfolder: string; type: "output" }>;
  byteDigest: string;
  byteLength: number;
  mediaType: "image/png";
  width: number;
  height: number;
  observedAt: string;
}>;
