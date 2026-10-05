import { ContractValidationError } from "./contract-validation-error.ts";
import {
  assetContractCopy as copy,
  assetContractRecord as record,
  assetContractId as id,
  assetContractRevision as revision,
  assetContractDigest as digest,
} from "./project-asset-contract-support.ts";
import { parseProjectAssetUiActionRequest } from "./project-assets-contract.ts";
import { isProjectAssetUiMutationAction } from "./project-assets-service.ts";
import {
  isProjectAssetRecoveryAction,
  MAX_PROJECT_ASSET_RECOVERY_INPUT_BYTES,
  MAX_PROJECT_ASSET_RECOVERY_RESPONSE_BYTES,
  PROJECT_ASSET_RECOVERY_REFUSAL_CODES,
  type ProjectAssetRecoveryActionRequest,
  type ProjectAssetRecoveryAction,
  type ProjectAssetRecoveryResponseMap,
  type ProjectAssetRecoveryCodec,
  type ProjectAssetRecoveryIntent,
  type ProjectAssetRecoveryRefusalCode,
  type ProjectAssetRecoveryConfirmed,
} from "./project-asset-recovery-service.ts";
export class ProjectAssetRecoveryContractError extends ContractValidationError {
  constructor() {
    super("project_asset_recovery_contract_invalid");
    this.name = "ProjectAssetRecoveryContractError";
  }
}
function checked<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return fail();
  }
}
function fail(): never {
  throw new ProjectAssetRecoveryContractError();
}
export function parseProjectAssetRecoveryActionRequest(
  input: unknown,
): ProjectAssetRecoveryActionRequest {
  return checked(() => {
    const value = record(copy(input, MAX_PROJECT_ASSET_RECOVERY_INPUT_BYTES), [
      "action",
      "input",
    ]);
    if (!isProjectAssetRecoveryAction(value.action)) fail();
    if (value.action === "crewon.project-asset-recovery.v1.getPending") {
      record(value.input, []);
      return Object.freeze({ action: value.action, input: Object.freeze({}) });
    }
    const body = record(value.input, ["intentId", "expectedRevision"]);
    return Object.freeze({
      action: value.action,
      input: Object.freeze({
        intentId: id(body.intentId),
        expectedRevision: revision(body.expectedRevision),
      }),
    });
  });
}
const kinds = Object.freeze({
  "crewon.project-assets.v1.saveCandidate": "save-content",
  "crewon.project-assets.v1.selectRevision": "select-content",
  "crewon.project-assets.v1.setLocked": "set-lock",
  "crewon.project-assets.v1.saveReferenceCandidate": "save-reference",
  "crewon.project-assets.v1.selectReference": "select-reference",
} as const);
export function parseProjectAssetRecoveryActionResponse(
  requestInput: ProjectAssetRecoveryActionRequest,
  input: unknown,
): ProjectAssetRecoveryResponseMap[ProjectAssetRecoveryAction] {
  return checked(() => {
    const request = parseProjectAssetRecoveryActionRequest(requestInput),
      output = copy(input, MAX_PROJECT_ASSET_RECOVERY_RESPONSE_BYTES);
    if (request.action === "crewon.project-asset-recovery.v1.acknowledge") {
      const value = record(output, ["intentId", "revision", "disposition"]),
        intentId = id(value.intentId),
        actualRevision = revision(value.revision);
      if (
        intentId !== request.input.intentId ||
        actualRevision !== request.input.expectedRevision + 1 ||
        (value.disposition !== "acknowledged" &&
          value.disposition !== "replayed")
      )
        fail();
      return Object.freeze({
        intentId,
        revision: actualRevision,
        disposition: value.disposition as "acknowledged" | "replayed",
      });
    }
    const value = record(output, ["intent"]);
    if (value.intent === null) return Object.freeze({ intent: null });
    const fields = record(value.intent, [
        "intentId",
        "revision",
        "phase",
        "request",
        "requestDigest",
        "confirmed",
        "refusalCode",
      ]),
      original = parseProjectAssetUiActionRequest(fields.request);
    if (!isProjectAssetUiMutationAction(original.action)) fail();
    const common = {
      intentId: id(fields.intentId),
      revision: revision(fields.revision),
      request: original as ProjectAssetRecoveryIntent["request"],
      requestDigest: digest(fields.requestDigest),
    };
    let intent: ProjectAssetRecoveryIntent;
    if (fields.phase === "pending") {
      if (fields.confirmed !== null || fields.refusalCode !== null) fail();
      intent = Object.freeze({
        ...common,
        phase: "pending",
        confirmed: null,
        refusalCode: null,
      });
    } else if (fields.phase === "accepted") {
      if (fields.refusalCode !== null) fail();
      const receipt = record(fields.confirmed, [
          "kind",
          "assetId",
          "assetRevision",
          "contentRevision",
          "referenceRevision",
          "requestDigest",
          "resultDigest",
        ]),
        assetId = id(receipt.assetId),
        assetRevision = revision(receipt.assetRevision),
        contentRevision =
          receipt.contentRevision === null
            ? null
            : revision(receipt.contentRevision),
        referenceRevision =
          receipt.referenceRevision === null
            ? null
            : revision(receipt.referenceRevision),
        kind = kinds[common.request.action];
      const contentKind = kind === "save-content" || kind === "select-content",
        referenceKind =
          kind === "save-reference" || kind === "select-reference";
      if (
        receipt.kind !== kind ||
        receipt.requestDigest !== common.requestDigest ||
        assetRevision !==
          common.request.input.request.expectedAssetRevision + 1 ||
        (common.request.input.assetId !== null &&
          common.request.input.assetId !== assetId) ||
        (contentRevision !== null) !== contentKind ||
        (referenceRevision !== null) !== referenceKind ||
        (common.request.action === "crewon.project-assets.v1.selectRevision" &&
          contentRevision !== common.request.input.request.contentRevision) ||
        (common.request.action === "crewon.project-assets.v1.selectReference" &&
          referenceRevision !== common.request.input.request.referenceRevision)
      )
        fail();
      const confirmed: ProjectAssetRecoveryConfirmed = Object.freeze({
        kind,
        assetId,
        assetRevision,
        contentRevision,
        referenceRevision,
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
        !PROJECT_ASSET_RECOVERY_REFUSAL_CODES.includes(
          fields.refusalCode as ProjectAssetRecoveryRefusalCode,
        )
      )
        fail();
      intent = Object.freeze({
        ...common,
        phase: "refused",
        confirmed: null,
        refusalCode: fields.refusalCode as ProjectAssetRecoveryRefusalCode,
      });
    } else return fail();
    return Object.freeze({ intent });
  });
}
export const projectAssetRecoveryCodec: ProjectAssetRecoveryCodec =
  Object.freeze({
    parseRequest: parseProjectAssetRecoveryActionRequest,
    parseResponse: parseProjectAssetRecoveryActionResponse,
  });
