import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseOperationResultLink,
  parseProjectAsset,
  parseProjectAssetRevision,
  parseProjectAssetReferenceRevision,
  assertProjectAssetRevisionIdentity,
  assertProjectAssetReferenceRevisionIdentity,
  projectAssetInputFields,
  type CreativeProject,
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
  projectAssetBoundMethod,
  projectAssetOwnFields,
  projectAssetUseCase,
} from "./project-asset-application-support.ts";
import {
  creativeActor,
  creativeInput,
  creativeStored,
} from "./creative-project-application-support.ts";
import type { ProjectAssetView } from "./project-asset-store-port.ts";
import {
  parseProjectAssetReferenceImageQuery,
  type ProjectAssetReferenceImageQuery,
  type ProjectAssetReferenceImageSource,
  type ProjectAssetReferenceImageStore,
} from "./project-asset-reference-image-store-port.ts";

export type ProjectAssetReferenceImageApplicationDependencies = Readonly<{
  projects: CreativeProjectApplicationService;
  assets: ProjectAssetApplicationService;
  store: ProjectAssetReferenceImageStore;
  digester: ContentDigester;
}>;

/** Resolve the adopted reference through the original authorized project and generation proof.
 * No media I/O, selection, Run creation, billing or supplier submission happens here.
 */
export class ProjectAssetReferenceImageApplicationService {
  readonly #project: CreativeProjectApplicationService["getProject"];
  readonly #asset: ProjectAssetApplicationService["getAsset"];
  readonly #source: ProjectAssetReferenceImageStore["loadReferenceImageSource"];
  readonly #digester: ContentDigester;

