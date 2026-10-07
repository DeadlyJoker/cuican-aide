import { types } from "node:util";
import {
  PROJECT_ASSET_V2_ACTIONS as actions,
  parseProjectAssetV2Request,
  parseProjectAssetV2Response,
  type ProjectAssetV2ReadRequest,
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
} from "./project-asset-public-v2.ts";
import {
  projectAssetPublicHead,
  projectAssetPublicPage,
} from "./plugin-project-asset-action-projection.ts";
import { projectAssetOwnFields } from "./project-asset-application-support.ts";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";

/** Shared public model for UI/Agent adapters. No route, tool or installation is registered implicitly. */
export class ProjectAssetV2ApplicationService {
  readonly #asset: ProjectAssetApplicationService["getAsset"];
  readonly #reference: ProjectAssetApplicationService["getReferenceRevision"];
  readonly #references: ProjectAssetApplicationService["listReferences"];
  readonly #adopt: ProjectAssetMediaAdoptionApplicationService["adoptReference"];
  constructor(
    input: Readonly<{
      assets: ProjectAssetApplicationService;
      adoptions: ProjectAssetMediaAdoptionApplicationService;
    }>,
  ) {
    const d = projectAssetOwnFields(input, ["assets", "adoptions"]);
    if (
      !isProjectAssetApplicationService(d.assets) ||
      types.isProxy(d.adoptions) ||
      !(d.adoptions instanceof ProjectAssetMediaAdoptionApplicationService)
    )
      throw new ApplicationError(
        "validation",
        "project_asset_v2_dependencies_invalid",
      );
    this.#asset = ProjectAssetApplicationService.prototype.getAsset.bind(
      d.assets,
    );
    this.#reference =
      ProjectAssetApplicationService.prototype.getReferenceRevision.bind(
        d.assets,
      );
    this.#references =
      ProjectAssetApplicationService.prototype.listReferences.bind(d.assets);
    this.#adopt =
      ProjectAssetMediaAdoptionApplicationService.prototype.adoptReference.bind(
        d.adoptions,
      );
    Object.freeze(this);
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
  async adoptReference(
    actor: ActorContext,
    command: AdoptProjectAssetMediaReferenceRequest,
    options: Parameters<
      ProjectAssetMediaAdoptionApplicationService["adoptReference"]
    >[2],
  ) {
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
