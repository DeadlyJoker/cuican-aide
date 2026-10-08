import {
  MAX_PROJECT_OUTLINE_UI_RESPONSE_BYTES,
  type ProjectOutlineRevisionSummary,
  type ProjectOutlineSectionQuery,
  type ProjectOutlineSectionResponse,
  type ProjectOutlineView,
  type ProjectOutlineItem,
} from "@crewon/contracts/project-outlines";
import {
  evaluateProjectOutlineQuality,
  projectOutlineOverview,
  type StoredProjectTextArtifactRevision,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { textActionArtifact } from "./plugin-project-text-action-projection.ts";
import type { ProjectStructuredOutlineView } from "./project-structured-outline-application-service.ts";

export function projectOutlinePublicSummary(
  revision: StoredProjectTextArtifactRevision,
): ProjectOutlineRevisionSummary {
  if (revision.kind !== "outline")
    throw new ApplicationError("internal", "project_outline_revision_invalid");
  const content = revision.content;
  const quality =
    revision.schemaVersion === "crewon.project-text-revision.v2"
      ? evaluateProjectOutlineQuality(revision.content, "full")
      : null;
  return Object.freeze({
    projectId: revision.projectId,
    artifactId: revision.artifactId,
    contentRevision: revision.contentRevision,
    contentDigest: revision.contentDigest,
    brief: revision.brief,
    format: quality === null ? "legacy-v1" : "structured-v2",
    title: content.title,
    createdAt: revision.createdAt,
    counts: Object.freeze({
      episodes: content.episodes.length,
      characters: "characters" in content ? content.characters.length : 0,
      scenes: "scenes" in content ? content.scenes.length : 0,
      props: "props" in content ? (content.props?.length ?? 0) : 0,
      beats: "beats" in content ? content.beats.length : 0,
    }),
    quality:
      quality === null
        ? null
        : Object.freeze({
            passed: quality.passed,
            problemCount: quality.problems.length,
            failedGateCount: quality.gates.filter(
              (gate) => gate.status === "failed",
            ).length,
          }),
  });
}
export function projectOutlinePublicView(
  view: ProjectStructuredOutlineView | null,
): ProjectOutlineView | null {
  if (view === null) return null;
  const artifact = textActionArtifact(view.artifact);
  if (artifact.kind !== "outline" || artifact.episodeId !== null)
    throw new ApplicationError("internal", "project_outline_artifact_invalid");
  return Object.freeze({
    artifact: { ...artifact, kind: "outline", episodeId: null },
    latestRevision: projectOutlinePublicSummary(view.latestRevision),
    selectedRevision:
      view.selectedRevision === null
        ? null
        : projectOutlinePublicSummary(view.selectedRevision),
    staleReasons: view.staleReasons,
  });
}
/** Return whole content records with their exact revision/digest; no truncation or giant model fragment. */
export function projectOutlinePublicSection(
  revision: StoredProjectTextArtifactRevision,
  query: ProjectOutlineSectionQuery,
): ProjectOutlineSectionResponse {
  if (
    revision.projectId !== query.projectId ||
    revision.artifactId !== query.artifactId ||
    revision.contentRevision !== query.contentRevision
  )
    throw new ApplicationError(
      "notFound",
      "project_outline_revision_not_found",
    );
  if (revision.contentDigest !== query.contentDigest)
    throw new ApplicationError(
      "conflict",
      "project_outline_base_digest_mismatch",
    );
  if (revision.kind !== "outline")
    throw new ApplicationError("conflict", "project_outline_revision_invalid");
  const summary = projectOutlinePublicSummary(revision);
  let all: readonly unknown[];
  const content = revision.content;
  if (query.section === "episodes") all = content.episodes;
  else if (revision.schemaVersion === "crewon.project-text-revision.v1") {
    all =
      query.section === "overview"
        ? [
            {
              title: content.title,
              logline: content.logline,
              synopsis: content.synopsis,
            },
          ]
        : [];
  } else {
    const document = revision.content;
    switch (query.section) {
      case "overview":
        all = [projectOutlineOverview(document)];
        break;
      case "adaptation":
        all = [
          {
            core: document.adaptation.core,
            ...(document.adaptation.cutNote === undefined
              ? {}
              : { cutNote: document.adaptation.cutNote }),
            ...(document.adaptation.mergeNote === undefined
              ? {}
              : { mergeNote: document.adaptation.mergeNote }),
          },
        ];
        break;
      case "keep":
      case "cut":
      case "merge":
      case "risks":
        all = document.adaptation[query.section];
        break;
      case "characters":
      case "scenes":
      case "beats":
        all = document[query.section];
        break;
      case "props":
        all = document.props ?? [];
        break;
      case "problems":
        all = evaluateProjectOutlineQuality(document, "full").problems.map(
          (message, index) => ({ index, message }),
        );
        break;
      case "gates":
        all = evaluateProjectOutlineQuality(document, "full").gates.map(
          (gate) => ({
            ...gate,
            detail: Array.from(gate.detail).slice(0, 1200).join(""),
            hasMoreDetail: Array.from(gate.detail).length > 1200,
          }),
        );
        break;
    }
  }
  if (query.afterIndex > all.length)
    throw new ApplicationError("validation", "project_outline_cursor_invalid");
  const size = Math.min(query.limit, all.length - query.afterIndex);
  for (let length = size; length >= 0; length--) {
    const end = query.afterIndex + length;
    const response = {
      revision: summary,
      section: query.section,
      startIndex: query.afterIndex,
      totalItems: all.length,
      items: all.slice(query.afterIndex, end) as readonly ProjectOutlineItem[],
      nextIndex: end < all.length ? end : null,
    };
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength <=
      MAX_PROJECT_OUTLINE_UI_RESPONSE_BYTES
    ) {
      if (length === 0 && size !== 0) break;
      return Object.freeze(response);
    }
  }
  throw new ApplicationError("internal", "project_outline_response_limit");
}
