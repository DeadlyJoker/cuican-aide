import { ApplicationError } from "./application-error.ts";
import { CreativeProjectApplicationService } from "./creative-project-application-service.ts";
import {
  ProjectAssetApplicationService,
  isProjectAssetApplicationService,
} from "./project-asset-application-service.ts";
import {
  projectAssetOwnFields,
  projectAssetBoundMethod,
} from "./project-asset-application-support.ts";
import { mediaInputSame } from "./project-media-input-record.ts";
import { projectMediaResultAssertVoid } from "./project-media-result-record.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ProjectAssetReferenceImageQuery } from "./project-asset-reference-image-store-port.ts";
import type {
  ProjectMediaResultAuthority,
  ProjectMediaResultAuthorizationPort,
  ProjectMediaResultRequest,
} from "./project-media-result-port.ts";
import {
  parseProjectAssetMediaReferenceImageRequest,
  parseProjectAssetMediaReferenceImageSource,
  projectAssetMediaReferenceImageResultRequest,
  type ProjectAssetMediaReferenceImageRequest,
  type ProjectAssetMediaReferenceImageStore,
} from "./project-asset-media-reference-image.ts";

/** Authorized current pointer + original saved result. This read snapshot is not a freeze or execution grant. */
export class ProjectAssetMediaReferenceImageApplicationService {
  readonly #project: CreativeProjectApplicationService["getProject"];
  readonly #asset: ProjectAssetApplicationService["getAsset"];
  readonly #load: ProjectAssetMediaReferenceImageStore["loadAdoptedAssetReference"];
  readonly #authorization: ProjectMediaResultAuthorizationPort;
  constructor(
    input: Readonly<{
      projects: CreativeProjectApplicationService;
      assets: ProjectAssetApplicationService;
      store: ProjectAssetMediaReferenceImageStore;
      authorization: ProjectMediaResultAuthorizationPort;
    }>,
  ) {
    const d = projectAssetOwnFields(input, [
      "projects",
      "assets",
      "store",
      "authorization",
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
    this.#load = projectAssetBoundMethod(d.store, "loadAdoptedAssetReference");
    this.#authorization = Object.freeze({
      authorize: projectAssetBoundMethod<
        ProjectMediaResultAuthorizationPort["authorize"]
      >(d.authorization, "authorize"),
      assertActive: projectAssetBoundMethod<
        ProjectMediaResultAuthorizationPort["assertActive"]
      >(d.authorization, "assertActive"),
    });
  }
  async resolveSelectedReference(
    actor: ActorContext,
    query: ProjectAssetReferenceImageQuery,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    const r = parseProjectAssetMediaReferenceImageRequest({ actor, query }),
      o = projectAssetOwnFields(options, ["signal"]);
    if (!(o.signal instanceof AbortSignal)) invalid("signal_invalid");
    const signal = AbortSignal.any([o.signal, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    const before = await this.#current(r, signal),
      resultRequest = projectAssetMediaReferenceImageResultRequest(
        r,
        before.reference,
      ),
      authority = this.#authority(resultRequest, signal);
    await authority.assertCurrent();
    const source = parseProjectAssetMediaReferenceImageSource(
      await this.#load(r, authority),
      r,
    );
    authority.assertActive();
    if (
      !mediaInputSame(source.asset, before.view.asset) ||
      !mediaInputSame(source.content, before.view.selectedRevision) ||
      !mediaInputSame(source.reference, before.reference)
    )
      invalid("changed");
    await authority.assertCurrent();
    const after = await this.#current(r, signal);
    if (!mediaInputSame(before, after)) invalid("changed");
    authority.assertActive();
    return source;
  }
  async #current(
    r: ProjectAssetMediaReferenceImageRequest,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const project = await this.#project(r.actor, {
      projectId: r.query.projectId,
    });
    signal.throwIfAborted();
    if (project.state !== "active") invalid("project_archived");
    const view = await this.#asset(r.actor, {
      projectId: r.query.projectId,
      assetId: r.query.assetId,
    });
    signal.throwIfAborted();
    if (!view) invalid("asset_missing");
    if (
      view.asset.kind !== r.query.kind ||
      view.asset.revision !== r.query.expectedAssetRevision ||
      view.asset.selectedContentRevision !== r.query.contentRevision ||
      view.asset.selectedReferenceRevision !== r.query.referenceRevision
    )
      invalid("changed");
    if (
      view.dependencyState !== "current" ||
      view.referenceState !== "current" ||
      !view.selectedRevision
    )
      invalid("stale");
    if (
      view.selectedReference?.schemaVersion !==
      "crewon.project-asset-reference.v2"
    )
      invalid("source_kind_mismatch");
    const settled = await this.#project(r.actor, {
      projectId: r.query.projectId,
    });
    signal.throwIfAborted();
    if (!mediaInputSame(project, settled)) invalid("changed");
    return { project, view, reference: view.selectedReference };
  }
  #authority(
    request: ProjectMediaResultRequest,
    signal: AbortSignal,
  ): ProjectMediaResultAuthority {
    const permission = Object.freeze({
      actor: request.actor,
      action: "projectMediaResult:read" as const,
      resource: request.query,
    });
    const assertActive = () => {
      signal.throwIfAborted();
      projectMediaResultAssertVoid(
        this.#authorization.assertActive(permission),
      );
      signal.throwIfAborted();
    };
    return Object.freeze({
      request,
      action: "read",
      assertActive,
      assertCurrent: async () => {
        assertActive();
        const decision = await this.#authorization.authorize(permission);
        assertActive();
        if (decision.outcome !== "allow")
          throw new ApplicationError(
            "authorization",
            "project_asset_media_reference_image_read_denied",
          );
      },
    });
  }
}
function invalid(code: string): never {
  throw new ApplicationError(
    "conflict",
    `project_asset_media_reference_image_${code}`,
  );
}
