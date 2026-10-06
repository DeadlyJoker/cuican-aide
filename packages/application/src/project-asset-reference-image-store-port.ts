import {
  projectAssetInputFields,
  projectAssetId,
  projectAssetKind,
  projectAssetRevision,
  type ProjectAssetKind,
  type ProjectAsset,
  type ProjectAssetRevision,
  type ProjectAssetReferenceRevision,
  type OperationResultLink,
  type ExtensionConfiguration,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";

/** Business identities only. URLs and supplier filenames are never caller input. */
export type ProjectAssetReferenceImageQuery = Readonly<{
  projectId: string;
  assetId: string;
  kind: ProjectAssetKind;
  expectedAssetRevision: number;
  contentRevision: number;
  referenceRevision: number;
}>;

export function parseProjectAssetReferenceImageQuery(
  input: unknown,
): ProjectAssetReferenceImageQuery {
  const q = projectAssetInputFields(input, [
    "projectId",
    "assetId",
    "kind",
    "expectedAssetRevision",
    "contentRevision",
    "referenceRevision",
  ]);
  return Object.freeze({
    projectId: projectAssetId(q.projectId),
    assetId: projectAssetId(q.assetId),
    kind: projectAssetKind(q.kind),
    expectedAssetRevision: projectAssetRevision(q.expectedAssetRevision),
    contentRevision: projectAssetRevision(q.contentRevision),
    referenceRevision: projectAssetRevision(q.referenceRevision),
  });
}

/** Host-internal read provenance, not a byte-read, upload or execution grant.
 * The historical configuration can contain credential binding IDs; never expose this envelope to plugin UI/Agent.
 */
export type ProjectAssetReferenceImageSource = Readonly<{
  asset: ProjectAsset;
  content: ProjectAssetRevision;
  reference: ProjectAssetReferenceRevision;
  resultLink: OperationResultLink;
  configuration: ExtensionConfiguration;
}>;

/** Additional read port; the existing asset storage and plugin protocols stay unchanged. */
export interface ProjectAssetReferenceImageStore {
  loadReferenceImageSource(
    input: Readonly<{
      actor: ActorContext;
      query: ProjectAssetReferenceImageQuery;
    }>,
  ): Promise<ProjectAssetReferenceImageSource>;
}
