import {
  projectAssetMediaImageSourceFromResult,
  mediaInputSame,
  type ActorContext,
  type ProjectAssetCommitAuthority,
  type ProjectGenerationImageResultVerifier,
} from "@crewon/application";
import {
  projectAssetFailure,
  type ProjectAssetReferenceRevision,
} from "@crewon/domain";
import { verifyProjectAssetSavedImageSource } from "./project-asset-image-source.ts";
import { mediaResultLoadPlan } from "./project-media-result-plan.ts";
import { loadProjectMediaGenerationContextPlan } from "./project-media-generation-read.ts";
import {
  assetReference,
  assetOwner,
  type AssetDialect,
  type AssetSql,
  type AssetRows,
} from "./project-asset-store-support.ts";

export type AssetReferenceProofPlan<T> = Generator<
  | AssetSql
  | Readonly<{ mediaOperationSchema: true }>
  | Readonly<{ mediaResultSchema: true }>,
  T,
  AssetRows
>;
/** History selection and replay reprove the original saved output on the committing connection, without media I/O. */
export function* verifyProjectAssetMutationReference(
  d: AssetDialect,
  actor: ActorContext,
  reference: ProjectAssetReferenceRevision,
  verifier: ProjectGenerationImageResultVerifier | undefined,
  authority: ProjectAssetCommitAuthority | undefined,
): AssetReferenceProofPlan<void> {
  if (reference.schemaVersion === "crewon.project-asset-reference.v1") {
    yield* verifyProjectAssetSavedImageSource(d, actor, reference, verifier);
    return;
  }
  // V1 must reject before changing a pointer; its public codec cannot acknowledge a media reference.
  if (
    authority?.uiTransaction?.version ===
    "crewon.project-asset-plugin-commit.v1"
  )
    projectAssetFailure("project_asset_media_reference_reader_required");
  yield { mediaResultSchema: true };
  const source = reference.source,
    candidate = yield* mediaResultLoadPlan(d, {
      actor,
      query: {
        projectId: reference.projectId,
        runId: source.sourceRunId,
        resultIndex: source.resultIndex,
      },
    }),
    history = yield* loadProjectMediaGenerationContextPlan(d, {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      runId: source.sourceRunId,
    });
  if (
    !candidate ||
    !history ||
    history.link.contentDigest !==
      candidate.frozen.source.projection.generationDigest ||
    !mediaInputSame(
      projectAssetMediaImageSourceFromResult(candidate, history.input),
      source,
    )
  )
    projectAssetFailure("project_asset_reference_proof_changed");
  const anchor = source.generatedFor,
    original = yield* assetReference(
      d,
      assetOwner(actor),
      reference.projectId,
      reference.assetId,
      anchor.referenceRevision,
    );
  if (
    !original ||
    original.contentDigest !== anchor.referenceDigest ||
    original.assetContentRevision !== anchor.contentRevision ||
    original.assetContentDigest !== anchor.contentDigest
  )
    projectAssetFailure("project_asset_reference_proof_changed");
}
