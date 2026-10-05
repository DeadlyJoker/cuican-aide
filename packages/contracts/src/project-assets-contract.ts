import { parseCreativeProjectIdempotencyKey } from "./creative-project-control-contract.ts";
import {
  assetContractChecked as checked,
  assetContractCopy as copy,
  assetContractRecord as record,
  assetContractRevision as revision,
  assetContractId as id,
  assetContractFailure as fail,
  assetContractKind as kind,
  parsePublicProjectAssetContent,
} from "./project-asset-contract-support.ts";
import { parseProjectAssetUiResponse } from "./project-asset-response-contract.ts";
import {
  isProjectAssetUiAction,
  MAX_PROJECT_ASSET_UI_INPUT_BYTES,
  MAX_PROJECT_ASSET_UI_RESPONSE_BYTES,
  type ProjectAssetUiActionRequest,
  type ProjectAssetUiCodec,
  type ProjectAssetUiAction,
  type ProjectAssetUiResponseMap,
  type SaveProjectAssetCandidateRequest,
  type SelectProjectAssetRevisionRequest,
  type SetProjectAssetLockedRequest,
  type SaveProjectAssetReferenceCandidateRequest,
  type SelectProjectAssetReferenceRequest,
} from "./project-assets-service.ts";
export { parsePublicProjectAssetContent } from "./project-asset-contract-support.ts";
export {
  parsePublicProjectAsset,
  parsePublicProjectAssetRevision,
  parsePublicProjectAssetImageSource,
  parsePublicProjectAssetReferenceRevision,
  parsePublicProjectAssetView,
} from "./project-asset-response-contract.ts";

