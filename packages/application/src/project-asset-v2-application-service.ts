import { types } from "node:util";
import {
  PROJECT_ASSET_V2_ACTIONS as actions,
  parseProjectAssetV2Request,
  parseProjectAssetV2Response,
  type ProjectAssetV2ReadRequest,
  type ProjectAssetV2MutationRequest,
  type AdoptProjectAssetMediaReferenceRequest,
} from "@crewon/contracts/project-assets-v2";
import {
  ProjectAssetApplicationService,
  isProjectAssetApplicationService,
} from "./project-asset-application-service.ts";
import { ProjectAssetMediaAdoptionApplicationService } from "./project-asset-media-adoption-service.ts";
import {
  projectAssetPublicReferenceV2,
  projectAssetPublicViewV2,
  projectAssetPublicMutationV2,
} from "./project-asset-public-v2.ts";
import {
  projectAssetPublicHead,
  projectAssetPublicPage,
  projectAssetPublicRevision,
} from "./plugin-project-asset-action-projection.ts";
import { projectAssetOwnFields } from "./project-asset-application-support.ts";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { PluginProjectReadScope } from "./plugin-project-read-scope.ts";
import {
  captureProjectAssetCommitAuthority,
  type ProjectAssetCommitAuthority,
} from "./project-asset-commit-authority.ts";

