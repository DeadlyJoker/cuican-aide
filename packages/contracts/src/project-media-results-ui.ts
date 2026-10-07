import { ContractValidationError } from "./contract-validation-error.ts";
import { pluginControlRecord } from "./plugin-control-contract-support.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import {
  parseListProjectMediaResultsRequest,
  parseListProjectMediaResultsResponse,
  parseProjectMediaResultLocator,
  parseGetProjectMediaResultResponse,
  type ListProjectMediaResultsRequest,
  type ProjectMediaResultLocator,
} from "./project-media-results.ts";

/** Read-only UI protocol. Publishing and adopting a candidate are separate capabilities. */
export const CREWON_PROJECT_MEDIA_RESULTS_SERVICE =
  "crewon.project-media-results";
export const CREWON_PROJECT_MEDIA_RESULTS_API_VERSION = "1";
export const PROJECT_MEDIA_RESULT_UI_ACTIONS = Object.freeze({
  listCandidates: "crewon.project-media-results.v1.listCandidates",
  preview: "crewon.project-media-results.v1.preview",
  releasePreview: "crewon.project-media-results.v1.releasePreview",
} as const);
export type ProjectMediaResultUiRequest =
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
    (action === CREWON_PROJECT_MEDIA_RESULTS_SERVICE ||
      action.startsWith(`${CREWON_PROJECT_MEDIA_RESULTS_SERVICE}.`))
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
  throw new ContractValidationError("project_media_result_ui_action_invalid");
}
/** Server response contains metadata only; an authenticated renderer owns the transient preview URL. */
export function parseProjectMediaResultUiResponse(
  request: ProjectMediaResultUiRequest,
  input: unknown,
) {
  const q = parseProjectMediaResultUiRequest(request);
  return q.action === PROJECT_MEDIA_RESULT_UI_ACTIONS.listCandidates
    ? parseListProjectMediaResultsResponse(q.input, input)
    : parseGetProjectMediaResultResponse(q.input, input);
}
