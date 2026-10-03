import { parseCreativeProjectId } from "./creative-project-control-contract.ts";
import { parseExtensionIdempotencyKey } from "./extension-control-contract.ts";
import { parseExtensionRunId } from "./extension-read-contract.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFailure,
  pluginUiFields,
} from "./plugin-ui-json.ts";

/** Reserved protocol metadata; a declaration never grants generation authority. */
export const CREWON_PROJECT_GENERATIONS_SERVICE = "crewon.project-generations";
export const CREWON_PROJECT_GENERATIONS_API_VERSION = "1";
export const PROJECT_GENERATION_UI_ACTIONS = Object.freeze([
  "crewon.project-generations.v1.generateConcept",
] as const);
export type ProjectGenerationUiAction =
  (typeof PROJECT_GENERATION_UI_ACTIONS)[number];

/** Immutable saved input identity plus the two current metadata CAS values. */
export type ProjectGenerationUiReference = Readonly<{
  projectId: string;
  assetId: string;
  assetRevision: number;
  expectedProjectRevision: number;
  expectedAssetMetadataRevision: number;
}>;
export type ProjectGenerationUiInput = Readonly<{
  reference: ProjectGenerationUiReference;
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
}>;
/** The original task receipt; this protocol does not report supplier completion. */
export type ProjectGenerationUiReceipt = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  messageId: string;
  configurationRevision: number;
}>;
export type ProjectGenerationUiActionRequest = Readonly<{
  action: ProjectGenerationUiAction;
  input: ProjectGenerationUiInput;
}>;

function positiveRevision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    pluginUiFailure("project_generation_ui_action_invalid");
  return input;
}

/** Detached bounded business references only; the host supplies prompt, target and identity. */
export function parseProjectGenerationUiActionRequest(
  input: unknown,
): ProjectGenerationUiActionRequest {
  const envelope = pluginUiFields(input, ["action", "input"]);
  if (envelope.action !== PROJECT_GENERATION_UI_ACTIONS[0])
    pluginUiFailure("project_generation_ui_action_invalid");
  const value = pluginUiFields(
    parsePluginUiJsonValue(envelope.input, { maxBytes: 24 * 1024 }),
    ["reference", "threadId", "expectedThreadRevision", "idempotencyKey"],
  );
  const reference = pluginUiFields(value.reference, [
    "projectId",
    "assetId",
    "assetRevision",
    "expectedProjectRevision",
    "expectedAssetMetadataRevision",
  ]);
  const expectedThreadRevision = positiveRevision(value.expectedThreadRevision);
  // The accepted receipt must contain the next safe integer revision.
  if (expectedThreadRevision === Number.MAX_SAFE_INTEGER)
    pluginUiFailure("project_generation_ui_action_invalid");
  return Object.freeze({
    action: PROJECT_GENERATION_UI_ACTIONS[0],
    input: Object.freeze({
      reference: Object.freeze({
        projectId: parseCreativeProjectId(reference.projectId),
        assetId: parseCreativeProjectId(reference.assetId),
        assetRevision: positiveRevision(reference.assetRevision),
        expectedProjectRevision: positiveRevision(
          reference.expectedProjectRevision,
        ),
        expectedAssetMetadataRevision: positiveRevision(
          reference.expectedAssetMetadataRevision,
        ),
      }),
      // These follow the original task's UTF-8 opaque identifier bounds.
      threadId: parseExtensionIdempotencyKey(value.threadId),
      expectedThreadRevision,
      idempotencyKey: parseExtensionIdempotencyKey(value.idempotencyKey),
    }),
  });
}

/** A replay carries the same original accepted revision, never a newer thread projection. */
export function parseProjectGenerationUiActionResponse(
  request: ProjectGenerationUiActionRequest,
  output: unknown,
): ProjectGenerationUiReceipt {
  const checked = parseProjectGenerationUiActionRequest(request);
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
    pluginUiFailure("project_generation_ui_action_invalid");
  const threadId = parseExtensionIdempotencyKey(value.threadId);
  const threadRevision = positiveRevision(value.threadRevision);
  const configurationRevision = positiveRevision(value.configurationRevision);
  if (
    threadId !== checked.input.threadId ||
    threadRevision !== checked.input.expectedThreadRevision + 1 ||
    configurationRevision > 2_147_483_647
  )
    pluginUiFailure("project_generation_ui_action_invalid");
  return Object.freeze({
    disposition: value.disposition,
    threadId,
    threadRevision,
    runId: parseExtensionRunId(value.runId),
    messageId: parseExtensionIdempotencyKey(value.messageId),
    configurationRevision,
  });
}
