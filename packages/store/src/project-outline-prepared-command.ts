import type { ProjectStructuredOutlineCommand } from "@crewon/application";
import {
  changeProjectOutlineDocument,
  extensionCanonicalJson,
  type StoredProjectTextArtifactRevision,
} from "@crewon/domain";
import type { StructuredTextPrepared } from "./project-structured-outline-store-support.ts";

/** Shared content comparison only; this issues no UI or Run mutation grant. */
export function assertProjectOutlinePreparedCommand(
  command: ProjectStructuredOutlineCommand,
  prepared: StructuredTextPrepared,
  base: StoredProjectTextArtifactRevision | null,
  denied: () => never,
): void {
  if (
    prepared.project.projectId !== command.projectId ||
    prepared.expectedArtifactRevision !== command.expectedArtifactRevision
  )
    denied();
  if (prepared.kind === "select-revision") {
    if (
      !("artifactId" in command) ||
      prepared.artifact.artifactId !== command.artifactId ||
      prepared.contentRevision.contentRevision !== command.contentRevision
    )
      denied();
    return;
  }
  if (
    !("change" in command) ||
    prepared.contentRevision.brief.briefRevision !== command.briefRevision
  )
    denied();
  if (
    command.base === null
      ? base !== null
      : base === null ||
        base.schemaVersion !== "crewon.project-text-revision.v2" ||
        base.artifactId !== prepared.artifact.artifactId ||
        base.projectId !== command.projectId ||
        base.contentRevision !== command.base.contentRevision ||
        base.contentDigest !== command.base.contentDigest
  )
    denied();
  const expected = changeProjectOutlineDocument(
    base?.schemaVersion === "crewon.project-text-revision.v2"
      ? base.content
      : null,
    command.change,
  );
  if (
    extensionCanonicalJson(expected) !==
    extensionCanonicalJson(prepared.contentRevision.content)
  )
    denied();
}