/** Shared public model for UI/Agent adapters. No route, tool or installation is registered implicitly. */
export class ProjectAssetV2ApplicationService {
  readonly #assets: ProjectAssetApplicationService;
  readonly #adoptions: ProjectAssetMediaAdoptionApplicationService | undefined;
  readonly #asset: ProjectAssetApplicationService["getAsset"];
  readonly #revision: ProjectAssetApplicationService["getRevision"];
  readonly #list: ProjectAssetApplicationService["listAssets"];
  readonly #revisions: ProjectAssetApplicationService["listRevisions"];
  readonly #mutations: Pick<
    ProjectAssetApplicationService,
    | "saveCandidate"
    | "selectRevision"
    | "setLocked"
    | "saveReferenceCandidate"
    | "selectReference"
  >;
  readonly #reference: ProjectAssetApplicationService["getReferenceRevision"];
  readonly #references: ProjectAssetApplicationService["listReferences"];
  readonly #adopt:
    | ProjectAssetMediaAdoptionApplicationService["adoptReference"]
    | undefined;
  constructor(
    input:
      | Readonly<{
          assets: ProjectAssetApplicationService;
          adoptions: ProjectAssetMediaAdoptionApplicationService;
        }>
      | Readonly<{
          assets: ProjectAssetApplicationService;
          access: "read-only";
        }>,
  ) {
    const readOnly = Object.hasOwn(input, "access");
    const d = projectAssetOwnFields(input, [
      "assets",
      readOnly ? "access" : "adoptions",
    ]);
    if (
      !isProjectAssetApplicationService(d.assets) ||
      (readOnly
        ? d.access !== "read-only"
        : types.isProxy(d.adoptions) ||
          !(d.adoptions instanceof ProjectAssetMediaAdoptionApplicationService))
    )
      throw new ApplicationError(
        "validation",
        "project_asset_v2_dependencies_invalid",
      );
    this.#assets = d.assets;
    this.#adoptions = readOnly
      ? undefined
      : (d.adoptions as ProjectAssetMediaAdoptionApplicationService);
    this.#asset = ProjectAssetApplicationService.prototype.getAsset.bind(
      d.assets,
    );
    const p = ProjectAssetApplicationService.prototype;
    this.#revision = p.getRevision.bind(d.assets);
    this.#list = p.listAssets.bind(d.assets);
    this.#revisions = p.listRevisions.bind(d.assets);
    this.#mutations = Object.freeze({
      saveCandidate: p.saveCandidate.bind(d.assets),
      selectRevision: p.selectRevision.bind(d.assets),
      setLocked: p.setLocked.bind(d.assets),
      saveReferenceCandidate: p.saveReferenceCandidate.bind(d.assets),
      selectReference: p.selectReference.bind(d.assets),
    });
    this.#reference =
      ProjectAssetApplicationService.prototype.getReferenceRevision.bind(
        d.assets,
      );
    this.#references =
      ProjectAssetApplicationService.prototype.listReferences.bind(d.assets);
    this.#adopt =
      this.#adoptions === undefined
        ? undefined
        : ProjectAssetMediaAdoptionApplicationService.prototype.adoptReference.bind(
            this.#adoptions,
          );
    Object.freeze(this);
  }
  supportsMutations(): boolean {
    return this.#adoptions !== undefined;
  }
  async bindPluginProjectReads(scope: PluginProjectReadScope) {
    const assets =
      await ProjectAssetApplicationService.prototype.bindPluginProjectReads.call(
        this.#assets,
        scope,
      );
    return assets === this.#assets
      ? this
      : new ProjectAssetV2ApplicationService({
          assets,
          ...(this.#adoptions === undefined
            ? { access: "read-only" as const }
            : { adoptions: this.#adoptions }),
        });
  }
  async query(actor: ActorContext, input: ProjectAssetV2ReadRequest) {
    const request = parseProjectAssetV2Request(input);
    switch (request.action) {
      case actions.getAsset:
        return parseProjectAssetV2Response(request, {
          view: projectAssetPublicViewV2(
            await this.#asset(actor, request.input),
          ),
        });
      case actions.getRevision:
        return parseProjectAssetV2Response(request, {
          contentRevision: projectAssetPublicRevision(
            await this.#revision(actor, request.input),
          ),
        });
      case actions.listAssets: {
        const page = await this.#list(actor, { ...request.input, kind: null });
        const output = projectAssetPublicPage({
          items: page.assets.map(projectAssetPublicHead),
          continuation: page.nextAssetId,
          cursorOf: (a) => a.assetId,
          response: (assets, nextAssetId) => ({ assets, nextAssetId }),
        });
        return parseProjectAssetV2Response(request, output);
      }
      case actions.listRevisions: {
        const page = await this.#revisions(actor, request.input);
        const output = projectAssetPublicPage({
          items: page.revisions.map(projectAssetPublicRevision),
          continuation: page.nextContentRevision,
          cursorOf: (r) => r.contentRevision,
          response: (revisions, nextContentRevision) => ({
            revisions,
            nextContentRevision,
          }),
        });
        return parseProjectAssetV2Response(request, output);
      }
      case actions.getReferenceRevision:
        return parseProjectAssetV2Response(request, {
          referenceRevision: projectAssetPublicReferenceV2(
            await this.#reference(actor, request.input),
          ),
        });
      case actions.listReferences: {
        const page = await this.#references(actor, request.input);
        const output = projectAssetPublicPage({
          items: page.references.map(projectAssetPublicReferenceV2),
          continuation: page.nextReferenceRevision,
          cursorOf: (r) => r.referenceRevision,
          response: (references, nextReferenceRevision) => ({
            references,
            nextReferenceRevision,
          }),
        });
        return parseProjectAssetV2Response(request, output);
      }
      default:
        throw new ApplicationError("validation", "project_asset_v2_read_only");
    }
  }
  async mutate(
    actor: ActorContext,
    input: ProjectAssetV2MutationRequest,
    options: Readonly<{ authority: ProjectAssetCommitAuthority }>,
  ) {
    if (this.#adoptions === undefined)
      throw new ApplicationError("authorization", "project_asset_v2_read_only");
    projectAssetOwnFields(options, ["authority"]);
    const authority = captureProjectAssetCommitAuthority(options);
    if (!authority)
      throw new ApplicationError(
        "authorization",
        "project_asset_v2_authority_required",
      );
    const request = parseProjectAssetV2Request(input),
      commit = Object.freeze({ authority });
    if (
      authority.uiTransaction &&
      (authority.uiTransaction.version !==
        "crewon.project-asset-plugin-commit.v2" ||
        authority.uiTransaction.actionId !== request.action)
    )
      throw new ApplicationError(
        "authorization",
        "project_asset_v2_transaction_mismatch",
      );
    let result;
    switch (request.action) {
      case actions.saveCandidate:
        result = await this.#mutations.saveCandidate(
          actor,
          {
            ...request.input.request,
            projectId: request.input.projectId,
            assetId: request.input.assetId,
            idempotencyKey: request.input.idempotencyKey,
          },
          commit,
        );
        break;
      case actions.selectRevision:
        result = await this.#mutations.selectRevision(
          actor,
          {
            ...request.input.request,
            projectId: request.input.projectId,
            assetId: request.input.assetId,
            idempotencyKey: request.input.idempotencyKey,
          },
          commit,
        );
        break;
      case actions.setLocked:
        result = await this.#mutations.setLocked(
          actor,
          {
            ...request.input.request,
            projectId: request.input.projectId,
            assetId: request.input.assetId,
            idempotencyKey: request.input.idempotencyKey,
          },
          commit,
        );
        break;
      case actions.saveReferenceCandidate:
        result = await this.#mutations.saveReferenceCandidate(
          actor,
          {
            ...request.input.request,
            projectId: request.input.projectId,
            assetId: request.input.assetId,
            idempotencyKey: request.input.idempotencyKey,
          },
          commit,
        );
        break;
      case actions.selectReference:
        result = await this.#mutations.selectReference(
          actor,
          {
            ...request.input.request,
            projectId: request.input.projectId,
            assetId: request.input.assetId,
            idempotencyKey: request.input.idempotencyKey,
          },
          commit,
        );
        break;
      default:
        throw new ApplicationError(
          "validation",
          "project_asset_v2_mutation_required",
        );
    }
    return parseProjectAssetV2Response(
      request,
      projectAssetPublicMutationV2(result),
    );
  }
  async adoptReference(
    actor: ActorContext,
    command: AdoptProjectAssetMediaReferenceRequest,
    options: Parameters<
      ProjectAssetMediaAdoptionApplicationService["adoptReference"]
    >[2],
  ) {
    if (this.#adopt === undefined)
      throw new ApplicationError("authorization", "project_asset_v2_read_only");
    const request = parseProjectAssetV2Request({
      action: actions.adoptMediaReference,
      input: command,
    });
    if (request.action !== actions.adoptMediaReference)
      throw new ApplicationError(
        "validation",
        "project_asset_v2_command_invalid",
      );
    const result = await this.#adopt(actor, request.input, options);
    return parseProjectAssetV2Response(request, {
      disposition: result.disposition,
      asset: projectAssetPublicHead(result.asset),
      referenceRevision: projectAssetPublicReferenceV2(
        result.referenceRevision,
      ),
    });
  }
}
