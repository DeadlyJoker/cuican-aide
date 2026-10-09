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
} from "./project-asset-contract-support.ts";
import { parseCreativeProjectIdempotencyKey } from "./creative-project-control-contract.ts";
import {
  MAX_PROJECT_MEDIA_INPUT_STAGES_BYTES,
  MAX_PROJECT_MEDIA_INPUT_STAGE_CONTENT_BYTES,
  PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS,
  isProjectMediaInputStagesAction,
  type ProjectMediaInputStageRequest,
  type ProjectMediaInputStageResponse,
  type ProjectMediaInputStagesActionRequest,
  type ProjectMediaInputStagesCodec,
} from "./project-media-input-stages-service.ts";
export class ProjectMediaInputStagesContractError extends ContractValidationError {
  constructor() {
    super("project_media_input_stages_contract_invalid");
    this.name = "ProjectMediaInputStagesContractError";
  }
}
function checked<T>(work: () => T): T {
  try {
    return work();
  } catch {
    throw new ProjectMediaInputStagesContractError();
  }
}
export function parseProjectMediaInputStageRequest(
  input: unknown,
): ProjectMediaInputStageRequest {
  return checked(() => {
    const copied = copy(input, MAX_PROJECT_MEDIA_INPUT_STAGES_BYTES);
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
        "workflowId",
        "configurationRevision",
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
    if (
      stage.kind !== "media-input" ||
      (stage.workflowId !== "krea2-reference-four-view" &&
        stage.workflowId !== "flux2-three-reference-storyboard") ||
      (stage.workflowId === "flux2-three-reference-storyboard" &&
        script === null)
    )
      throw new ProjectMediaInputStagesContractError();
    return Object.freeze({
      projectId: id(value.projectId),
      threadId: id(value.threadId),
      expectedThreadRevision: revision(value.expectedThreadRevision),
      expectedBindingRevision: revision(value.expectedBindingRevision),
      stage: Object.freeze({
        kind: "media-input",
        workflowId: stage.workflowId,
        configurationRevision: revision(stage.configurationRevision),
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
      content: text(value.content, MAX_PROJECT_MEDIA_INPUT_STAGE_CONTENT_BYTES),
      idempotencyKey: id(
        parseCreativeProjectIdempotencyKey(value.idempotencyKey),
      ),
    });
  });
}
export function parseProjectMediaInputStageResponse(
  requestInput: ProjectMediaInputStageRequest,
  input: unknown,
): ProjectMediaInputStageResponse {
  return checked(() => {
    const request = parseProjectMediaInputStageRequest(requestInput),
      value = record(copy(input, MAX_PROJECT_MEDIA_INPUT_STAGES_BYTES), [
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
      throw new ProjectMediaInputStagesContractError();
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
export function parseProjectMediaInputStagesActionRequest(
  input: unknown,
): ProjectMediaInputStagesActionRequest {
  return checked(() => {
    const value = record(copy(input, MAX_PROJECT_MEDIA_INPUT_STAGES_BYTES), [
      "action",
      "input",
    ]);
    if (!isProjectMediaInputStagesAction(value.action))
      throw new ProjectMediaInputStagesContractError();
    return Object.freeze({
      action: value.action,
      input: parseProjectMediaInputStageRequest(value.input),
    });
  });
}
export function parseProjectMediaInputStagesActionResponse(
  requestInput: ProjectMediaInputStagesActionRequest,
  input: unknown,
): ProjectMediaInputStageResponse {
  const request = parseProjectMediaInputStagesActionRequest(requestInput);
  return parseProjectMediaInputStageResponse(request.input, input);
}
export const projectMediaInputStagesCodec: ProjectMediaInputStagesCodec =
  Object.freeze({
    parseRequest: parseProjectMediaInputStagesActionRequest,
    parseResponse: parseProjectMediaInputStagesActionResponse,
  });
export function projectMediaInputStagePath(threadId: string): string {
  return `/api/v1/threads/${encodeURIComponent(id(threadId))}/project-media-input-stage`;
}

/** Separate HTTP read. The portable UI service retains its single explicit start action. */
export function parseProjectMediaInputStageAvailabilityResponse(
  input: unknown,
): import("./project-media-input-stages-service.ts").ProjectMediaInputStageAvailabilityResponse {
  return checked(() => {
    const value = record(copy(input, 1024), ["available"]);
    if (typeof value.available !== "boolean")
      throw new ProjectMediaInputStagesContractError();
    return Object.freeze({ available: value.available });
  });
}
