import { MAX_PROJECT_TEXT_UI_RESPONSE_BYTES } from "@crewon/contracts/project-texts-ui";
import type {
  ProjectTextArtifact,
  ProjectTextArtifactRevision,
} from "@crewon/domain";
import type {
  ProjectTextArtifactView,
  ProjectTextMutationResult,
} from "./project-text-store-port.ts";
import { ApplicationError } from "./application-error.ts";

/** Only shared creative content and public metadata cross the plugin boundary. */
export function textActionArtifact(value: ProjectTextArtifact) {
  return {
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
  };
}
export function textActionRevision(value: ProjectTextArtifactRevision) {
  return {
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
  };
}
export function textActionView(value: ProjectTextArtifactView | null) {
  return value === null
    ? null
    : {
        artifact: textActionArtifact(value.artifact),
        selectedRevision:
          value.selectedRevision === null
            ? null
            : textActionRevision(value.selectedRevision),
        dependencyState: value.dependencyState,
        staleReasons: value.staleReasons,
      };
}
export function textActionMutation(value: ProjectTextMutationResult) {
  return {
    kind: value.kind,
    disposition: value.disposition,
    artifact: textActionArtifact(value.artifact),
    contentRevision:
      value.contentRevision === null
        ? null
        : textActionRevision(value.contentRevision),
  };
}
/** Whole-record suffix trimming preserves content/digest and the last delivered cursor. */
export function textActionPage<T, Cursor, Response>(
  input: Readonly<{
    items: readonly T[];
    continuation: Cursor | null;
    cursorOf(item: T): Cursor;
    response(items: readonly T[], next: Cursor | null): Response;
  }>,
): Response {
  for (let length = input.items.length; length >= 0; length--) {
    const items = input.items.slice(0, length);
    const next =
      length === input.items.length
        ? input.continuation
        : length === 0
          ? null
          : input.cursorOf(items[length - 1]!);
    const response = input.response(items, next);
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength <=
      MAX_PROJECT_TEXT_UI_RESPONSE_BYTES
    ) {
      if (length === 0 && input.items.length !== 0) break;
      return response;
    }
  }
  throw new ApplicationError("internal", "plugin_project_text_response_limit");
}
