import { ContractValidationError } from "./contract-validation-error.ts";
import {
  parsePluginUiJsonValue,
  pluginUiFields as fields,
} from "./plugin-ui-json.ts";
import {
  assetContractId as id,
  assetContractRevision as revision,
  assetContractDigest as digest,
  assetContractTimestamp as timestamp,
} from "./project-asset-contract-support.ts";
import type {
  MediaInputItem,
  MediaInputWorkflowId,
} from "./project-media-inputs.ts";

export const MAX_MEDIA_RESULT_CATALOG_BYTES = 64 * 1024;
export type ListProjectMediaResultsRequest = Readonly<{
  projectId: string;
  afterCandidateId: string | null;
  limit: number;
}>;
/** Recorded provenance and media dimensions; this does not assert current byte availability or adoption. */
export type ProjectMediaResultSummary = Readonly<{
  projectId: string;
  candidateId: string;
  runId: string;
  resultIndex: number;
  executionId: string;
  mediaInputId: string;
  inputRevision: number;
  workflowId: MediaInputWorkflowId;
  item: MediaInputItem;
  contentDigest: string;
  media: Readonly<{
    type: "image/png";
    byteDigest: string;
    byteLength: number;
    width: number;
    height: number;
    observedAt: string;
  }>;
}>;
export type ListProjectMediaResultsResponse = Readonly<{
  candidates: readonly ProjectMediaResultSummary[];
  nextCandidateId: string | null;
}>;
export function mediaResultCandidateId(input: unknown): string {
  if (typeof input !== "string" || !/^result-[a-f0-9]{64}$/u.test(input))
    invalid();
  return input;
}
export function parseListProjectMediaResultsRequest(
  input: unknown,
): ListProjectMediaResultsRequest {
  const r = fields(parsePluginUiJsonValue(input, { maxBytes: 2048 }), [
    "projectId",
    "afterCandidateId",
    "limit",
  ]);
  return Object.freeze({
    projectId: id(r.projectId),
    afterCandidateId:
      r.afterCandidateId === null
        ? null
        : mediaResultCandidateId(r.afterCandidateId),
    limit: revision(r.limit, 1, 16),
  });
}
export function parseListProjectMediaResultsResponse(
  request: ListProjectMediaResultsRequest,
  input: unknown,
): ListProjectMediaResultsResponse {
  const q = parseListProjectMediaResultsRequest(request),
    r = fields(
      parsePluginUiJsonValue(input, {
        maxBytes: MAX_MEDIA_RESULT_CATALOG_BYTES,
      }),
      ["candidates", "nextCandidateId"],
    );
  if (!Array.isArray(r.candidates) || r.candidates.length > q.limit) invalid();
  let previous = q.afterCandidateId;
  const positions = new Set<string>();
  const candidates = r.candidates.map((entry): ProjectMediaResultSummary => {
    const c = fields(entry, [
        "projectId",
        "candidateId",
        "runId",
        "resultIndex",
        "executionId",
        "mediaInputId",
        "inputRevision",
        "workflowId",
        "item",
        "contentDigest",
        "media",
      ]),
      candidateId = mediaResultCandidateId(c.candidateId),
      projectId = id(c.projectId),
      runId = id(c.runId),
      resultIndex = revision(c.resultIndex, 0, 15),
      position = JSON.stringify([runId, resultIndex]);
    if (
      projectId !== q.projectId ||
      (previous !== null && candidateId <= previous) ||
      positions.has(position)
    )
      invalid();
    previous = candidateId;
    positions.add(position);
    let item: MediaInputItem;
    if (c.workflowId === "krea2-reference-four-view") {
      const value = fields(c.item, ["kind", "assetId"]);
      if (value.kind !== "character-reference") invalid();
      item = Object.freeze({ kind: value.kind, assetId: id(value.assetId) });
    } else if (c.workflowId === "flux2-three-reference-storyboard") {
      const value = fields(c.item, ["kind", "episodeId"]);
      if (value.kind !== "storyboard-frame-exploration") invalid();
      item = Object.freeze({
        kind: value.kind,
        episodeId: id(value.episodeId),
      });
    } else invalid();
    const m = fields(c.media, [
      "type",
      "byteDigest",
      "byteLength",
      "width",
      "height",
      "observedAt",
    ]);
    if (m.type !== "image/png") invalid();
    return Object.freeze({
      projectId,
      candidateId,
      runId,
      resultIndex,
      executionId: id(c.executionId),
      mediaInputId: id(c.mediaInputId),
      inputRevision: revision(c.inputRevision),
      workflowId: c.workflowId,
      item,
      contentDigest: digest(c.contentDigest),
      media: Object.freeze({
        type: m.type,
        byteDigest: digest(m.byteDigest),
        byteLength: revision(m.byteLength, 57, 16 * 1024 * 1024),
        width: revision(m.width, 1, 4096),
        height: revision(m.height, 1, 4096),
        observedAt: timestamp(m.observedAt),
      }),
    });
  });
  const nextCandidateId =
    r.nextCandidateId === null
      ? null
      : mediaResultCandidateId(r.nextCandidateId);
  if (
    nextCandidateId !== null &&
    (candidates.length !== q.limit ||
      candidates.at(-1)?.candidateId !== nextCandidateId)
  )
    invalid();
  return Object.freeze({
    candidates: Object.freeze(candidates),
    nextCandidateId,
  });
}
function invalid(): never {
  throw new ContractValidationError("project_media_results_contract_invalid");
}

export type ProjectMediaResultLocator = Readonly<{
  projectId: string;
  runId: string;
  resultIndex: number;
}>;
export function parseProjectMediaResultLocator(
  input: unknown,
): ProjectMediaResultLocator {
  const r = fields(parsePluginUiJsonValue(input, { maxBytes: 2048 }), [
    "projectId",
    "runId",
    "resultIndex",
  ]);
  return Object.freeze({
    projectId: id(r.projectId),
    runId: id(r.runId),
    resultIndex: revision(r.resultIndex, 0, 15),
  });
}
export function parseGetProjectMediaResultResponse(
  request: ProjectMediaResultLocator,
  input: unknown,
): Readonly<{ candidate: ProjectMediaResultSummary | null }> {
  const q = parseProjectMediaResultLocator(request),
    r = fields(parsePluginUiJsonValue(input, { maxBytes: 8192 }), [
      "candidate",
    ]);
  if (r.candidate === null) return Object.freeze({ candidate: null });
  const candidate = parseListProjectMediaResultsResponse(
    { projectId: q.projectId, afterCandidateId: null, limit: 1 },
    { candidates: [r.candidate], nextCandidateId: null },
  ).candidates[0]!;
  if (candidate.runId !== q.runId || candidate.resultIndex !== q.resultIndex)
    invalid();
  return Object.freeze({ candidate });
}
export function parsePublishProjectMediaResultResponse(
  request: ProjectMediaResultLocator,
  input: unknown,
): Readonly<{
  disposition: "created" | "replayed";
  candidate: ProjectMediaResultSummary;
}> {
  const r = fields(parsePluginUiJsonValue(input, { maxBytes: 8192 }), [
    "disposition",
    "candidate",
  ]);
  if (r.disposition !== "created" && r.disposition !== "replayed") invalid();
  const { candidate } = parseGetProjectMediaResultResponse(request, {
    candidate: r.candidate,
  });
  if (candidate === null) invalid();
  return Object.freeze({ disposition: r.disposition, candidate });
}
