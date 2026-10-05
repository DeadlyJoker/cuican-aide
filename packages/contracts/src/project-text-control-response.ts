import { creativeControlCompareIds } from "./creative-project-control-support.ts";
import {
  parseProjectTextOutlineContent,
  parseProjectTextScriptContent,
} from "./project-text-control-contract.ts";
import {
  projectTextControlArray as array,
  projectTextControlCopy as copy,
  projectTextControlDigest as digest,
  projectTextControlFailure as fail,
  projectTextControlId as id,
  projectTextControlNumber as number,
  projectTextControlRecord as record,
  projectTextControlTimestamp as timestamp,
} from "./project-text-control-support.ts";
import type {
  GetProjectTextArtifactResponse,
  GetProjectTextRevisionResponse,
  ProjectTextArtifactListQuery,
  ProjectTextArtifactListResponse,
  ProjectTextMutationExpectation,
  ProjectTextMutationResponse,
  ProjectTextRevisionListQuery,
  ProjectTextRevisionListResponse,
  PublicProjectTextArtifact,
  PublicProjectTextArtifactView,
  PublicProjectTextRevision,
} from "./project-text-control-types.ts";
type ArtifactExpectation = Readonly<{
  projectId: string;
  artifactId?: string;
  kind?: "outline" | "script";
  episodeId?: string | null;
}>;
export function parsePublicProjectTextArtifact(
  input: unknown,
): PublicProjectTextArtifact {
  const value = record(copy(input), [
    "projectId",
    "artifactId",
    "kind",
    "episodeId",
    "revision",
    "latestContentRevision",
    "selectedContentRevision",
    "locked",
    "createdAt",
    "updatedAt",
  ]);
  if (
    (value.kind !== "outline" && value.kind !== "script") ||
    typeof value.locked !== "boolean" ||
    (value.kind === "outline" && value.episodeId !== null)
  )
    fail();
  const revision = number(value.revision),
    latest = number(value.latestContentRevision),
    selected =
      value.selectedContentRevision === null
        ? null
        : number(value.selectedContentRevision),
    createdAt = timestamp(value.createdAt),
    updatedAt = timestamp(value.updatedAt);
  if (
    latest > revision ||
    (selected !== null && selected > latest) ||
    (value.locked && selected === null) ||
    updatedAt < createdAt
  )
    fail();
  const common = {
    projectId: id(value.projectId),
    artifactId: id(value.artifactId),
    revision,
    latestContentRevision: latest,
    selectedContentRevision: selected,
    locked: value.locked,
    createdAt,
    updatedAt,
  };
  return value.kind === "outline"
    ? Object.freeze({ ...common, kind: "outline", episodeId: null })
    : Object.freeze({
        ...common,
        kind: "script",
        episodeId: id(value.episodeId),
      });
}
export function parsePublicProjectTextRevision(
  input: unknown,
): PublicProjectTextRevision {
  const value = record(copy(input), [
      "projectId",
      "artifactId",
      "kind",
      "episodeId",
      "contentRevision",
      "brief",
      "outline",
      "content",
      "contentDigest",
      "createdAt",
    ]),
    brief = record(value.brief, ["briefRevision", "contentDigest"]);
  const common = {
    projectId: id(value.projectId),
    artifactId: id(value.artifactId),
    contentRevision: number(value.contentRevision),
    brief: Object.freeze({
      briefRevision: number(brief.briefRevision),
      contentDigest: digest(brief.contentDigest),
    }),
    contentDigest: digest(value.contentDigest),
    createdAt: timestamp(value.createdAt),
  };
  if (value.kind === "outline") {
    if (value.episodeId !== null || value.outline !== null) fail();
    return Object.freeze({
      ...common,
      kind: "outline",
      episodeId: null,
      outline: null,
      content: parseProjectTextOutlineContent(value.content),
    });
  }
  if (value.kind !== "script") fail();
  const outline =
    value.outline === null
      ? null
      : record(value.outline, [
          "artifactId",
          "contentRevision",
          "contentDigest",
        ]);
  return Object.freeze({
    ...common,
    kind: "script",
    episodeId: id(value.episodeId),
    outline:
      outline === null
        ? null
        : Object.freeze({
            artifactId: id(outline.artifactId),
            contentRevision: number(outline.contentRevision),
            contentDigest: digest(outline.contentDigest),
          }),
    content: parseProjectTextScriptContent(value.content),
  });
}
function assertArtifact(
  value: PublicProjectTextArtifact,
  expected: ArtifactExpectation,
): void {
  if (
    value.projectId !== expected.projectId ||
    (expected.artifactId !== undefined &&
      value.artifactId !== expected.artifactId) ||
    (expected.kind !== undefined && value.kind !== expected.kind) ||
    (expected.episodeId !== undefined && value.episodeId !== expected.episodeId)
  )
    fail();
}
function assertRevision(
  value: PublicProjectTextRevision,
  artifact: PublicProjectTextArtifact,
): void {
  if (
    value.projectId !== artifact.projectId ||
    value.artifactId !== artifact.artifactId ||
    value.kind !== artifact.kind ||
    value.episodeId !== artifact.episodeId ||
    value.contentRevision > artifact.latestContentRevision
  )
    fail();
}
export function parsePublicProjectTextArtifactView(
  input: unknown,
): PublicProjectTextArtifactView {
  const value = record(copy(input), [
      "artifact",
      "selectedRevision",
      "dependencyState",
      "staleReasons",
    ]),
    artifact = parsePublicProjectTextArtifact(value.artifact),
    selected =
      value.selectedRevision === null
        ? null
        : parsePublicProjectTextRevision(value.selectedRevision);
  const reasons = array(value.staleReasons, 0, 2).map((reason) => {
    if (reason !== "brief-changed" && reason !== "outline-selection-changed")
      fail();
    return reason;
  });
  if (new Set(reasons).size !== reasons.length) fail();
  if (selected === null) {
    if (
      artifact.selectedContentRevision !== null ||
      value.dependencyState !== "unselected" ||
      reasons.length !== 0
    )
      fail();
  } else {
    assertRevision(selected, artifact);
    if (
      artifact.selectedContentRevision !== selected.contentRevision ||
      !["current", "stale"].includes(String(value.dependencyState)) ||
      (value.dependencyState === "current"
        ? reasons.length !== 0
        : reasons.length === 0) ||
      (artifact.kind === "outline" &&
        reasons.includes("outline-selection-changed"))
    )
      fail();
  }
  return Object.freeze({
    artifact,
    selectedRevision: selected,
    dependencyState:
      value.dependencyState as PublicProjectTextArtifactView["dependencyState"],
    staleReasons: Object.freeze(reasons),
  });
}
export function parseGetProjectTextArtifactResponse(
  input: unknown,
  expected: ArtifactExpectation,
): GetProjectTextArtifactResponse {
  const value = record(copy(input), ["view"]),
    view =
      value.view === null
        ? null
        : parsePublicProjectTextArtifactView(value.view);
  if (view !== null) assertArtifact(view.artifact, expected);
  return Object.freeze({ view });
}
export function parseGetProjectTextRevisionResponse(
  input: unknown,
  expected: Readonly<{
    projectId: string;
    artifactId: string;
    contentRevision: number;
  }>,
): GetProjectTextRevisionResponse {
  const value = record(copy(input), ["contentRevision"]),
    contentRevision = parsePublicProjectTextRevision(value.contentRevision);
  if (
    contentRevision.projectId !== expected.projectId ||
    contentRevision.artifactId !== expected.artifactId ||
    contentRevision.contentRevision !== expected.contentRevision
  )
    fail();
  return Object.freeze({ contentRevision });
}
export function parseProjectTextArtifactListResponse(
  input: unknown,
  expected: ProjectTextArtifactListQuery & Readonly<{ projectId: string }>,
): ProjectTextArtifactListResponse {
  const value = record(copy(input), ["artifacts", "nextArtifactId"]),
    artifacts = array(value.artifacts, 0, expected.limit).map(
      parsePublicProjectTextArtifact,
    );
  let previous = expected.afterArtifactId;
  for (const artifact of artifacts) {
    assertArtifact(artifact, expected);
    if (
      previous !== null &&
      creativeControlCompareIds(previous, artifact.artifactId) >= 0
    )
      fail();
    previous = artifact.artifactId;
  }
  const next = value.nextArtifactId === null ? null : id(value.nextArtifactId);
  if (
    next !== null &&
    (artifacts.length === 0 ||
      next !== artifacts[artifacts.length - 1]!.artifactId)
  )
    fail();
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    nextArtifactId: next,
  });
}
export function parseProjectTextRevisionListResponse(
  input: unknown,
  expected: ProjectTextRevisionListQuery &
    Readonly<{ projectId: string; artifactId: string }>,
): ProjectTextRevisionListResponse {
  const value = record(copy(input), ["revisions", "nextContentRevision"]),
    revisions = array(value.revisions, 0, expected.limit).map(
      parsePublicProjectTextRevision,
    );
  let previous = expected.afterContentRevision;
  for (const entry of revisions) {
    if (
      entry.projectId !== expected.projectId ||
      entry.artifactId !== expected.artifactId ||
      entry.contentRevision <= previous
    )
      fail();
    previous = entry.contentRevision;
  }
  const next =
    value.nextContentRevision === null
      ? null
      : number(value.nextContentRevision);
  if (next !== null && (revisions.length === 0 || next !== previous)) fail();
  return Object.freeze({
    revisions: Object.freeze(revisions),
    nextContentRevision: next,
  });
}
export function parseProjectTextMutationResponse(
  input: unknown,
  expected: ProjectTextMutationExpectation,
): ProjectTextMutationResponse {
  const value = record(copy(input), [
    "kind",
    "disposition",
    "artifact",
    "contentRevision",
  ]);
  if (
    value.kind !== expected.kind ||
    (value.disposition !== "committed" && value.disposition !== "replayed")
  )
    fail();
  const artifact = parsePublicProjectTextArtifact(value.artifact),
    content =
      value.contentRevision === null
        ? null
        : parsePublicProjectTextRevision(value.contentRevision);
  assertArtifact(artifact, {
    projectId: expected.projectId,
    ...(expected.kind === "select-revision" || expected.kind === "set-lock"
      ? { artifactId: expected.artifactId }
      : {}),
  });
  if (artifact.revision !== expected.request.expectedArtifactRevision + 1)
    fail();
  if (expected.kind === "set-lock") {
    if (content !== null || artifact.locked !== expected.request.locked) fail();
  } else {
    if (content === null) fail();
    assertRevision(content, artifact);
    if (expected.kind === "select-revision") {
      if (
        artifact.selectedContentRevision !== expected.request.contentRevision ||
        content.contentRevision !== expected.request.contentRevision
      )
        fail();
    } else {
      if (
        artifact.kind !==
          (expected.kind === "save-outline" ? "outline" : "script") ||
        (expected.kind === "save-script" &&
          artifact.episodeId !== expected.episodeId) ||
        content.contentRevision !== artifact.latestContentRevision ||
        content.brief.briefRevision !== expected.request.briefRevision ||
        JSON.stringify(content.content) !==
          JSON.stringify(expected.request.content)
      )
        fail();
      if (
        expected.kind === "save-script" &&
        (content.kind !== "script" ||
          (expected.request.outline === null
            ? content.outline !== null
            : content.outline === null ||
              content.outline.artifactId !==
                expected.request.outline.artifactId ||
              content.outline.contentRevision !==
                expected.request.outline.contentRevision))
      )
        fail();
    }
  }
  return Object.freeze({
    kind: expected.kind,
    disposition: value.disposition,
    artifact,
    contentRevision: content,
  });
}
