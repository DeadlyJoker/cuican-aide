import {
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  type CreativeProject,
  type ProjectTextUiIntent,
  type ProjectTextUiIntentRefusalCode,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import type { TextRow } from "./project-text-store-support.ts";

/** Recheck the claimed deterministic conflict using actual rows while holding the original project lock. */
export function actualTextIntentRefusal(
  intent: ProjectTextUiIntent,
  code: ProjectTextUiIntentRefusalCode,
  project: CreativeProject,
  rows: { head: TextRow; revision: TextRow; outline: TextRow },
): boolean {
  if (code === "creative_project_archived") return project.state === "archived";
  const request = intent.input.request as Record<string, unknown>;
  const head =
    rows.head == null ? null : parseProjectTextArtifact(json(rows.head));
  if (code === "project_text_revision_conflict")
    return (head?.revision ?? 0) !== request.expectedArtifactRevision;
  if (code === "project_text_locked")
    return (
      intent.actionId === "crewon.project-texts.v1.selectRevision" &&
      head?.locked === true
    );
  if (
    intent.actionId !== "crewon.project-texts.v1.selectRevision" ||
    rows.revision == null
  )
    return false;
  const revision = parseProjectTextArtifactRevision(
    json(rows.revision),
    creativeStoreDigester,
  );
  if (revision.brief.briefRevision !== project.latestBriefRevision) return true;
  if (revision.outline === null) return false;
  const outline =
    rows.outline == null ? null : parseProjectTextArtifact(json(rows.outline));
  return (
    outline?.artifactId !== revision.outline.artifactId ||
    outline.selectedContentRevision !== revision.outline.contentRevision
  );
}
function json(row: NonNullable<TextRow>): unknown {
  return typeof row.record_json === "string"
    ? JSON.parse(row.record_json)
    : row.record_json;
}
