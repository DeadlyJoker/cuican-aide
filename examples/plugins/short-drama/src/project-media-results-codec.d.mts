import type {
  ListProjectMediaResultsRequest,
  ListProjectMediaResultsResponse,
  ProjectMediaResultLocator,
  ProjectMediaResultSummary,
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
