import {
  assetContractChecked as checked,
  assetContractCopy as copy,
  assetContractRecord as record,
  assetContractRevision as revision,
  assetContractId as id,
  assetContractDigest as digest,
  assetContractTimestamp as timestamp,
  assetContractFailure as fail,
} from "./project-asset-contract-support.ts";
import {
  parseProjectAssetUiActionRequest,
  parseProjectAssetUiActionResponse,
  parsePublicProjectAsset,
  parsePublicProjectAssetImageSource,
} from "./project-assets-contract.ts";
import {
  parsePublicProjectAssetViewWithReference,
  parseProjectAssetMutationWithReference,
} from "./project-asset-response-contract.ts";
import { parseCreativeProjectIdempotencyKey } from "./creative-project-control-contract.ts";
import {
  MAX_PROJECT_ASSET_UI_INPUT_BYTES,
  MAX_PROJECT_ASSET_UI_RESPONSE_BYTES,
} from "./project-assets-service.ts";
import {
  PROJECT_ASSET_V2_ACTIONS as actions,
  isProjectAssetV2Action,
  isProjectAssetV2MutationAction,
  type ProjectAssetV2LegacyRequest,
  type ProjectAssetV2Request,
  type ProjectAssetV2MutationRequest,
  type ProjectAssetV2MutationResponse,
  type ProjectAssetV2AdoptionResponse,
  type ProjectAssetV2Response,
  type PublicProjectAssetReferenceRevisionV2,
  type PublicProjectAssetViewV2,
  type PublicProjectAssetMediaSource,
} from "./project-assets-v2-types.ts";