  constructor(input: ProjectAssetReferenceImageApplicationDependencies) {
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
      throw new ApplicationError(
        "internal",
        "project_asset_reference_image_unavailable",
      );
    // Capture the original class methods; instance overrides cannot replace authorization.
    this.#project = CreativeProjectApplicationService.prototype.getProject.bind(
      d.projects,
    );
    this.#asset = ProjectAssetApplicationService.prototype.getAsset.bind(
      d.assets,
    );
    this.#source = projectAssetBoundMethod(d.store, "loadReferenceImageSource");
    this.#digester = Object.freeze({
      sha256: projectAssetBoundMethod<ContentDigester["sha256"]>(
        d.digester,
        "sha256",
      ),
    });
  }

  resolveSelectedReference(
    actorInput: ActorContext,
    queryInput: ProjectAssetReferenceImageQuery,
  ): Promise<ProjectAssetReferenceImageSource> {
    return projectAssetUseCase(async () => {
      const actor = creativeActor(actorInput),
        query = creativeInput(() =>
          parseProjectAssetReferenceImageQuery(queryInput),
        );
      const project = await this.#currentProject(actor, query),
        view = await this.#currentAsset(actor, query);
      const raw = await this.#source(Object.freeze({ actor, query }));
      const result = creativeStored(() =>
        this.#checked(raw, actor, query, view),
      );
      // These reads also reauthorize after the provenance awaits. Never return a stale pointer snapshot.
      const finalProject = await this.#currentProject(actor, query),
        finalView = await this.#currentAsset(actor, query),
        settledProject = await this.#currentProject(actor, query);
      if (
        extensionCanonicalJson(project) !==
          extensionCanonicalJson(finalProject) ||
        extensionCanonicalJson(project) !==
          extensionCanonicalJson(settledProject) ||
        extensionCanonicalJson(view) !== extensionCanonicalJson(finalView)
      )
        throw new ApplicationError(
          "conflict",
          "project_asset_reference_image_changed",
        );
      return result;
    });
  }

  async #currentProject(
    actor: ActorContext,
    q: ProjectAssetReferenceImageQuery,
  ): Promise<CreativeProject> {
    const p = await this.#project(actor, { projectId: q.projectId });
    if (p.state !== "active")
      throw new ApplicationError("conflict", "creative_project_archived");
    return p;
  }

  async #currentAsset(
    actor: ActorContext,
    q: ProjectAssetReferenceImageQuery,
  ): Promise<ProjectAssetView> {
    const v = await this.#asset(actor, {
      projectId: q.projectId,
      assetId: q.assetId,
    });
    if (v === null)
      throw new ApplicationError("notFound", "project_asset_not_found");
    if (
      v.asset.kind !== q.kind ||
      v.asset.revision !== q.expectedAssetRevision ||
      v.asset.selectedContentRevision !== q.contentRevision ||
      v.asset.selectedReferenceRevision !== q.referenceRevision
    )
      throw new ApplicationError(
        "conflict",
        "project_asset_reference_image_changed",
      );
    if (v.dependencyState !== "current" || v.referenceState !== "current")
      throw new ApplicationError("conflict", "project_asset_source_stale");
    return v;
  }

  #checked(
    raw: unknown,
    a: ActorContext,
    q: ProjectAssetReferenceImageQuery,
    view: ProjectAssetView,
  ): ProjectAssetReferenceImageSource {
    const r = projectAssetInputFields(raw, [
        "asset",
        "content",
        "reference",
        "resultLink",
        "configuration",
      ]),
      asset = parseProjectAsset(r.asset),
      content = parseProjectAssetRevision(r.content, this.#digester),
      reference = parseProjectAssetReferenceRevision(
        r.reference,
        this.#digester,
      ),
      resultLink = parseOperationResultLink(r.resultLink, this.#digester),
      configuration = parseExtensionConfiguration(
        r.configuration,
        this.#digester,
      );
    assertProjectAssetRevisionIdentity(asset, content);
    assertProjectAssetReferenceRevisionIdentity(asset, reference);
    if (
      extensionCanonicalJson(asset) !== extensionCanonicalJson(view.asset) ||
      extensionCanonicalJson(content) !==
        extensionCanonicalJson(view.selectedRevision) ||
      extensionCanonicalJson(reference) !==
        extensionCanonicalJson(view.selectedReference) ||
      reference.assetContentRevision !== content.contentRevision ||
      reference.assetContentDigest !== content.contentDigest ||
      resultLink.tenantId !== a.tenantId ||
      resultLink.spaceId !== a.spaceId ||
      resultLink.ownerPrincipalId !== a.principalId ||
      resultLink.projectId !== q.projectId
    )
      invalid();
    const s = reference.source;
    const expected = {
      conceptAssetId: resultLink.reference.assetId,
      conceptAssetRevision: resultLink.reference.assetRevision,
      resultLinkDigest: resultLink.contentDigest,
      generationLinkDigest: resultLink.generationLinkDigest,
      sourceRunId: resultLink.sourceRunId,
      sourceBindingDigest: resultLink.sourceBindingDigest,
      pluginId: resultLink.pluginId,
      pluginVersion: resultLink.pluginVersion,
      packageDigest: resultLink.packageDigest,
      configurationRevision: resultLink.configurationRevision,
      configurationDigest: resultLink.configurationDigest,
      operationId: resultLink.operationId,
      operationRevision: resultLink.operationRevision,
      operationDigest: resultLink.operationDigest,
      rawResultDigest: resultLink.rawResultDigest,
      resultIndex: resultLink.image.resultIndex,
    };
    if (
      Object.entries(expected).some(([k, v]) => s[k as keyof typeof s] !== v) ||
      configuration.tenantId !== a.tenantId ||
      configuration.spaceId !== a.spaceId ||
      configuration.pluginId !== s.pluginId ||
      configuration.pluginVersion !== s.pluginVersion ||
      configuration.revision !== s.configurationRevision ||
      configuration.contentDigest !== s.configurationDigest
    )
      invalid();
    return Object.freeze({
      asset,
      content,
      reference,
      resultLink,
      configuration,
    });
  }
}

function invalid(): never {
  throw new ApplicationError(
    "internal",
    "project_asset_reference_image_proof_invalid",
  );
}
