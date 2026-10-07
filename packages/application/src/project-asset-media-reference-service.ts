import {
  extensionCanonicalJson,
  parseProjectAsset,
  parseProjectAssetRevision,
  parseProjectAssetMediaImageSource,
  projectAssetInputFields,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { CreativeProjectApplicationService } from "./creative-project-application-service.ts";
import {
  ProjectAssetApplicationService,
  isProjectAssetApplicationService,
} from "./project-asset-application-service.ts";
import {
  projectAssetOwnFields,
  projectAssetBoundMethod,
} from "./project-asset-application-support.ts";
import { captureProjectMediaResultAuthority } from "./project-media-result-record.ts";
import type { ProjectMediaResultAuthority } from "./project-media-result-port.ts";
import {
  parseProjectAssetMediaReferenceQualificationRequest,
  projectAssetMediaReferenceResultRequest,
  type ProjectAssetMediaReferenceQualificationRequest,
  type ProjectAssetMediaReferenceQualificationStore,
  type QualifiedProjectAssetMediaReference,
} from "./project-asset-media-reference-qualification.ts";

/** Original project/asset read authorization plus original result read authority.
 * This returns a bounded preparation snapshot, never a transferable write grant.
 */
export class ProjectAssetMediaReferenceApplicationService {
  readonly #project: CreativeProjectApplicationService["getProject"];
  readonly #asset: ProjectAssetApplicationService["getAsset"];
  readonly #qualify: ProjectAssetMediaReferenceQualificationStore["qualifyAssetReference"];
  readonly #digester: ContentDigester;
  constructor(
    input: Readonly<{
      projects: CreativeProjectApplicationService;
      assets: ProjectAssetApplicationService;
      store: ProjectAssetMediaReferenceQualificationStore;
      digester: ContentDigester;
    }>,
  ) {
    const d = projectAssetOwnFields(input, [
      "projects",
      "assets",
      "store",
      "digester",
    ]);
    if (
      !(d.projects instanceof CreativeProjectApplicationService) ||
      !isProjectAssetApplicationService(d.assets)
    )
      invalid("unavailable");
    this.#project = CreativeProjectApplicationService.prototype.getProject.bind(
      d.projects,
    );
    this.#asset = ProjectAssetApplicationService.prototype.getAsset.bind(
      d.assets,
    );
    this.#qualify = projectAssetBoundMethod(d.store, "qualifyAssetReference");
    this.#digester = Object.freeze({
      sha256: projectAssetBoundMethod<ContentDigester["sha256"]>(
        d.digester,
        "sha256",
      ),
    });
  }
  async qualifyReference(
    actor: ActorContext,
    query: ProjectAssetMediaReferenceQualificationRequest["query"],
    options: Readonly<{ authority: ProjectMediaResultAuthority }>,
  ): Promise<QualifiedProjectAssetMediaReference> {
    const request = parseProjectAssetMediaReferenceQualificationRequest({
        actor,
        query,
      }),
      o = projectAssetOwnFields(options, ["authority"]),
      authority = captureProjectMediaResultAuthority(
        o.authority as ProjectMediaResultAuthority,
        projectAssetMediaReferenceResultRequest(request),
        "read",
      ),
      q = request.query;
    await authority.assertCurrent();
    authority.assertActive();
    const before = await this.#current(request),
      raw = projectAssetInputFields(await this.#qualify(request, authority), [
        "asset",
        "content",
        "source",
      ]),
      asset = parseProjectAsset(raw.asset),
      content = parseProjectAssetRevision(raw.content, this.#digester),
      source = parseProjectAssetMediaImageSource(raw.source);
    if (
      extensionCanonicalJson(asset) !==
        extensionCanonicalJson(before.view.asset) ||
      extensionCanonicalJson(content) !==
        extensionCanonicalJson(before.view.selectedRevision) ||
      source.generatedFor.assetId !== q.assetId ||
      source.generatedFor.contentRevision !== q.assetContentRevision ||
      source.generatedFor.contentDigest !== content.contentDigest ||
      source.candidateId !== q.candidateId ||
      source.candidateDigest !== q.candidateDigest ||
      source.sourceRunId !== q.runId ||
      source.resultIndex !== q.resultIndex
    )
      invalid("proof_invalid");
    const after = await this.#current(request);
    if (extensionCanonicalJson(before) !== extensionCanonicalJson(after))
      invalid("changed");
    await authority.assertCurrent();
    authority.assertActive();
    return Object.freeze({ asset, content, source });
  }
  async #current(request: ProjectAssetMediaReferenceQualificationRequest) {
    const { actor, query: q } = request,
      project = await this.#project(actor, { projectId: q.projectId });
    if (project.state !== "active") invalid("project_archived");
    const view = await this.#asset(actor, {
      projectId: q.projectId,
      assetId: q.assetId,
    });
    if (!view) invalid("asset_not_found");
    if (view.asset.kind !== "character") invalid("purpose_mismatch");
    if (view.asset.locked) invalid("asset_locked");
    if (
      view.asset.revision !== q.expectedAssetRevision ||
      view.asset.selectedContentRevision !== q.assetContentRevision
    )
      invalid("asset_changed");
    if (view.dependencyState !== "current" || !view.selectedRevision)
      invalid("source_stale");
    return { project, view };
  }
}
function invalid(code: string): never {
  throw new ApplicationError(
    "conflict",
    `project_asset_media_reference_${code}`,
  );
}
