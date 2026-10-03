import { parseCreativeProjectIdempotencyKey } from "./creative-project-control-contract.ts";
import {
  MAX_PROJECT_GENERATION_SELECTION_BYTES,
  parseConceptSelectionLocator,
  parseGetConceptSelectionResponse,
  parseSelectConceptImageRequest,
  parseSelectConceptImageResponse,
  type ConceptSelectionLocator,
  type GetConceptSelectionResponse,
  type SelectConceptImageRequest,
  type SelectConceptImageResponse,
} from "./project-generation-selection-contract.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  pluginUiFields,
} from "./plugin-ui-json.ts";

export const CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE =
  "crewon.project-generation-selections";
export const CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION = "1";
export const PROJECT_GENERATION_SELECTION_UI_ACTIONS = Object.freeze([
  "crewon.project-generation-selections.v1.getConceptSelection",
  "crewon.project-generation-selections.v1.selectConceptImage",
] as const);
export type ProjectGenerationSelectionUiAction =
  (typeof PROJECT_GENERATION_SELECTION_UI_ACTIONS)[number];
export type ProjectGenerationSelectionUiInput = SelectConceptImageRequest &
  Readonly<{ idempotencyKey: string }>;
export type ProjectGenerationSelectionUiActionRequest =
  | Readonly<{
      action: (typeof PROJECT_GENERATION_SELECTION_UI_ACTIONS)[0];
      input: ConceptSelectionLocator;
    }>
  | Readonly<{
      action: (typeof PROJECT_GENERATION_SELECTION_UI_ACTIONS)[1];
      input: ProjectGenerationSelectionUiInput;
    }>;
export type ProjectGenerationSelectionUiResponse =
  | GetConceptSelectionResponse
  | SelectConceptImageResponse;

export function parseProjectGenerationSelectionUiActionRequest(
  input: unknown,
): ProjectGenerationSelectionUiActionRequest {
  const envelope = pluginUiFields(input, ["action", "input"]);
  const detached = parsePluginUiJsonValue(envelope.input, {
    maxBytes: MAX_PROJECT_GENERATION_SELECTION_BYTES,
  });
  if (envelope.action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[0])
    return Object.freeze({
      action: envelope.action,
      input: parseConceptSelectionLocator(detached),
    });
  if (envelope.action !== PROJECT_GENERATION_SELECTION_UI_ACTIONS[1])
    pluginUiFailure("project_generation_selection_ui_action_invalid");
  const value = pluginUiFields(detached, [
    "reference",
    "operationId",
    "expectedOperationRevision",
    "resultIndex",
    "expectedSelectionRevision",
    "idempotencyKey",
  ]);
  const { idempotencyKey, ...body } = value;
  return Object.freeze({
    action: envelope.action,
    input: Object.freeze({
      ...parseSelectConceptImageRequest(body),
      idempotencyKey: parseCreativeProjectIdempotencyKey(idempotencyKey),
    }),
  });
}

export function parseProjectGenerationSelectionUiActionResponse(
  request: ProjectGenerationSelectionUiActionRequest,
  output: unknown,
): ProjectGenerationSelectionUiResponse {
  const checked = parseProjectGenerationSelectionUiActionRequest(request);
  if (checked.action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[0])
    return parseGetConceptSelectionResponse(output, checked.input);
  const { idempotencyKey: _key, ...body } = checked.input;
  return parseSelectConceptImageResponse(output, body);
}
