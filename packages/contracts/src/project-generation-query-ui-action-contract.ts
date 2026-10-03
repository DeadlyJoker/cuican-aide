import { parseExtensionIdempotencyKey } from "./extension-control-contract.ts";
import { parseExtensionRunId } from "./extension-read-contract.ts";
import {
  parseConceptGenerationLocator,
  type ConceptGenerationLocator,
} from "./project-generation-read-contract.ts";
import type { ProjectGenerationUiReceipt } from "./project-generation-ui-action-contract.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  pluginUiFields,
} from "./plugin-ui-json.ts";

/** Independent opt-in: observing an original operation does not grant generation. */
export const CREWON_PROJECT_GENERATION_QUERIES_SERVICE =
  "crewon.project-generation-queries";
export const CREWON_PROJECT_GENERATION_QUERIES_API_VERSION = "1";
export const PROJECT_GENERATION_QUERY_UI_ACTIONS = Object.freeze([
  "crewon.project-generation-queries.v1.queryConceptGeneration",
] as const);
export type ProjectGenerationQueryUiAction =
  (typeof PROJECT_GENERATION_QUERY_UI_ACTIONS)[number];
export type ProjectGenerationQueryUiInput = Readonly<{
  reference: ConceptGenerationLocator;
  operationId: string;
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
}>;
/** The accepted query Run receipt; the original generation remains separately linked. */
export type ProjectGenerationQueryUiReceipt = ProjectGenerationUiReceipt;
export type ProjectGenerationQueryUiActionRequest = Readonly<{
  action: ProjectGenerationQueryUiAction;
  input: ProjectGenerationQueryUiInput;
}>;

function positiveRevision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    pluginUiFailure("project_generation_query_ui_action_invalid");
  return input;
}

/** Only historical saved input and exact operation are caller selectable. */
export function parseProjectGenerationQueryUiActionRequest(
  input: unknown,
): ProjectGenerationQueryUiActionRequest {
  const envelope = pluginUiFields(input, ["action", "input"]);
  if (envelope.action !== PROJECT_GENERATION_QUERY_UI_ACTIONS[0])
    pluginUiFailure("project_generation_query_ui_action_invalid");
  const value = pluginUiFields(
    parsePluginUiJsonValue(envelope.input, { maxBytes: 24 * 1024 }),
    [
      "reference",
      "operationId",
      "threadId",
      "expectedThreadRevision",
      "idempotencyKey",
    ],
  );
  const expectedThreadRevision = positiveRevision(value.expectedThreadRevision);
  if (
    expectedThreadRevision === Number.MAX_SAFE_INTEGER ||
    typeof value.operationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      value.operationId,
    )
  )
    pluginUiFailure("project_generation_query_ui_action_invalid");
  return Object.freeze({
    action: PROJECT_GENERATION_QUERY_UI_ACTIONS[0],
    input: Object.freeze({
      reference: parseConceptGenerationLocator(value.reference),
      operationId: value.operationId,
      threadId: parseExtensionIdempotencyKey(value.threadId),
      expectedThreadRevision,
      idempotencyKey: parseExtensionIdempotencyKey(value.idempotencyKey),
    }),
  });
}

/** Replays retain the query's original accepted revision, rather than a current projection. */
export function parseProjectGenerationQueryUiActionResponse(
  request: ProjectGenerationQueryUiActionRequest,
  output: unknown,
): ProjectGenerationQueryUiReceipt {
  const checked = parseProjectGenerationQueryUiActionRequest(request);
  const value = pluginUiFields(
    parsePluginUiJsonValue(output, { maxBytes: 24 * 1024 }),
    [
      "disposition",
      "threadId",
      "threadRevision",
      "runId",
      "messageId",
      "configurationRevision",
    ],
  );
  if (value.disposition !== "committed" && value.disposition !== "replayed")
    pluginUiFailure("project_generation_query_ui_action_invalid");
  const threadId = parseExtensionIdempotencyKey(value.threadId);
  const threadRevision = positiveRevision(value.threadRevision);
  const configurationRevision = positiveRevision(value.configurationRevision);
  if (
    threadId !== checked.input.threadId ||
    threadRevision !== checked.input.expectedThreadRevision + 1 ||
    configurationRevision > 2_147_483_647
  )
    pluginUiFailure("project_generation_query_ui_action_invalid");
  return Object.freeze({
    disposition: value.disposition,
    threadId,
    threadRevision,
    runId: parseExtensionRunId(value.runId),
    messageId: parseExtensionIdempotencyKey(value.messageId),
    configurationRevision,
  });
}
