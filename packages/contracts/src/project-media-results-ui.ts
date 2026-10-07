import { ContractValidationError } from "./contract-validation-error.ts";
import { pluginControlRecord } from "./plugin-control-contract-support.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import {
  parseListProjectMediaResultsRequest,
  parseListProjectMediaResultsResponse,
  parseProjectMediaResultLocator,
  parseGetProjectMediaResultResponse,
  parsePublishProjectMediaResultResponse,
  parseProjectMediaRunLocator,
  parseProjectMediaRunOutputs,
  type ProjectMediaRunLocator,
  type ListProjectMediaResultsRequest,
  type ProjectMediaResultLocator,
} from "./project-media-results.ts";

/** Read-only UI protocol. Publishing and adopting a candidate are separate capabilities. */
export const CREWON_PROJECT_MEDIA_RESULTS_SERVICE =
  "crewon.project-media-results";
export const CREWON_PROJECT_MEDIA_RESULTS_API_VERSION = "1";
/** Separate opt-in capability; the original read-only service never grants saves. */
export const CREWON_PROJECT_MEDIA_RESULT_ACTIONS_SERVICE =
  "crewon.project-media-result-actions";
export const PROJECT_MEDIA_RESULT_WRITE_ACTIONS = Object.freeze({
  listOutputs: "crewon.project-media-result-actions.v1.listOutputs",
  saveCandidate: "crewon.project-media-result-actions.v1.saveCandidate",
} as const);
export const PROJECT_MEDIA_RESULT_UI_ACTIONS = Object.freeze({
  listCandidates: "crewon.project-media-results.v1.listCandidates",
  preview: "crewon.project-media-results.v1.preview",
  releasePreview: "crewon.project-media-results.v1.releasePreview",
} as const);
export type ProjectMediaResultUiRequest =
  | Readonly<{
      action: typeof PROJECT_MEDIA_RESULT_WRITE_ACTIONS.listOutputs;
      input: ProjectMediaRunLocator;
    }>
  | Readonly<{
      action: typeof PROJECT_MEDIA_RESULT_WRITE_ACTIONS.saveCandidate;
      input: ProjectMediaResultLocator;
    }>
  | Readonly<{
      action: typeof PROJECT_MEDIA_RESULT_UI_ACTIONS.listCandidates;
      input: ListProjectMediaResultsRequest;
    }>
  | Readonly<{
      action: typeof PROJECT_MEDIA_RESULT_UI_ACTIONS.preview;
      input: ProjectMediaResultLocator;
    }>;
export function isProjectMediaResultUiNamespaceAction(
  action: unknown,
): boolean {
  return (
    typeof action === "string" &&
    [
      CREWON_PROJECT_MEDIA_RESULTS_SERVICE,
      CREWON_PROJECT_MEDIA_RESULT_ACTIONS_SERVICE,
    ].some((service) => action === service || action.startsWith(`${service}.`))
  );
}
/** releasePreview is renderer-local and never reaches an authenticated server action. */
export function parseProjectMediaResultUiRequest(
  input: unknown,
): ProjectMediaResultUiRequest {
  const r = pluginControlRecord(
    parsePluginUiJsonValue(input, { maxBytes: 4096 }),
    ["action", "input"],
  );
  if (r.action === PROJECT_MEDIA_RESULT_UI_ACTIONS.listCandidates)
    return Object.freeze({
      action: r.action,
      input: parseListProjectMediaResultsRequest(r.input),
    });
  if (r.action === PROJECT_MEDIA_RESULT_UI_ACTIONS.preview)
    return Object.freeze({
      action: r.action,
      input: parseProjectMediaResultLocator(r.input),
    });
  if (r.action === PROJECT_MEDIA_RESULT_WRITE_ACTIONS.listOutputs)
    return Object.freeze({
      action: r.action,
      input: parseProjectMediaRunLocator(r.input),
    });
  if (r.action === PROJECT_MEDIA_RESULT_WRITE_ACTIONS.saveCandidate)
    return Object.freeze({
      action: r.action,
      input: parseProjectMediaResultLocator(r.input),
    });
  throw new ContractValidationError("project_media_result_ui_action_invalid");
}
/** Server response contains metadata only; an authenticated renderer owns the transient preview URL. */
export function parseProjectMediaResultUiResponse(
  request: ProjectMediaResultUiRequest,
  input: unknown,
) {
  const q = parseProjectMediaResultUiRequest(request);
  if (q.action === PROJECT_MEDIA_RESULT_WRITE_ACTIONS.listOutputs)
    return parseProjectMediaRunOutputs(q.input, input);
  if (q.action === PROJECT_MEDIA_RESULT_WRITE_ACTIONS.saveCandidate)
    return parsePublishProjectMediaResultResponse(q.input, input);
  return q.action === PROJECT_MEDIA_RESULT_UI_ACTIONS.listCandidates
    ? parseListProjectMediaResultsResponse(q.input, input)
    : parseGetProjectMediaResultResponse(q.input, input);
}
