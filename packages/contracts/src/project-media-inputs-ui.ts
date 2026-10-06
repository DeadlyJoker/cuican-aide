import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parseListMediaInputsRequest,
  parseListMediaInputsResponse,
  type ListMediaInputsRequest,
  parseMediaInputOptionsRequest,
  parseMediaInputOptionsResponse,
  type MediaInputOptionsRequest,
} from "./project-media-input-catalog.ts";
import { pluginControlRecord } from "./plugin-control-contract-support.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import {
  MAX_PROJECT_MEDIA_INPUT_REQUEST_BYTES,
  parseLoadMediaInputRequest,
  parseLoadMediaInputResponse,
  parseSaveMediaInputRequest,
  parseSaveMediaInputResponse,
  type LoadMediaInputRequest,
  type SaveMediaInputRequest,
} from "./project-media-inputs.ts";

export const CREWON_PROJECT_MEDIA_INPUTS_SERVICE =
  "crewon.project-media-inputs";
export const CREWON_PROJECT_MEDIA_INPUTS_API_VERSION = "1";
export const PROJECT_MEDIA_INPUT_UI_ACTIONS = Object.freeze({
  getOptions: "crewon.project-media-inputs.v1.getOptions",
  listInputs: "crewon.project-media-inputs.v1.listInputs",
  loadInput: "crewon.project-media-inputs.v1.loadInput",
  saveInput: "crewon.project-media-inputs.v1.saveInput",
} as const);
export type ProjectMediaInputUiRequest =
  | Readonly<{
      action: typeof PROJECT_MEDIA_INPUT_UI_ACTIONS.getOptions;
      input: MediaInputOptionsRequest;
    }>
  | Readonly<{
      action: typeof PROJECT_MEDIA_INPUT_UI_ACTIONS.listInputs;
      input: ListMediaInputsRequest;
    }>
  | Readonly<{
      action: typeof PROJECT_MEDIA_INPUT_UI_ACTIONS.loadInput;
      input: LoadMediaInputRequest;
    }>
  | Readonly<{
      action: typeof PROJECT_MEDIA_INPUT_UI_ACTIONS.saveInput;
      input: SaveMediaInputRequest;
    }>;

export function isProjectMediaInputUiNamespaceAction(action: unknown): boolean {
  return (
    typeof action === "string" &&
    (action === CREWON_PROJECT_MEDIA_INPUTS_SERVICE ||
      action.startsWith(`${CREWON_PROJECT_MEDIA_INPUTS_SERVICE}.`))
  );
}

/** Both entries use the original logical HTTP contract, never a supplier graph or credential. */
export function parseProjectMediaInputUiRequest(
  input: unknown,
): ProjectMediaInputUiRequest {
  const r = pluginControlRecord(
    parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_MEDIA_INPUT_REQUEST_BYTES + 256,
    }),
    ["action", "input"],
  );
  switch (r.action) {
    case PROJECT_MEDIA_INPUT_UI_ACTIONS.getOptions:
      return Object.freeze({
        action: r.action,
        input: parseMediaInputOptionsRequest(r.input),
      });
    case PROJECT_MEDIA_INPUT_UI_ACTIONS.listInputs:
      return Object.freeze({
        action: r.action,
        input: parseListMediaInputsRequest(r.input),
      });
    case PROJECT_MEDIA_INPUT_UI_ACTIONS.loadInput:
      return Object.freeze({
        action: r.action,
        input: parseLoadMediaInputRequest(r.input),
      });
    case PROJECT_MEDIA_INPUT_UI_ACTIONS.saveInput:
      return Object.freeze({
        action: r.action,
        input: parseSaveMediaInputRequest(r.input),
      });
    default:
      throw new ContractValidationError(
        "project_media_input_ui_action_invalid",
      );
  }
}

export function parseProjectMediaInputUiResponse(
  request: ProjectMediaInputUiRequest,
  input: unknown,
) {
  if (request.action === PROJECT_MEDIA_INPUT_UI_ACTIONS.getOptions)
    return parseMediaInputOptionsResponse(input);
  if (request.action === PROJECT_MEDIA_INPUT_UI_ACTIONS.listInputs)
    return parseListMediaInputsResponse(request.input, input);
  return request.action === PROJECT_MEDIA_INPUT_UI_ACTIONS.loadInput
    ? parseLoadMediaInputResponse(request.input, input)
    : parseSaveMediaInputResponse(request.input, input);
}

export type {
  LoadMediaInputRequest,
  SaveMediaInputRequest,
  PublicMediaInput,
} from "./project-media-inputs.ts";
