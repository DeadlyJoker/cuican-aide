import { parseProjectStageModelId } from "./project-stage-model-contract.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import {
  assetContractCopy as copy,
  assetContractRecord as record,
  assetContractId as id,
  assetContractOpaque as opaque,
  assetContractRevision as revision,
  assetContractDigest as digest,
  assetContractText as text,
  assetContractKind as kind,
} from "./project-asset-contract-support.ts";
import { parseCreativeProjectIdempotencyKey } from "./creative-project-control-contract.ts";
import {
  MAX_PROJECT_ASSET_STAGES_BYTES,
  MAX_PROJECT_ASSET_STAGE_CONTENT_BYTES,
  PROJECT_ASSET_STAGES_METHOD_ACTIONS,
  isProjectAssetStagesAction,
  type ProjectAssetStageRequest,
  type ProjectAssetStageResponse,
  type ProjectAssetStagesActionRequest,
  type ProjectAssetStagesCodec,
} from "./project-asset-stages-service.ts";
export class ProjectAssetStagesContractError extends ContractValidationError {
  constructor() {
    super("project_asset_stages_contract_invalid");
    this.name = "ProjectAssetStagesContractError";
  }
}
function checked<T>(work: () => T): T {
  try {
    return work();
  } catch {
    throw new ProjectAssetStagesContractError();
  }
}
export function parseProjectAssetStageRequest(
  input: unknown,
): ProjectAssetStageRequest {
  return checked(() => {
    const copied = copy(input, MAX_PROJECT_ASSET_STAGES_BYTES);
    const value = record(copied, [
        "projectId",
        "threadId",
        "expectedThreadRevision",
        "expectedBindingRevision",
        "stage",
        "content",
        "idempotencyKey",
        ...(Object.hasOwn(copied as object, "modelId") ? ["modelId"] : []),
      ]),
      stage = record(value.stage, [
        "kind",
        "assetKind",
        "briefRevision",
        "script",
      ]),
      script =
        stage.script === null
          ? null
          : record(stage.script, [
              "artifactId",
              "episodeId",
              "contentRevision",
            ]);
    if (stage.kind !== "assets") throw new ProjectAssetStagesContractError();
    return Object.freeze({
      projectId: id(value.projectId),
      threadId: id(value.threadId),
      expectedThreadRevision: revision(value.expectedThreadRevision),
      expectedBindingRevision: revision(value.expectedBindingRevision),
      stage: Object.freeze({
        kind: "assets",
        assetKind: kind(stage.assetKind),
        briefRevision: revision(stage.briefRevision),
        script:
          script === null
            ? null
            : Object.freeze({
                artifactId: id(script.artifactId),
                episodeId: id(script.episodeId),
                contentRevision: revision(script.contentRevision),
              }),
      }),
      ...(Object.hasOwn(value, "modelId")
        ? { modelId: parseProjectStageModelId(value.modelId) }
        : {}),
      content: text(value.content, MAX_PROJECT_ASSET_STAGE_CONTENT_BYTES),
      idempotencyKey: id(
        parseCreativeProjectIdempotencyKey(value.idempotencyKey),
      ),
    });
  });
}
export function parseProjectAssetStageResponse(
  requestInput: ProjectAssetStageRequest,
  input: unknown,
): ProjectAssetStageResponse {
  return checked(() => {
    const request = parseProjectAssetStageRequest(requestInput),
      value = record(copy(input, MAX_PROJECT_ASSET_STAGES_BYTES), [
        "disposition",
        "threadId",
        "threadRevision",
        "runId",
        "runRevision",
        "bindingRevision",
        "stageAdmissionDigest",
      ]);
    if (
      (value.disposition !== "committed" && value.disposition !== "replayed") ||
      value.threadId !== request.threadId ||
      value.threadRevision !== request.expectedThreadRevision + 1 ||
      value.bindingRevision !== request.expectedBindingRevision
    )
      throw new ProjectAssetStagesContractError();
    return Object.freeze({
      disposition: value.disposition,
      threadId: id(value.threadId),
      threadRevision: revision(value.threadRevision),
      runId: opaque(value.runId),
      runRevision: revision(value.runRevision),
      bindingRevision: revision(value.bindingRevision),
      stageAdmissionDigest: digest(value.stageAdmissionDigest),
    });
  });
}
export function parseProjectAssetStagesActionRequest(
  input: unknown,
): ProjectAssetStagesActionRequest {
  return checked(() => {
    const value = record(copy(input, MAX_PROJECT_ASSET_STAGES_BYTES), [
      "action",
      "input",
    ]);
    if (!isProjectAssetStagesAction(value.action))
      throw new ProjectAssetStagesContractError();
    return Object.freeze({
      action: value.action,
      input: parseProjectAssetStageRequest(value.input),
    });
  });
}
export function parseProjectAssetStagesActionResponse(
  requestInput: ProjectAssetStagesActionRequest,
  input: unknown,
): ProjectAssetStageResponse {
  const request = parseProjectAssetStagesActionRequest(requestInput);
  return parseProjectAssetStageResponse(request.input, input);
}
export const projectAssetStagesCodec: ProjectAssetStagesCodec = Object.freeze({
  parseRequest: parseProjectAssetStagesActionRequest,
  parseResponse: parseProjectAssetStagesActionResponse,
});
export function projectAssetStagePath(threadId: string): string {
  return `/api/v1/threads/${encodeURIComponent(id(threadId))}/project-asset-stage`;
}

/** Separate HTTP read. The portable UI service retains its single explicit start action. */
export function parseProjectAssetStageAvailabilityResponse(
  input: unknown,
): import("./project-asset-stages-service.ts").ProjectAssetStageAvailabilityResponse {
  return checked(() => {
    const value = record(copy(input, 1024), ["available"]);
    if (typeof value.available !== "boolean")
      throw new ProjectAssetStagesContractError();
    return Object.freeze({ available: value.available });
  });
}
