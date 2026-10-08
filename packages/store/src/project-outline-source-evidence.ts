import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  assertProjectSourceChunkIdentity,
  projectSourceScalarLength,
  projectTextFailure,
  type ProjectStructuredOutlineRevision,
  type ProjectSource,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { decodePostgresFoundationSourceChunk } from "./project-foundation-postgres-records.ts";

/** Streams verified original chunks, retaining only one small boundary window and quote flags. */
function evidenceVerifier(
  revision: ProjectStructuredOutlineRevision,
  source: ProjectSource,
  principalId: string,
) {
  const scope = {
    owner: {
      tenantId: revision.tenantId,
      spaceId: revision.spaceId,
      principalId,
    },
    projectId: revision.projectId,
  };
  const quotes = [
    revision.content.adaptation.keep,
    revision.content.adaptation.cut,
    revision.content.adaptation.merge,
  ].flatMap((items) =>
    items.flatMap((item) =>
      item.evidence === undefined ? [] : [item.evidence],
    ),
  );
  const found = quotes.map(() => false);
  const boundaryLength = Math.max(
    0,
    ...quotes.map((quote) => quote.length - 1),
  );
  const hash = createHash("sha256");
  let index = 0,
    offset = 0,
    tail = "";
  return {
    consume(row: Record<string, unknown>) {
      const chunk = decodePostgresFoundationSourceChunk(
        { ...row, owner_principal_id: principalId },
        scope,
      );
      assertProjectSourceChunkIdentity(source, chunk);
      if (chunk.index !== index || chunk.startOffset !== offset)
        projectTextFailure("project_outline_source_chunks_invalid");
      const window = tail + chunk.content;
      for (let position = 0; position < quotes.length; position++)
        if (!found[position] && window.includes(quotes[position]!))
          found[position] = true;
      tail = boundaryLength === 0 ? "" : window.slice(-boundaryLength);
      hash.update(chunk.content);
      index++;
      offset += projectSourceScalarLength(chunk.content);
    },
    finish() {
      if (
        index === 0 ||
        offset !== source.characterLength ||
        `sha256:${hash.digest("hex")}` !== source.digest ||
        source.digest !== revision.inputs.source.digest ||
        source.revision !== revision.inputs.source.revision
      )
        projectTextFailure("project_outline_source_chunks_invalid");
      if (found.some((value) => !value))
        projectTextFailure("project_outline_source_evidence_mismatch");
    },
  };
}
export function verifySqliteProjectOutlineSourceEvidence(
  database: DatabaseSync,
  revision: ProjectStructuredOutlineRevision,
  source: ProjectSource,
  principalId: string,
): void {
  const verifier = evidenceVerifier(revision, source, principalId);
  const rows = database
    .prepare(
      "SELECT * FROM project_source_chunks WHERE tenant_id=? AND space_id=? AND project_id=? AND source_revision=? ORDER BY chunk_index ASC",
    )
    .iterate(
      revision.tenantId,
      revision.spaceId,
      revision.projectId,
      source.revision,
    );
  for (const row of rows) verifier.consume(row);
  verifier.finish();
}
export async function verifyPostgresProjectOutlineSourceEvidence(
  client: PoolClient,
  schema: string,
  revision: ProjectStructuredOutlineRevision,
  source: ProjectSource,
  principalId: string,
): Promise<void> {
  const verifier = evidenceVerifier(revision, source, principalId);
  const prefix = `${creativeProjectSchemaName(schema)}.`;
  let after = -1;
  while (true) {
    const rows = (
      await client.query<Record<string, unknown>>(
        `SELECT * FROM ${prefix}project_source_chunks WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND source_revision=$4 AND chunk_index>$5 ORDER BY chunk_index ASC LIMIT 32`,
        [
          revision.tenantId,
          revision.spaceId,
          revision.projectId,
          source.revision,
          after,
        ],
      )
    ).rows;
    for (const row of rows) verifier.consume(row);
    if (rows.length < 32) break;
    const last = Number(rows.at(-1)!.chunk_index);
    if (!Number.isSafeInteger(last) || last <= after)
      projectTextFailure("project_outline_source_chunks_invalid");
    after = last;
  }
  verifier.finish();
}
