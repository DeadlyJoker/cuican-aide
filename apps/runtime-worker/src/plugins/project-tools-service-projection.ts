import {
  extensionCanonicalJson,
  type CreativeProject,
  type ProjectBriefRevision,
  type ProjectTextArtifact,
  type ProjectTextArtifactRevision,
} from "@crewon/domain";
import type {
  CreateCreativeProjectResult,
  AppendProjectBriefResult,
  ProjectTextArtifactView,
  ProjectTextMutationResult,
} from "@crewon/application";
import {
  MAX_PROJECT_TOOLS_RESPONSE_BYTES,
  PROJECT_TOOLS_CONTENT_CHUNK_CODE_POINTS,
  type ProjectToolsArtifact,
  type ProjectToolsArtifactView,
  type ProjectToolsBriefMetadata,
  type ProjectToolsBriefMutation,
  type ProjectToolsContentChunk,
  type ProjectToolsProject,
  type ProjectToolsRevisionMetadata,
  type ProjectToolsTextMutation,
} from "@crewon/contracts/project-tools";
export function projectToolsProject(
  value: CreativeProject,
): ProjectToolsProject {
  return Object.freeze({
    projectId: value.projectId,
    kind: value.kind,
    title: value.title,
    revision: value.revision,
    state: value.state,
    latestBriefRevision: value.latestBriefRevision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}
export function projectToolsBrief(
  value: ProjectBriefRevision,
): ProjectToolsBriefMetadata {
  return Object.freeze({
    projectId: value.projectId,
    briefRevision: value.briefRevision,
    contentDigest: value.contentDigest,
    createdAt: value.createdAt,
  });
}
export function projectToolsArtifact(
  value: ProjectTextArtifact,
): ProjectToolsArtifact {
  const common = {
    projectId: value.projectId,
    artifactId: value.artifactId,
    revision: value.revision,
    latestContentRevision: value.latestContentRevision,
    selectedContentRevision: value.selectedContentRevision,
    locked: value.locked,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  return Object.freeze(
    value.kind === "outline"
      ? { ...common, kind: "outline", episodeId: null }
      : { ...common, kind: "script", episodeId: value.episodeId },
  );
}
export function projectToolsRevision(
  value: ProjectTextArtifactRevision,
): ProjectToolsRevisionMetadata {
  const common = {
    projectId: value.projectId,
    artifactId: value.artifactId,
    contentRevision: value.contentRevision,
    brief: { ...value.brief },
    contentDigest: value.contentDigest,
    createdAt: value.createdAt,
  };
  return Object.freeze(
    value.kind === "outline"
      ? { ...common, kind: "outline", episodeId: null, outline: null }
      : {
          ...common,
          kind: "script",
          episodeId: value.episodeId,
          outline: value.outline === null ? null : { ...value.outline },
        },
  );
}
export function projectToolsView(
  value: ProjectTextArtifactView | null,
): ProjectToolsArtifactView | null {
  return value === null
    ? null
    : Object.freeze({
        artifact: projectToolsArtifact(value.artifact),
        selectedRevision:
          value.selectedRevision === null
            ? null
            : projectToolsRevision(value.selectedRevision),
        dependencyState: value.dependencyState,
        staleReasons: [...value.staleReasons],
      });
}
export function projectToolsTextMutation(
  value: ProjectTextMutationResult,
): ProjectToolsTextMutation {
  return Object.freeze({
    kind: value.kind,
    disposition: value.disposition,
    artifact: projectToolsArtifact(value.artifact),
    contentRevision:
      value.contentRevision === null
        ? null
        : projectToolsRevision(value.contentRevision),
  });
}
export function projectToolsBriefMutation(
  value: CreateCreativeProjectResult | AppendProjectBriefResult,
): ProjectToolsBriefMutation {
  return Object.freeze({
    kind: value.kind,
    disposition: value.disposition,
    project: projectToolsProject(value.project),
    brief: projectToolsBrief(value.brief),
  });
}
export function projectToolsContent(
  contentDigest: string,
  format: ProjectToolsContentChunk["format"],
  text: string,
  offset: number,
): ProjectToolsContentChunk {
  const points = Array.from(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > points.length)
    throw new Error("plugin_project_tools_content_offset_invalid");
  const end = Math.min(
    offset + PROJECT_TOOLS_CONTENT_CHUNK_CODE_POINTS,
    points.length,
  );
  return Object.freeze({
    contentDigest,
    format,
    offset,
    nextOffset: end < points.length ? end : null,
    totalCodePoints: points.length,
    text: points.slice(offset, end).join(""),
  });
}
/** The actual tool adds {resultJson}; reserve that envelope's bytes too, without truncating records. */
export function boundedProjectToolsResponse<T>(value: T): T {
  const json = extensionCanonicalJson(value);
  if (
    Buffer.byteLength(extensionCanonicalJson({ resultJson: json }), "utf8") >
    MAX_PROJECT_TOOLS_RESPONSE_BYTES
  )
    throw new Error("plugin_project_tools_response_budget_exceeded");
  return value;
}