export function parseProjectAssetId(input: unknown): string {
  return id(input);
}
export function parseSaveProjectAssetCandidateRequest(
  input: unknown,
): SaveProjectAssetCandidateRequest {
  return checked(() => {
    const value = record(copy(input, MAX_PROJECT_ASSET_UI_INPUT_BYTES), [
      "kind",
      "expectedAssetRevision",
      "briefRevision",
      "script",
      "content",
    ]);
    const script =
      value.script === null
        ? null
        : record(value.script, ["artifactId", "contentRevision"]);
    return Object.freeze({
      kind: kind(value.kind),
      expectedAssetRevision: revision(value.expectedAssetRevision, 0),
      briefRevision: revision(value.briefRevision),
      script:
        script === null
          ? null
          : Object.freeze({
              artifactId: id(script.artifactId),
              contentRevision: revision(script.contentRevision),
            }),
      content: parsePublicProjectAssetContent(value.content),
    });
  });
}
export function parseSelectProjectAssetRevisionRequest(
  input: unknown,
): SelectProjectAssetRevisionRequest {
  const value = record(copy(input, 1024), [
    "expectedAssetRevision",
    "contentRevision",
  ]);
  return Object.freeze({
    expectedAssetRevision: revision(value.expectedAssetRevision),
    contentRevision: revision(value.contentRevision),
  });
}
export function parseSetProjectAssetLockedRequest(
  input: unknown,
): SetProjectAssetLockedRequest {
  const value = record(copy(input, 1024), ["expectedAssetRevision", "locked"]);
  if (typeof value.locked !== "boolean") fail();
  return Object.freeze({
    expectedAssetRevision: revision(value.expectedAssetRevision),
    locked: value.locked,
  });
}
export function parseSaveProjectAssetReferenceCandidateRequest(
  input: unknown,
): SaveProjectAssetReferenceCandidateRequest {
  const value = record(copy(input, 2048), [
    "expectedAssetRevision",
    "assetContentRevision",
    "conceptAssetId",
    "selectionRevision",
  ]);
  return Object.freeze({
    expectedAssetRevision: revision(value.expectedAssetRevision),
    assetContentRevision: revision(value.assetContentRevision),
    conceptAssetId: id(value.conceptAssetId),
    selectionRevision: revision(value.selectionRevision),
  });
}
export function parseSelectProjectAssetReferenceRequest(
  input: unknown,
): SelectProjectAssetReferenceRequest {
  const value = record(copy(input, 1024), [
    "expectedAssetRevision",
    "referenceRevision",
  ]);
  return Object.freeze({
    expectedAssetRevision: revision(value.expectedAssetRevision),
    referenceRevision: revision(value.referenceRevision),
  });
}
/** No principal, actor, pin, URL, Run, configuration or caller-selected proof is accepted. */
export function parseProjectAssetUiActionRequest(
  input: unknown,
): ProjectAssetUiActionRequest {
  return checked(() => {
    const value = record(copy(input, MAX_PROJECT_ASSET_UI_INPUT_BYTES), [
        "action",
        "input",
      ]),
      action = value.action;
    if (!isProjectAssetUiAction(action)) fail();
    const base = ["projectId"];
    switch (action) {
      case "crewon.project-assets.v1.listAssets":
        base.push("afterAssetId", "limit");
        break;
      case "crewon.project-assets.v1.listRevisions":
        base.push("assetId", "afterContentRevision", "limit");
        break;
      case "crewon.project-assets.v1.listReferences":
        base.push("assetId", "afterReferenceRevision", "limit");
        break;
      case "crewon.project-assets.v1.getRevision":
        base.push("assetId", "contentRevision");
        break;
      case "crewon.project-assets.v1.getReferenceRevision":
        base.push("assetId", "referenceRevision");
        break;
      case "crewon.project-assets.v1.getAsset":
        base.push("assetId");
        break;
      default:
        base.push("assetId", "request", "idempotencyKey");
        break;
    }
    const body = record(value.input, base),
      projectId = id(body.projectId);
    if (action === "crewon.project-assets.v1.listAssets")
      return Object.freeze({
        action,
        input: Object.freeze({
          projectId,
          afterAssetId:
            body.afterAssetId === null ? null : id(body.afterAssetId),
          limit: revision(body.limit, 1, 16),
        }),
      });
    const assetId =
      action === "crewon.project-assets.v1.saveCandidate" &&
      body.assetId === null
        ? null
        : id(body.assetId);
    switch (action) {
      case "crewon.project-assets.v1.getAsset":
        return Object.freeze({
          action,
          input: Object.freeze({ projectId, assetId: assetId! }),
        });
      case "crewon.project-assets.v1.getRevision":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId: assetId!,
            contentRevision: revision(body.contentRevision),
          }),
        });
      case "crewon.project-assets.v1.getReferenceRevision":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId: assetId!,
            referenceRevision: revision(body.referenceRevision),
          }),
        });
      case "crewon.project-assets.v1.listRevisions":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId: assetId!,
            afterContentRevision: revision(body.afterContentRevision, 0),
            limit: revision(body.limit, 1, 16),
          }),
        });
      case "crewon.project-assets.v1.listReferences":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId: assetId!,
            afterReferenceRevision: revision(body.afterReferenceRevision, 0),
            limit: revision(body.limit, 1, 16),
          }),
        });
      default:
        break;
    }
    const idempotencyKey = id(
      parseCreativeProjectIdempotencyKey(body.idempotencyKey),
    );
    switch (action) {
      case "crewon.project-assets.v1.saveCandidate": {
        const request = parseSaveProjectAssetCandidateRequest(body.request);
        if ((assetId === null) !== (request.expectedAssetRevision === 0))
          fail();
        return Object.freeze({
          action,
          input: Object.freeze({ projectId, assetId, request, idempotencyKey }),
        });
      }
      case "crewon.project-assets.v1.selectRevision":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId: assetId!,
            request: parseSelectProjectAssetRevisionRequest(body.request),
            idempotencyKey,
          }),
        });
      case "crewon.project-assets.v1.setLocked":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId: assetId!,
            request: parseSetProjectAssetLockedRequest(body.request),
            idempotencyKey,
          }),
        });
      case "crewon.project-assets.v1.saveReferenceCandidate":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId: assetId!,
            request: parseSaveProjectAssetReferenceCandidateRequest(
              body.request,
            ),
            idempotencyKey,
          }),
        });
      case "crewon.project-assets.v1.selectReference":
        return Object.freeze({
          action,
          input: Object.freeze({
            projectId,
            assetId: assetId!,
            request: parseSelectProjectAssetReferenceRequest(body.request),
            idempotencyKey,
          }),
        });
    }
    return fail();
  });
}
export function parseProjectAssetUiActionResponse(
  requestInput: ProjectAssetUiActionRequest,
  input: unknown,
): ProjectAssetUiResponseMap[ProjectAssetUiAction] {
  return checked(() =>
    parseProjectAssetUiResponse(
      parseProjectAssetUiActionRequest(requestInput),
      copy(input, MAX_PROJECT_ASSET_UI_RESPONSE_BYTES),
    ),
  );
}
export const projectAssetsUiCodec: ProjectAssetUiCodec = Object.freeze({
  parseRequest: parseProjectAssetUiActionRequest,
  parseResponse: parseProjectAssetUiActionResponse,
});
