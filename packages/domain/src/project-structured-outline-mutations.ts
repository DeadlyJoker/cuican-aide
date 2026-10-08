import {
  parseProjectBriefRevision,
  type ProjectBriefRevision,
} from "./creative-project-revisions.ts";
import {
  assertCreativeProjectScope,
  creativeProjectNextRevision,
} from "./creative-project-validation.ts";
import { parseProjectTextArtifact } from "./project-text-artifact.ts";
import { projectTextFailure } from "./project-text-content.ts";
import {
  prepareProjectTextCandidateIdentity,
  prepareProjectTextMutationHead,
  assertProjectTextRevisionIdentity,
  type ProjectTextMutationHeadInput,
} from "./project-text-mutations.ts";
import { parseProjectOutlineDocument } from "./project-outline-document.ts";
import { evaluateProjectOutlineQuality } from "./project-outline-quality.ts";
import {
  PROJECT_STRUCTURED_OUTLINE_REVISION_SCHEMA,
  parseProjectOutlineInputBinding,
  parseProjectStructuredOutlineRevision,
  structuredProjectTextCanonicalJson,
  type ProjectOutlineInputBinding,
  type ProjectStructuredOutlineRevision,
} from "./project-structured-outline-revision.ts";
import type { ProjectOutlineDocument } from "./project-outline-document-types.ts";
import type {
  ProjectTextArtifact,
  ProjectTextDigester,
} from "./project-text-types.ts";

export type ProjectStructuredOutlineMutation = Readonly<{
  artifact: ProjectTextArtifact;
  contentRevision: ProjectStructuredOutlineRevision;
}>;
export function saveProjectStructuredOutlineCandidate(
  input: ProjectTextMutationHeadInput &
    Readonly<{
      artifactId: string;
      brief: ProjectBriefRevision;
      inputs: ProjectOutlineInputBinding;
      content: ProjectOutlineDocument;
    }>,
  digester: ProjectTextDigester,
): ProjectStructuredOutlineMutation {
  const checked = prepareProjectTextCandidateIdentity(
    input,
    "outline",
    null,
    digester,
  );
  const body = {
    ...checked.common,
    schemaVersion: PROJECT_STRUCTURED_OUTLINE_REVISION_SCHEMA,
    kind: "outline" as const,
    episodeId: null,
    outline: null,
    inputs: parseProjectOutlineInputBinding(input.inputs),
    content: parseProjectOutlineDocument(input.content),
  };
  return Object.freeze({
    artifact: checked.artifact,
    contentRevision: parseProjectStructuredOutlineRevision(
      {
        ...body,
        contentDigest: digester.sha256(
          structuredProjectTextCanonicalJson(body),
        ),
      },
      digester,
    ),
  });
}
/** Full Skill gates run again at adoption. Actual source evidence is checked by the committing store. */
export function selectProjectStructuredOutlineRevision(
  input: ProjectTextMutationHeadInput &
    Readonly<{
      artifact: ProjectTextArtifact;
      contentRevision: ProjectStructuredOutlineRevision;
      latestBrief: ProjectBriefRevision;
    }>,
  digester: ProjectTextDigester,
): ProjectStructuredOutlineMutation {
  const checked = prepareProjectTextMutationHead(input);
  const artifact = checked.artifact;
  if (artifact === null || artifact.kind !== "outline")
    projectTextFailure("project_text_artifact_not_found");
  const revision = parseProjectStructuredOutlineRevision(
    input.contentRevision,
    digester,
  );
  assertProjectTextRevisionIdentity(artifact, revision);
  const latestBrief = parseProjectBriefRevision(input.latestBrief, digester);
  assertCreativeProjectScope(checked.project, latestBrief);
  if (
    latestBrief.briefRevision !== checked.project.latestBriefRevision ||
    revision.brief.briefRevision !== latestBrief.briefRevision ||
    revision.brief.contentDigest !== latestBrief.contentDigest
  )
    projectTextFailure("project_text_dependencies_stale");
  if (
    artifact.locked &&
    artifact.selectedContentRevision !== revision.contentRevision
  )
    projectTextFailure("project_text_locked");
  if (!evaluateProjectOutlineQuality(revision.content, "full").passed)
    projectTextFailure("project_outline_quality_failed");
  return Object.freeze({
    artifact: parseProjectTextArtifact({
      ...artifact,
      revision: creativeProjectNextRevision(artifact.revision),
      selectedContentRevision: revision.contentRevision,
      updatedByActorId: checked.actor.actorId,
      updatedAt: checked.at,
    }),
    contentRevision: revision,
  });
}
