import { creativeOwnerValues } from "./creative-project-store-records.ts";
import {
  decodeTextArtifact,
  textRequired,
  type TextInput,
} from "./project-text-store-support.ts";
import { legacyTextRevision as decodeTextRevision } from "./project-structured-outline-store-support.ts";
const textFilter =
  "p.tenant_id=? AND p.space_id=? AND p.owner_principal_id=? AND p.project_id=?";
const textChildJoin =
  "JOIN creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id";
type TextLegacyQuery = (
  sql: string,
  values: unknown[],
) => Promise<Readonly<{ rows: Record<string, unknown>[] }>>;
/** Original pagination SQL runs only after the original transaction's negative project guard. */
export async function listPostgresTextArtifacts(
  q: TextInput<"listArtifacts">,
  query: TextLegacyQuery,
) {
  const rows = await query(
    `SELECT c.* FROM project_text_artifacts c ${textChildJoin} WHERE ${textFilter}${q.afterArtifactId === null ? "" : ' AND c.artifact_id COLLATE "C" > ? COLLATE "C"'} ORDER BY c.artifact_id COLLATE "C" ASC LIMIT ?`,
    [
      ...creativeOwnerValues(q.owner),
      q.projectId,
      ...(q.afterArtifactId === null ? [] : [q.afterArtifactId]),
      q.limit + 1,
    ],
  );
  const items = rows.rows.map((row) =>
    textRequired(decodeTextArtifact(row, q.owner, q.projectId)),
  );
  const artifacts = Object.freeze(items.slice(0, q.limit));
  return Object.freeze({
    artifacts,
    nextArtifactId:
      items.length > q.limit ? artifacts.at(-1)!.artifactId : null,
  });
}
export async function listPostgresTextRevisions(
  q: TextInput<"listRevisions">,
  query: TextLegacyQuery,
) {
  const rows = await query(
    `SELECT c.*,p.owner_principal_id FROM project_text_revisions c ${textChildJoin} WHERE ${textFilter} AND c.artifact_id=? AND c.content_revision>? ORDER BY c.content_revision ASC LIMIT ?`,
    [
      ...creativeOwnerValues(q.owner),
      q.projectId,
      q.artifactId,
      q.afterContentRevision,
      q.limit + 1,
    ],
  );
  const items = rows.rows.map((row) =>
    textRequired(decodeTextRevision(row, q.owner, q.projectId, q.artifactId)),
  );
  const revisions = Object.freeze(items.slice(0, q.limit));
  return Object.freeze({
    revisions,
    nextContentRevision:
      items.length > q.limit ? revisions.at(-1)!.contentRevision : null,
  });
}
