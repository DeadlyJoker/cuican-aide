import {
  parseStoredProjectTextArtifactRevision,
  type ProjectStructuredOutlineRevision,
} from "./project-structured-outline-revision.ts";
import { projectTextFailure } from "./project-text-content.ts";
import type {
  ProjectOutlineRevision,
  ProjectTextDigester,
} from "./project-text-types.ts";

/** A downstream source keeps the original immutable revision and digest, never a v1 projection. */
export type ProjectOutlineSourceRevision =
  | ProjectOutlineRevision
  | ProjectStructuredOutlineRevision;

export function parseProjectOutlineSourceRevision(
  input: unknown,
  digester: ProjectTextDigester,
): ProjectOutlineSourceRevision {
  const revision = parseStoredProjectTextArtifactRevision(input, digester);
  if (revision.kind !== "outline")
    projectTextFailure("project_text_outline_reference_invalid");
  return revision;
}
