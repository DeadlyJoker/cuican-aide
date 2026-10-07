import type {
  ListProjectMediaResultsRequest,
  ListProjectMediaResultsResponse,
  ProjectMediaResultLocator,
  ProjectMediaResultSummary,
  ProjectMediaRunLocator,
  ProjectMediaRunOutputs,
  SavedProjectMediaResult,
} from "./project-media-results-service";
export function parseListProjectMediaResultsRequest(
  input: unknown,
): ListProjectMediaResultsRequest;
export function parseListProjectMediaResultsResponse(
  request: ListProjectMediaResultsRequest,
  input: unknown,
): ListProjectMediaResultsResponse;
export function parseProjectMediaResultLocator(
  input: unknown,
): ProjectMediaResultLocator;
export function parseGetProjectMediaResultResponse(
  request: ProjectMediaResultLocator,
  input: unknown,
): Readonly<{ candidate: ProjectMediaResultSummary | null }>;

export function parseProjectMediaRunLocator(
  input: unknown,
): ProjectMediaRunLocator;
export function parseProjectMediaRunOutputs(
  request: ProjectMediaRunLocator,
  input: unknown,
): ProjectMediaRunOutputs;
export function parsePublishProjectMediaResultResponse(
  request: ProjectMediaResultLocator,
  input: unknown,
): SavedProjectMediaResult;
