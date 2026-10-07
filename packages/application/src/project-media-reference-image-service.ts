import { types } from "node:util";
import { ProjectAssetApplicationService } from "./project-asset-application-service.ts";
import { ProjectAssetReferenceImageApplicationService } from "./project-asset-reference-image-application-service.ts";
import { ProjectAssetMediaReferenceImageApplicationService } from "./project-asset-media-reference-image-service.ts";
import { parseProjectAssetMediaReferenceImageRequest } from "./project-asset-media-reference-image.ts";
import type { ProjectMediaInputSource } from "./project-media-input-port.ts";
import type { ProjectAssetReferenceImageQuery } from "./project-asset-reference-image-store-port.ts";
import type { ActorContext } from "./authorization-port.ts";
import { projectMediaInputFail as fail } from "./project-media-input-record.ts";

/** Choose the reader from an original current asset record, never from a caller's origin hint. */
export class ProjectMediaReferenceImageApplicationService {
  readonly #asset: ProjectAssetApplicationService["getAsset"];
  readonly #concept: ProjectAssetReferenceImageApplicationService["resolveSelectedReference"];
  readonly #media: ProjectAssetMediaReferenceImageApplicationService["resolveSelectedReference"];
  constructor(
    input: Readonly<{
      assets: ProjectAssetApplicationService;
      concepts: ProjectAssetReferenceImageApplicationService;
      media: ProjectAssetMediaReferenceImageApplicationService;
    }>,
  ) {
    if (
      types.isProxy(input.assets) ||
      types.isProxy(input.concepts) ||
      types.isProxy(input.media) ||
      !(input.assets instanceof ProjectAssetApplicationService) ||
      !(
        input.concepts instanceof ProjectAssetReferenceImageApplicationService
      ) ||
      !(
        input.media instanceof ProjectAssetMediaReferenceImageApplicationService
      )
    )
      fail("dependency_invalid");
    this.#asset = ProjectAssetApplicationService.prototype.getAsset.bind(
      input.assets,
    );
    this.#concept =
      ProjectAssetReferenceImageApplicationService.prototype.resolveSelectedReference.bind(
        input.concepts,
      );
    this.#media =
      ProjectAssetMediaReferenceImageApplicationService.prototype.resolveSelectedReference.bind(
        input.media,
      );
  }
  async resolveSelectedReference(
    actor: ActorContext,
    query: ProjectAssetReferenceImageQuery,
  ): Promise<ProjectMediaInputSource> {
    const r = parseProjectAssetMediaReferenceImageRequest({ actor, query }),
      view = await this.#asset(r.actor, {
        projectId: r.query.projectId,
        assetId: r.query.assetId,
      });
    if (
      !view ||
      view.asset.revision !== r.query.expectedAssetRevision ||
      view.asset.selectedReferenceRevision !== r.query.referenceRevision ||
      view.asset.selectedContentRevision !== r.query.contentRevision ||
      view.asset.kind !== r.query.kind
    )
      fail("source_changed");
    if (
      view.selectedReference?.schemaVersion ===
      "crewon.project-asset-reference.v2"
    )
      return this.#media(r.actor, r.query, {
        signal: AbortSignal.timeout(30_000),
      });
    if (
      view.selectedReference?.schemaVersion ===
      "crewon.project-asset-reference.v1"
    )
      return this.#concept(r.actor, r.query);
    fail("reference_invalid");
  }
}
