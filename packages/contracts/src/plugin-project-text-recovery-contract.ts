import { ContractValidationError } from "./contract-validation-error.ts";
import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import { parseProjectTextId } from "./project-text-control-contract.ts";
import { parseProjectTextUiActionRequest } from "./plugin-project-texts-ui-contract.ts";
import { isProjectTextUiMutationAction } from "./plugin-project-texts-ui-service.ts";
import {
  isProjectTextRecoveryAction,
  MAX_PROJECT_TEXT_RECOVERY_INPUT_BYTES,
  MAX_PROJECT_TEXT_RECOVERY_RESPONSE_BYTES,
  type ProjectTextRecoveryActionRequest,
  type ProjectTextRecoveryCodec,
  type ProjectTextRecoveryResponseMap,
  type ProjectTextRecoveryAction,
  type ProjectTextRecoveryIntent,
  type ProjectTextRecoveryConfirmed,
  PROJECT_TEXT_RECOVERY_REFUSAL_CODES,
  type ProjectTextRecoveryRefusalCode,
} from "./plugin-project-text-recovery-service.ts";

export class PluginProjectTextRecoveryContractError extends ContractValidationError {
  constructor() {
    super("plugin_project_text_recovery_invalid");
    this.name = "PluginProjectTextRecoveryContractError";
  }
}
function checked<T>(run: () => T): T {
  try {
    return run();
  } catch {
    throw new PluginProjectTextRecoveryContractError();
  }
}
function integer(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    throw new PluginProjectTextRecoveryContractError();
  return input;
}
function digest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input))
    throw new PluginProjectTextRecoveryContractError();
  return input;
}
export function parseProjectTextRecoveryActionRequest(
  input: unknown,
): ProjectTextRecoveryActionRequest {
  return checked(() => {
    const value = pluginUiFields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_PROJECT_TEXT_RECOVERY_INPUT_BYTES,
      }),
      ["action", "input"],
    );
    if (!isProjectTextRecoveryAction(value.action))
      throw new PluginProjectTextRecoveryContractError();
    if (value.action === "crewon.project-text-recovery.v1.getPending") {
      const body = pluginUiFields(value.input, ["projectId"]);
      return Object.freeze({
        action: value.action,
        input: Object.freeze({ projectId: parseProjectTextId(body.projectId) }),
      });
    }
    const body = pluginUiFields(value.input, [
      "projectId",
      "intentId",
      "expectedRevision",
    ]);
    return Object.freeze({
      action: value.action,
      input: Object.freeze({
        projectId: parseProjectTextId(body.projectId),
        intentId: parseProjectTextId(body.intentId),
        expectedRevision: integer(body.expectedRevision),
      }),
    });
  });
}
const kinds = Object.freeze({
  "crewon.project-texts.v1.saveOutlineCandidate": "save-outline",
  "crewon.project-texts.v1.saveScriptCandidate": "save-script",
  "crewon.project-texts.v1.selectRevision": "select-revision",
  "crewon.project-texts.v1.setLocked": "set-lock",
} as const);
export function parseProjectTextRecoveryActionResponse(
  requestInput: ProjectTextRecoveryActionRequest,
  input: unknown,
): ProjectTextRecoveryResponseMap[ProjectTextRecoveryAction] {
  return checked(() => {
    const request = parseProjectTextRecoveryActionRequest(requestInput);
    const output = parsePluginUiJsonValue(input, {
      maxBytes: MAX_PROJECT_TEXT_RECOVERY_RESPONSE_BYTES,
    });
    if (request.action === "crewon.project-text-recovery.v1.acknowledge") {
      const value = pluginUiFields(output, [
        "intentId",
        "revision",
        "disposition",
      ]);
      const intentId = parseProjectTextId(value.intentId),
        revision = integer(value.revision);
      if (
        intentId !== request.input.intentId ||
        revision !== request.input.expectedRevision + 1 ||
        (value.disposition !== "acknowledged" &&
          value.disposition !== "replayed")
      )
        throw new PluginProjectTextRecoveryContractError();
      return Object.freeze({
        intentId,
        revision,
        disposition: value.disposition as "acknowledged" | "replayed",
      });
    }
    const value = pluginUiFields(output, ["intent"]);
    if (value.intent === null) return Object.freeze({ intent: null });
    const fields = pluginUiFields(value.intent, [
      "intentId",
      "revision",
      "phase",
      "request",
      "requestDigest",
      "confirmed",
      "refusalCode",
    ]);
    const original = parseProjectTextUiActionRequest(fields.request);
    if (
      !isProjectTextUiMutationAction(original.action) ||
      original.input.projectId !== request.input.projectId
    )
      throw new PluginProjectTextRecoveryContractError();
    const common = {
      intentId: parseProjectTextId(fields.intentId),
      revision: integer(fields.revision),
      request: original as ProjectTextRecoveryIntent["request"],
      requestDigest: digest(fields.requestDigest),
    };
    let intent: ProjectTextRecoveryIntent;
    if (fields.phase === "pending") {
      if (fields.confirmed !== null || fields.refusalCode !== null)
        throw new PluginProjectTextRecoveryContractError();
      intent = Object.freeze({
        ...common,
        phase: "pending",
        confirmed: null,
        refusalCode: null,
      });
    } else if (fields.phase === "accepted") {
      if (fields.refusalCode !== null)
        throw new PluginProjectTextRecoveryContractError();
      const receipt = pluginUiFields(fields.confirmed, [
        "kind",
        "artifactId",
        "artifactRevision",
        "contentRevision",
        "requestDigest",
        "resultDigest",
      ]);
      const contentRevision =
        receipt.contentRevision === null
          ? null
          : integer(receipt.contentRevision);
      const artifactId = parseProjectTextId(receipt.artifactId);
      if (
        receipt.kind !== kinds[original.action] ||
        receipt.requestDigest !== common.requestDigest ||
        (original.action === "crewon.project-texts.v1.setLocked"
          ? contentRevision !== null
          : contentRevision === null) ||
        ("artifactId" in original.input &&
          original.input.artifactId !== artifactId) ||
        (original.action === "crewon.project-texts.v1.selectRevision" &&
          contentRevision !== original.input.request.contentRevision)
      )
        throw new PluginProjectTextRecoveryContractError();
      const confirmed: ProjectTextRecoveryConfirmed = Object.freeze({
        kind: kinds[original.action],
        artifactId,
        artifactRevision: integer(receipt.artifactRevision),
        contentRevision,
        requestDigest: digest(receipt.requestDigest),
        resultDigest: digest(receipt.resultDigest),
      });
      intent = Object.freeze({
        ...common,
        phase: "accepted",
        confirmed,
        refusalCode: null,
      });
    } else if (fields.phase === "refused") {
      if (
        fields.confirmed !== null ||
        !PROJECT_TEXT_RECOVERY_REFUSAL_CODES.includes(
          fields.refusalCode as ProjectTextRecoveryRefusalCode,
        )
      )
        throw new PluginProjectTextRecoveryContractError();
      intent = Object.freeze({
        ...common,
        phase: "refused",
        confirmed: null,
        refusalCode: fields.refusalCode as ProjectTextRecoveryRefusalCode,
      });
    } else throw new PluginProjectTextRecoveryContractError();
    return Object.freeze({ intent });
  });
}
export const projectTextRecoveryCodec: ProjectTextRecoveryCodec = Object.freeze(
  {
    parseRequest: parseProjectTextRecoveryActionRequest,
    parseResponse: parseProjectTextRecoveryActionResponse,
  },
);