function candidateId(value: unknown): string {
  if (typeof value !== "string" || !/^result-[a-f0-9]{64}$/u.test(value))
    fail();
  return value;
}
export function parsePublicProjectAssetMediaSource(
  input: unknown,
): PublicProjectAssetMediaSource {
  const s = record(copy(input, 4096), [
      "kind",
      "candidateId",
      "candidateDigest",
      "sourceRunId",
      "resultIndex",
      "mediaInputId",
      "inputRevision",
      "workflowId",
      "generatedFor",
      "observedAt",
    ]),
    g = record(s.generatedFor, [
      "assetId",
      "contentRevision",
      "contentDigest",
      "referenceRevision",
      "referenceDigest",
    ]);
  if (s.kind !== "media-result" || s.workflowId !== "krea2-reference-four-view")
    fail();
  return Object.freeze({
    kind: "media-result",
    candidateId: candidateId(s.candidateId),
    candidateDigest: digest(s.candidateDigest),
    sourceRunId: id(s.sourceRunId),
    resultIndex: revision(s.resultIndex, 0, 15),
    mediaInputId: id(s.mediaInputId),
    inputRevision: revision(s.inputRevision),
    workflowId: "krea2-reference-four-view",
    generatedFor: Object.freeze({
      assetId: id(g.assetId),
      contentRevision: revision(g.contentRevision),
      contentDigest: digest(g.contentDigest),
      referenceRevision: revision(g.referenceRevision),
      referenceDigest: digest(g.referenceDigest),
    }),
    observedAt: timestamp(s.observedAt),
  });
}
export function parsePublicProjectAssetReferenceRevisionV2(
  input: unknown,
): PublicProjectAssetReferenceRevisionV2 {
  return checked(() => {
    const r = record(copy(input, 16 * 1024), [
        "projectId",
        "assetId",
        "referenceRevision",
        "assetContentRevision",
        "assetContentDigest",
        "source",
        "createdAt",
        "contentDigest",
      ]),
      raw = r.source;
    if (!raw || typeof raw !== "object") fail();
    const origin = (raw as Record<string, unknown>).kind;
    let source: PublicProjectAssetReferenceRevisionV2["source"];
    if (origin === "media-result")
      source = parsePublicProjectAssetMediaSource(raw);
    else if (origin === "concept-selection") {
      const { kind: _, ...legacy } = raw as Record<string, unknown>;
      source = Object.freeze({
        kind: "concept-selection",
        ...parsePublicProjectAssetImageSource(legacy),
      });
    } else return fail();
    const result = Object.freeze({
      projectId: id(r.projectId),
      assetId: id(r.assetId),
      referenceRevision: revision(r.referenceRevision),
      assetContentRevision: revision(r.assetContentRevision),
      assetContentDigest: digest(r.assetContentDigest),
      source,
      createdAt: timestamp(r.createdAt),
      contentDigest: digest(r.contentDigest),
    });
    if (
      source.kind === "media-result" &&
      (source.generatedFor.assetId !== result.assetId ||
        source.generatedFor.contentRevision !== result.assetContentRevision ||
        source.generatedFor.contentDigest !== result.assetContentDigest ||
        source.generatedFor.referenceRevision >= result.referenceRevision ||
        source.observedAt > result.createdAt)
    )
      fail();
    return result;
  });
}
export function parsePublicProjectAssetViewV2(
  input: unknown,
): PublicProjectAssetViewV2 {
  const view = parsePublicProjectAssetViewWithReference(
    input,
    parsePublicProjectAssetReferenceRevisionV2,
  );
  if (
    view.selectedReferenceRevision?.source.kind === "media-result" &&
    view.asset.kind !== "character"
  )
    fail();
  return view;
}
export function parseProjectAssetV2Request(
  input: unknown,
): ProjectAssetV2Request {
  return checked(() => {
    const r = record(copy(input, MAX_PROJECT_ASSET_UI_INPUT_BYTES), [
      "action",
      "input",
    ]);
    switch (r.action) {
      case actions.getAsset: {
        const q = parseProjectAssetUiActionRequest({
          action: "crewon.project-assets.v1.getAsset",
          input: r.input,
        });
        if (q.action !== "crewon.project-assets.v1.getAsset") return fail();
        return Object.freeze({ action: r.action, input: q.input });
      }
      case actions.getReferenceRevision: {
        const q = parseProjectAssetUiActionRequest({
          action: "crewon.project-assets.v1.getReferenceRevision",
          input: r.input,
        });
        if (q.action !== "crewon.project-assets.v1.getReferenceRevision")
          return fail();
        return Object.freeze({ action: r.action, input: q.input });
      }
      case actions.listReferences: {
        const q = parseProjectAssetUiActionRequest({
          action: "crewon.project-assets.v1.listReferences",
          input: r.input,
        });
        if (q.action !== "crewon.project-assets.v1.listReferences")
          return fail();
        return Object.freeze({ action: r.action, input: q.input });
      }
      case actions.adoptMediaReference: {
        const q = record(r.input, [
          "projectId",
          "assetId",
          "expectedAssetRevision",
          "assetContentRevision",
          "runId",
          "resultIndex",
          "candidateId",
          "candidateDigest",
          "idempotencyKey",
        ]);
        return Object.freeze({
          action: r.action,
          input: Object.freeze({
            projectId: id(q.projectId),
            assetId: id(q.assetId),
            expectedAssetRevision: revision(q.expectedAssetRevision),
            assetContentRevision: revision(q.assetContentRevision),
            runId: id(q.runId),
            resultIndex: revision(q.resultIndex, 0, 15),
            candidateId: candidateId(q.candidateId),
            candidateDigest: digest(q.candidateDigest),
            idempotencyKey: id(
              parseCreativeProjectIdempotencyKey(q.idempotencyKey),
            ),
          }),
        });
      }
      default:
        if (!isProjectAssetV2Action(r.action)) return fail();
        const legacy = parseProjectAssetUiActionRequest({
          action: r.action.replace(".v2.", ".v1."),
          input: r.input,
        });
        return Object.freeze({
          action: r.action,
          input: legacy.input,
        }) as ProjectAssetV2LegacyRequest;
    }
  });
}
function scope(
  q: { projectId: string; assetId: string },
  r: { projectId: string; assetId: string },
) {
  if (q.projectId !== r.projectId || q.assetId !== r.assetId) fail();
}
export function parseProjectAssetV2Response(
  request: Extract<
    ProjectAssetV2Request,
    { action: typeof actions.adoptMediaReference }
  >,
  input: unknown,
): ProjectAssetV2AdoptionResponse;
export function parseProjectAssetV2Response(
  request: ProjectAssetV2MutationRequest,
  input: unknown,
): ProjectAssetV2MutationResponse;
export function parseProjectAssetV2Response(
  request: ProjectAssetV2Request,
  input: unknown,
): ProjectAssetV2Response;
export function parseProjectAssetV2Response(
  request: ProjectAssetV2Request,
  input: unknown,
): ProjectAssetV2Response {
  return checked(() => {
    const q = parseProjectAssetV2Request(request),
      value = copy(input, MAX_PROJECT_ASSET_UI_RESPONSE_BYTES);
    switch (q.action) {
      case actions.getAsset: {
        const v = record(value, ["view"]),
          view = v.view === null ? null : parsePublicProjectAssetViewV2(v.view);
        if (view) scope(q.input, view.asset);
        return Object.freeze({ view });
      }
      case actions.getReferenceRevision: {
        const v = record(value, ["referenceRevision"]),
          referenceRevision = parsePublicProjectAssetReferenceRevisionV2(
            v.referenceRevision,
          );
        scope(q.input, referenceRevision);
        if (q.input.referenceRevision !== referenceRevision.referenceRevision)
          fail();
        return Object.freeze({ referenceRevision });
      }
      case actions.listReferences: {
        const v = record(value, ["references", "nextReferenceRevision"]);
        if (!Array.isArray(v.references) || v.references.length > q.input.limit)
          fail();
        const references = v.references.map(
          parsePublicProjectAssetReferenceRevisionV2,
        );
        let prior = q.input.afterReferenceRevision;
        for (const r of references) {
          scope(q.input, r);
          if (r.referenceRevision <= prior) fail();
          prior = r.referenceRevision;
        }
        const nextReferenceRevision =
          v.nextReferenceRevision === null
            ? null
            : revision(v.nextReferenceRevision);
        if (
          nextReferenceRevision !== null &&
          (references.length === 0 || nextReferenceRevision !== prior)
        )
          fail();
        return Object.freeze({
          references: Object.freeze(references),
          nextReferenceRevision,
        });
      }
      case actions.adoptMediaReference: {
        const v = record(value, ["disposition", "asset", "referenceRevision"]),
          asset = parsePublicProjectAsset(v.asset),
          reference = parsePublicProjectAssetReferenceRevisionV2(
            v.referenceRevision,
          ),
          source = reference.source;
        scope(q.input, asset);
        scope(q.input, reference);
        if (
          (v.disposition !== "committed" && v.disposition !== "replayed") ||
          source.kind !== "media-result"
        )
          return fail();
        if (
          asset.kind !== "character" ||
          asset.locked ||
          asset.revision !== q.input.expectedAssetRevision + 1 ||
          asset.selectedContentRevision !== q.input.assetContentRevision ||
          reference.assetContentRevision !== q.input.assetContentRevision ||
          asset.selectedReferenceRevision !== reference.referenceRevision ||
          asset.latestReferenceRevision !== reference.referenceRevision ||
          asset.updatedAt !== reference.createdAt ||
          source.candidateId !== q.input.candidateId ||
          source.candidateDigest !== q.input.candidateDigest ||
          source.sourceRunId !== q.input.runId ||
          source.resultIndex !== q.input.resultIndex
        )
          fail();
        return Object.freeze({
          disposition: v.disposition,
          asset,
          referenceRevision: Object.freeze({ ...reference, source }),
        });
      }
      default: {
        const legacy = parseProjectAssetUiActionRequest({
          action: q.action.replace(".v2.", ".v1."),
          input: q.input,
        });
        if (isProjectAssetV2MutationAction(q.action)) {
          if (!("request" in legacy.input)) return fail();
          const result = parseProjectAssetMutationWithReference(
            legacy as Extract<typeof legacy, { input: { request: unknown } }>,
            value,
            {
              parseReference: parsePublicProjectAssetReferenceRevisionV2,
              conceptSelection: (r) =>
                r.source.kind === "concept-selection" ? r.source : null,
            },
          );
          if (
            result.referenceRevision?.source.kind === "media-result" &&
            result.asset.kind !== "character"
          )
            return fail();
          return result;
        }
        // These three public shapes contain no references and remain exactly compatible.
        if (
          legacy.action !== "crewon.project-assets.v1.getRevision" &&
          legacy.action !== "crewon.project-assets.v1.listAssets" &&
          legacy.action !== "crewon.project-assets.v1.listRevisions"
        )
          return fail();
        return parseProjectAssetUiActionResponse(
          legacy,
          value,
        ) as ProjectAssetV2Response;
      }
    }
  });
}
