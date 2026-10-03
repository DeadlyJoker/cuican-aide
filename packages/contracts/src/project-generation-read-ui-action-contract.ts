import {
  parseConceptGenerationLocator,
  parseGetConceptGenerationResponse,
  type ConceptGenerationLocator,
  type GetConceptGenerationResponse,
} from "./project-generation-read-contract.ts";
import { pluginUiFailure, pluginUiFields } from "./plugin-ui-json.ts";

/** Declaring this separate read protocol never grants generation or task execution. */
export const CREWON_PROJECT_GENERATION_READS_SERVICE =
  "crewon.project-generation-reads";
export const CREWON_PROJECT_GENERATION_READS_API_VERSION = "1";
export const PROJECT_GENERATION_READ_UI_ACTIONS = Object.freeze([
  "crewon.project-generation-reads.v1.getConceptGeneration",
] as const);
export type ProjectGenerationReadUiAction =
  (typeof PROJECT_GENERATION_READ_UI_ACTIONS)[number];
export type ProjectGenerationReadUiInput = ConceptGenerationLocator;
export type ProjectGenerationReadUiResponse = GetConceptGenerationResponse;
export type ProjectGenerationReadUiActionRequest = Readonly<{
  action: ProjectGenerationReadUiAction;
  input: ProjectGenerationReadUiInput;
}>;

/** Only the saved source can be located; the original task identity belongs to the server. */
export function parseProjectGenerationReadUiActionRequest(
  input: unknown,
): ProjectGenerationReadUiActionRequest {
  const envelope = pluginUiFields(input, ["action", "input"]);
  if (envelope.action !== PROJECT_GENERATION_READ_UI_ACTIONS[0])
    pluginUiFailure("project_generation_read_ui_action_invalid");
  return Object.freeze({
    action: PROJECT_GENERATION_READ_UI_ACTIONS[0],
    input: parseConceptGenerationLocator(envelope.input),
  });
}

/** Uses the existing full-response bound, provenance projection and source expectation. */
export function parseProjectGenerationReadUiActionResponse(
  request: ProjectGenerationReadUiActionRequest,
  output: unknown,
): ProjectGenerationReadUiResponse {
  const checked = parseProjectGenerationReadUiActionRequest(request);
  return parseGetConceptGenerationResponse(output, checked.input);
}
