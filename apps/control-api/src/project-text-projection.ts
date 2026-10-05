import {
  ApplicationError,
  type ProjectTextMutationResult,
  type ProjectTextArtifactView,
} from "@crewon/application";
import type {
  ProjectTextArtifact,
  ProjectTextArtifactRevision,
} from "@crewon/domain";
import {
  MAX_PROJECT_TEXT_RESPONSE_BYTES,
  parsePublicProjectTextArtifact,
  parsePublicProjectTextRevision,
  parsePublicProjectTextArtifactView,
  type ProjectTextMutationResponse,
} from "@crewon/contracts";
/** Only business data crosses the public boundary; owner, actor and tenancy stay internal. */
export function projectTextArtifact(value: ProjectTextArtifact) {
  return parsePublicProjectTextArtifact({
    projectId: value.projectId,
    artifactId: value.artifactId,
    kind: value.kind,
    episodeId: value.episodeId,
    revision: value.revision,
    latestContentRevision: value.latestContentRevision,
    selectedContentRevision: value.selectedContentRevision,
    locked: value.locked,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}
export function projectTextRevision(value: ProjectTextArtifactRevision) {
  return parsePublicProjectTextRevision({
    projectId: value.projectId,
    artifactId: value.artifactId,
    kind: value.kind,
    episodeId: value.episodeId,
    contentRevision: value.contentRevision,
    brief: {
      briefRevision: value.brief.briefRevision,
      contentDigest: value.brief.contentDigest,
    },
    outline:
      value.outline === null
        ? null
        : {
            artifactId: value.outline.artifactId,
            contentRevision: value.outline.contentRevision,
            contentDigest: value.outline.contentDigest,
          },
    content: value.content,
    contentDigest: value.contentDigest,
    createdAt: value.createdAt,
  });
}
export function projectTextArtifactView(value: ProjectTextArtifactView | null) {
  return value === null
    ? null
    : parsePublicProjectTextArtifactView({
        artifact: projectTextArtifact(value.artifact),
        selectedRevision:
          value.selectedRevision === null
            ? null
            : projectTextRevision(value.selectedRevision),
        dependencyState: value.dependencyState,
        staleReasons: value.staleReasons,
      });
}
export function projectTextMutation(
  value: ProjectTextMutationResult,
): ProjectTextMutationResponse {
  return boundedProjectTextResponse({
    kind: value.kind,
    disposition: value.disposition,
    artifact: projectTextArtifact(value.artifact),
    contentRevision:
      value.contentRevision === null
        ? null
        : projectTextRevision(value.contentRevision),
  });
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
export function boundedProjectTextResponse<T>(value: T): T {
  if (bytes(value) > MAX_PROJECT_TEXT_RESPONSE_BYTES)
    throw new ApplicationError("internal", "project_text_response_limit");
  return value;
}
/** History pagination drops whole suffix records, preserving each immutable content and its digest. */
export function boundedProjectTextPage<T, Cursor, Response>(
  input: Readonly<{
    items: readonly T[];
    continuation: Cursor | null;
    cursorOf(item: T): Cursor;
    response(items: readonly T[], next: Cursor | null): Response;
  }>,
): Response {
  for (let length = input.items.length; length >= 0; length--) {
    const items = input.items.slice(0, length),
      next =
        length === input.items.length
          ? input.continuation
          : length === 0
            ? null
            : input.cursorOf(items[length - 1]!);
    const result = input.response(items, next);
    if (bytes(result) <= MAX_PROJECT_TEXT_RESPONSE_BYTES) {
      if (length === 0 && input.items.length > 0)
        throw new ApplicationError("internal", "project_text_response_limit");
      return result;
    }
  }
  throw new ApplicationError("internal", "project_text_response_limit");
}
