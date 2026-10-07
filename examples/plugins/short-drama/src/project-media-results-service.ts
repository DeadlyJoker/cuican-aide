/** Portable read-only result client; compiled codec is pinned independently of the frozen SDK. */
import type {
  MediaInputItem,
  MediaInputWorkflowId,
} from "./project-media-inputs-ui-client";
import {
  parseListProjectMediaResultsRequest,
  parseListProjectMediaResultsResponse,
  parseProjectMediaResultLocator,
  parseGetProjectMediaResultResponse,
} from "./project-media-results-codec.mjs";
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

export type ProjectMediaResultLocator = Readonly<{
  projectId: string;
  runId: string;
  resultIndex: number;
}>;
export type ProjectMediaResultPreview = Readonly<{
  candidate: ProjectMediaResultSummary;
  url: string;
}>;
type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
export function createPluginMediaResultClient(services: {
  invoke(
    action: string,
    input: Json,
    options: { signal?: AbortSignal },
  ): Promise<Json>;
}) {
  const invoke = services.invoke.bind(services);
  return Object.freeze({
    async listCandidates(
      input: ListProjectMediaResultsRequest,
      options: { signal?: AbortSignal } = {},
    ): Promise<ListProjectMediaResultsResponse> {
      const request = parseListProjectMediaResultsRequest(input);
      const result = await invoke(
        "crewon.project-media-results.v1.listCandidates",
        request,
        options,
      );
      options.signal?.throwIfAborted();
      return parseListProjectMediaResultsResponse(request, result);
    },
    async preview(
      input: ProjectMediaResultLocator,
      options: { signal?: AbortSignal } = {},
    ): Promise<ProjectMediaResultPreview | null> {
      const request = parseProjectMediaResultLocator(input);
      const result = await invoke(
        "crewon.project-media-results.v1.preview",
        request,
        options,
      );
      options.signal?.throwIfAborted();
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).sort().join() !== "candidate,url"
      )
        throw new Error("media_result_preview_invalid");
      const value = result as { candidate: Json; url: Json };
      const { candidate } = parseGetProjectMediaResultResponse(request, {
        candidate: value.candidate,
      });
      if (candidate === null && value.url === null) return null;
      if (
        !candidate ||
        typeof value.url !== "string" ||
        !/^blob:[^\s?#]{1,2048}$/u.test(value.url)
      )
        throw new Error("media_result_preview_invalid");
      return Object.freeze({ candidate, url: value.url });
    },
    async releasePreview(url: string): Promise<void> {
      await invoke(
        "crewon.project-media-results.v1.releasePreview",
        { url },
        {},
      );
    },
  });
}
export type PluginMediaResultClient = ReturnType<
  typeof createPluginMediaResultClient
>;
