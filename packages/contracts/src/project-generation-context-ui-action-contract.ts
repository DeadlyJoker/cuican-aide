import {
  parseProjectGenerationUiReference,
  type ProjectGenerationUiReference,
} from "./project-generation-ui-action-contract.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  pluginUiFields,
} from "./plugin-ui-json.ts";

export const CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE =
  "crewon.project-generation-contexts";
export const CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION = "1";
export const PROJECT_GENERATION_CONTEXT_UI_ACTIONS = Object.freeze([
  "crewon.project-generation-contexts.v1.getReadiness",
] as const);
export type ProjectGenerationContextUiAction =
  (typeof PROJECT_GENERATION_CONTEXT_UI_ACTIONS)[number];
export type ProjectGenerationContextUiInput = Readonly<{
  reference: ProjectGenerationUiReference;
}>;
export type ProjectGenerationContextUiReadiness =
  | Readonly<{ outcome: "ready" }>
  | Readonly<{
      outcome: "unavailable";
      reasonCode:
        | "project_generation_input_unavailable"
        | "project_generation_configuration_unavailable"
        | "project_generation_runtime_unavailable";
    }>;
export type ProjectGenerationContextUiResponse = Readonly<{
  reference: ProjectGenerationUiReference;
  readiness: ProjectGenerationContextUiReadiness;
}>;
export type ProjectGenerationContextUiActionRequest = Readonly<{
  action: ProjectGenerationContextUiAction;
  input: ProjectGenerationContextUiInput;
}>;

/** A read hint, not a price, payer or execution capability. */
export function parseProjectGenerationContextUiActionRequest(
  input: unknown,
): ProjectGenerationContextUiActionRequest {
  const fields = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
    ["action", "input"],
  );
  if (fields.action !== PROJECT_GENERATION_CONTEXT_UI_ACTIONS[0])
    pluginUiFailure("project_generation_context_ui_action_invalid");
  const value = pluginUiFields(fields.input, ["reference"]);
  return Object.freeze({
    action: PROJECT_GENERATION_CONTEXT_UI_ACTIONS[0],
    input: Object.freeze({
      reference: parseProjectGenerationUiReference(value.reference),
    }),
  });
}

export function parseProjectGenerationContextUiActionResponse(
  request: ProjectGenerationContextUiActionRequest,
  input: unknown,
): ProjectGenerationContextUiResponse {
  const captured = parseProjectGenerationContextUiActionRequest(request);
  const fields = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
    ["reference", "readiness"],
  );
  const reference = parseProjectGenerationUiReference(fields.reference);
  if (JSON.stringify(reference) !== JSON.stringify(captured.input.reference))
    pluginUiFailure("project_generation_context_source_mismatch");
  let readiness: ProjectGenerationContextUiReadiness;
  const raw = fields.readiness;
  if (raw === null || typeof raw !== "object")
    pluginUiFailure("project_generation_context_readiness_invalid");
  const shape = pluginUiFields(
    raw,
    Object.hasOwn(raw, "reasonCode") ? ["outcome", "reasonCode"] : ["outcome"],
  );
  if (shape.outcome === "ready" && !Object.hasOwn(shape, "reasonCode"))
    readiness = Object.freeze({ outcome: "ready" });
  else if (
    shape.outcome === "unavailable" &&
    [
      "project_generation_input_unavailable",
      "project_generation_configuration_unavailable",
      "project_generation_runtime_unavailable",
    ].includes(shape.reasonCode as string)
  )
    readiness = Object.freeze({
      outcome: "unavailable",
      reasonCode: shape.reasonCode as Extract<
        ProjectGenerationContextUiReadiness,
        { outcome: "unavailable" }
      >["reasonCode"],
    });
  else pluginUiFailure("project_generation_context_readiness_invalid");
  return Object.freeze({ reference, readiness });
}
