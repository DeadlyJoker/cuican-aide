import { ContractValidationError } from "./contract-validation-error.ts";
import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import {
  assetContractId as id,
  assetContractRevision as revision,
} from "./project-asset-contract-support.ts";

/** Logical generation intent only. Installation, provider and material authority remain host-owned. */
export const PROJECT_MEDIA_GENERATIONS_PROTOCOL =
  "crewon.project-media-generations.v1";
export const CREWON_PROJECT_MEDIA_GENERATIONS_SERVICE =
  "crewon.project-media-generations";
export const PROJECT_MEDIA_RECOVERY_UI_ACTION =
  "crewon.project-media-generations.v1.getRecovery";
/** v2 additionally reports a verified terminal pre-admission refusal. Generation requests remain v1. */
export const PROJECT_MEDIA_RECOVERY_V2_UI_ACTION =
  "crewon.project-media-generations.v2.getRecovery";
export const PROJECT_MEDIA_GENERATE_UI_ACTION =
  "crewon.project-media-generations.v1.generate";
export function isProjectMediaGenerationUiNamespaceAction(
  action: unknown,
): boolean {
  return (
    typeof action === "string" &&
    (action === CREWON_PROJECT_MEDIA_GENERATIONS_SERVICE ||
      action.startsWith(`${CREWON_PROJECT_MEDIA_GENERATIONS_SERVICE}.`))
  );
}
export function parseProjectMediaGenerationUiRequest(input: unknown) {
  const r = pluginUiFields(
    parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES + 256,
    }),
    ["action", "input"],
  );
  if (r.action !== PROJECT_MEDIA_GENERATE_UI_ACTION)
    throw new ContractValidationError(
      "project_media_generation_ui_action_invalid",
    );
  return Object.freeze({
    action: PROJECT_MEDIA_GENERATE_UI_ACTION,
    input: parseGenerateProjectMediaRequest(r.input),
  });
}
export const MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES = 2048;
export type GenerateProjectMediaRequest = Readonly<{
  projectId: string;
  mediaInputId: string;
  inputRevision: number;
  expectedInputRevision: number;
  executionId: string;
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
}>;
/** Accepted is not completed: observe the original Run for progress and candidates. */
export type GenerateProjectMediaResponse = Readonly<{
  disposition: "committed" | "replayed";
  projectId: string;
  mediaInputId: string;
  inputRevision: number;
  executionId: string;
  threadId: string;
  threadRevision: number;
  runId: string;
}>;
const fields = [
  "projectId",
  "mediaInputId",
  "inputRevision",
  "expectedInputRevision",
  "executionId",
  "threadId",
  "expectedThreadRevision",
  "idempotencyKey",
];
function checked<T>(input: unknown, parse: (copy: unknown) => T): T {
  try {
    return parse(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_MEDIA_GENERATION_REQUEST_BYTES,
      }),
    );
  } catch {
    throw new ContractValidationError(
      "project_media_generations_contract_invalid",
    );
  }
}
export function parseGenerateProjectMediaRequest(
  input: unknown,
): GenerateProjectMediaRequest {
  return checked(input, (copy) => {
    const r = pluginUiFields(copy, fields);
    return Object.freeze({
      projectId: id(r.projectId),
      mediaInputId: id(r.mediaInputId),
      inputRevision: revision(r.inputRevision),
      expectedInputRevision: revision(r.expectedInputRevision),
      executionId: id(r.executionId),
      threadId: id(r.threadId),
      expectedThreadRevision: revision(r.expectedThreadRevision),
      idempotencyKey: id(r.idempotencyKey),
    });
  });
}
export function parseGenerateProjectMediaHttpRequest(
  input: Readonly<{
    projectId: unknown;
    idempotencyKey: unknown;
    body: unknown;
  }>,
): GenerateProjectMediaRequest {
  return checked(input.body, (copy) => {
    const body = pluginUiFields(
      copy,
      fields.filter((f) => f !== "projectId" && f !== "idempotencyKey"),
    );
    return parseGenerateProjectMediaRequest({
      ...body,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
    });
  });
}
export function parseGenerateProjectMediaResponse(
  requestInput: GenerateProjectMediaRequest,
  input: unknown,
): GenerateProjectMediaResponse {
  const request = parseGenerateProjectMediaRequest(requestInput);
  return checked(input, (copy) => {
    const r = pluginUiFields(copy, [
      "disposition",
      "projectId",
      "mediaInputId",
      "inputRevision",
      "executionId",
      "threadId",
      "threadRevision",
      "runId",
    ]);
    if (
      (r.disposition !== "committed" && r.disposition !== "replayed") ||
      r.projectId !== request.projectId ||
      r.mediaInputId !== request.mediaInputId ||
      r.inputRevision !== request.inputRevision ||
      r.executionId !== request.executionId ||
      r.threadId !== request.threadId ||
      revision(r.threadRevision) <= request.expectedThreadRevision
    )
      throw new Error("response_mismatch");
    return Object.freeze({
      disposition: r.disposition,
      projectId: request.projectId,
      mediaInputId: request.mediaInputId,
      inputRevision: request.inputRevision,
      executionId: request.executionId,
      threadId: request.threadId,
      threadRevision: revision(r.threadRevision),
      runId: id(r.runId),
    });
  });
}
