import {
  MAX_PROJECT_GENERATION_SELECTION_BYTES,
  parseSelectConceptImageResponse,
  type SelectConceptImageResponse,
} from "./project-generation-selection-contract.ts";
import {
  PROJECT_GENERATION_SELECTION_UI_ACTIONS,
  parseProjectGenerationSelectionUiActionRequest,
  type ProjectGenerationSelectionUiInput,
} from "./project-generation-selection-ui-action-contract.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  pluginUiFields,
} from "./plugin-ui-json.ts";

export const PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION =
  "crewon.project-generation-selection-host-context.v1";
export type ProjectGenerationSelectionHostIntent = Readonly<{
  request: ProjectGenerationSelectionUiInput;
  phase: "pending" | "uncertain" | "accepted" | "refused";
  retryable: boolean;
  receipt: SelectConceptImageResponse | null;
}>;
/** Recovery hints only. The immutable receipt is never the current selection or a grant. */
export type ProjectGenerationSelectionHostContext = Readonly<{
  version: typeof PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION;
  intent: ProjectGenerationSelectionHostIntent | null;
}>;

export function parseProjectGenerationSelectionHostContext(
  input: unknown,
): ProjectGenerationSelectionHostContext {
  const fields = pluginUiFields(
    parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_GENERATION_SELECTION_BYTES,
    }),
    ["version", "intent"],
  );
  if (fields.version !== PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION)
    invalid();
  if (fields.intent === null)
    return Object.freeze({
      version: PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION,
      intent: null,
    });
  const value = pluginUiFields(fields.intent, [
    "request",
    "phase",
    "retryable",
    "receipt",
  ]);
  if (
    !["pending", "uncertain", "accepted", "refused"].includes(
      value.phase as string,
    ) ||
    typeof value.retryable !== "boolean" ||
    (value.phase === "accepted") !== (value.receipt !== null) ||
    (value.phase !== "uncertain" && value.retryable)
  )
    invalid();
  const request = parseProjectGenerationSelectionUiActionRequest({
    action: PROJECT_GENERATION_SELECTION_UI_ACTIONS[1],
    input: value.request,
  });
  if (request.action !== PROJECT_GENERATION_SELECTION_UI_ACTIONS[1]) invalid();
  const { idempotencyKey: _key, ...body } = request.input;
  return Object.freeze({
    version: PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION,
    intent: Object.freeze({
      request: request.input,
      phase: value.phase as ProjectGenerationSelectionHostIntent["phase"],
      retryable: value.retryable,
      receipt:
        value.receipt === null
          ? null
          : parseSelectConceptImageResponse(value.receipt, body),
    }),
  });
}
function invalid(): never {
  return pluginUiFailure("project_generation_selection_host_context_invalid");
}
