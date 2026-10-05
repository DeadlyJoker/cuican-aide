import { pluginUiFields, pluginUiFailure } from "./plugin-ui-json.ts";
import {
  parseProjectGenerationQueryUiActionRequest,
  parseProjectGenerationQueryUiActionResponse,
  PROJECT_GENERATION_QUERY_UI_ACTIONS,
} from "./project-generation-query-ui-action-contract.ts";
import {
  PROJECT_HISTORICAL_QUERY_UI_ACTIONS,
  type ProjectHistoricalQueryUiActionRequest,
  type ProjectHistoricalQueryUiReceipt,
} from "./plugin-project-historical-queries-service.ts";
/** Pure detached data validation only; this conversion never alters an invocation/authority object. */
export function parseProjectHistoricalQueryUiActionRequest(
  input: unknown,
): ProjectHistoricalQueryUiActionRequest {
  const v = pluginUiFields(input, ["action", "input"]);
  if (v.action !== PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0])
    pluginUiFailure("project_historical_query_ui_action_invalid");
  const checked = parseProjectGenerationQueryUiActionRequest({
    action: PROJECT_GENERATION_QUERY_UI_ACTIONS[0],
    input: v.input,
  });
  return Object.freeze({
    action: PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0],
    input: checked.input,
  });
}
export function parseProjectHistoricalQueryUiActionResponse(
  request: ProjectHistoricalQueryUiActionRequest,
  output: unknown,
): ProjectHistoricalQueryUiReceipt {
  const checked = parseProjectHistoricalQueryUiActionRequest(request);
  return parseProjectGenerationQueryUiActionResponse(
    { action: PROJECT_GENERATION_QUERY_UI_ACTIONS[0], input: checked.input },
    output,
  );
}
