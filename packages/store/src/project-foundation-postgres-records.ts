import type { CreativeProjectOwnerScope } from "@crewon/application";
import {
  assertProjectSourceChapterIdentity,
  parseProjectSource,
  parseProjectSourceChapter,
  parseProjectSourceChunk,
  projectSourceScalarLength,
  validateProjectFoundation,
  type ProjectSource,
} from "@crewon/domain";
import {
  decodeFoundationReceipt,
  foundationDigest,
  foundationFailure,
  foundationProposal,
  type FoundationIdentity,
} from "./project-foundation-store-support.ts";

type Row = Record<string, unknown>;
type ReadScope = Readonly<{
  owner: CreativeProjectOwnerScope;
  projectId: string;
}>;

/** Decode bounded records and require each actual relational index to match its body. */
export function decodePostgresFoundation(row: Row, scope: ReadScope) {
  const foundation = validateProjectFoundation(json(row.record_json));
  assertRowScope(row, foundation, scope);
  same(foundation.ownerPrincipalId, scope.owner.principalId);
  same(row.origin, foundation.origin);
  same(indexedNumber(row.revision, 1), foundation.revision);
  same(
    indexedNumber(row.parameters_revision, 1),
    foundation.parametersRevision,
  );
  return foundation;
}

export function decodePostgresFoundationSource(
  row: Row,
  scope: ReadScope,
  revision?: number,
) {
  const source = parseProjectSource(json(row.record_json));
  assertRowScope(row, source, scope);
  same(indexedNumber(row.source_revision, 1), source.revision);
  same(row.content_digest, source.digest);
  same(row.file_digest, source.fileDigest);
  same(indexedNumber(row.character_length, 1), source.characterLength);
  if (revision !== undefined) same(source.revision, revision);
  return source;
}

export function decodePostgresFoundationProposal(
  row: Row,
  scope: ReadScope,
  revision?: number,
) {
  const proposal = foundationProposal(json(row.record_json));
  assertRowScope(row, proposal, scope);
  same(proposal.ownerPrincipalId, scope.owner.principalId);
  same(indexedNumber(row.proposal_revision, 1), proposal.revision);
  same(row.content_digest, proposal.contentDigest);
  if (revision !== undefined) same(proposal.revision, revision);
  return proposal;
}

export function decodePostgresFoundationSourceChunk(
  row: Row,
  scope: ReadScope,
) {
  const chunk = parseProjectSourceChunk({
    tenantId: row.tenant_id,
    spaceId: row.space_id,
    projectId: row.project_id,
    sourceRevision: indexedNumber(row.source_revision, 1),
    index: indexedNumber(row.chunk_index),
    startOffset: indexedNumber(row.start_offset),
    content: row.content,
    digest: row.content_digest,
  });
  assertRowScope(row, chunk, scope);
  same(
    indexedNumber(row.character_length, 1),
    projectSourceScalarLength(chunk.content),
  );
  if (chunk.digest !== foundationDigest(chunk.content))
    foundationFailure("project_foundation_source_chunk_mismatch");
  return chunk;
}

export function decodePostgresFoundationSourceChapter(
  row: Row,
  scope: ReadScope,
  source: ProjectSource,
) {
  const chapter = parseProjectSourceChapter(json(row.record_json));
  assertRowScope(row, chapter, scope);
  same(indexedNumber(row.source_revision, 1), chapter.sourceRevision);
  same(row.chapter_id, chapter.chapterId);
  same(indexedNumber(row.start_offset), chapter.startOffset);
  same(indexedNumber(row.end_offset, 1), chapter.endOffset);
  assertProjectSourceChapterIdentity(source, chapter);
  return chapter;
}

export function decodePostgresFoundationMutationReceipt(
  row: Row | undefined,
  identity: FoundationIdentity,
) {
  if (row === undefined) return null;
  for (const [column, expected] of Object.entries({
    tenant_id: identity.actor.tenantId,
    space_id: identity.actor.spaceId,
    principal_id: identity.actor.principalId,
    actor_id: identity.actor.actorId,
    kind: identity.kind,
    idempotency_key: identity.receipt.idempotencyKey,
  }))
    same(row[column], expected);
  if (row.request_digest !== identity.receipt.requestDigest)
    foundationFailure("project_foundation_idempotency_conflict");
  const result = decodeFoundationReceipt(json(row.result_json), identity);
  same(row.project_id, result.project.projectId);
  return result;
}

function assertRowScope(
  row: Row,
  record: { tenantId: string; spaceId: string; projectId: string },
  scope: ReadScope,
) {
  same(row.tenant_id, record.tenantId);
  same(row.space_id, record.spaceId);
  same(row.project_id, record.projectId);
  same(row.owner_principal_id, scope.owner.principalId);
  same(record.tenantId, scope.owner.tenantId);
  same(record.spaceId, scope.owner.spaceId);
  same(record.projectId, scope.projectId);
}
function json(input: unknown): unknown {
  return typeof input === "string" ? JSON.parse(input) : input;
}
function same(actual: unknown, expected: unknown): void {
  if (actual !== expected)
    foundationFailure("project_foundation_store_index_invalid");
}
function indexedNumber(input: unknown, minimum = 0): number {
  const value =
    typeof input === "string" && /^(?:0|[1-9][0-9]*)$/u.test(input)
      ? Number(input)
      : input;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    foundationFailure("project_foundation_store_index_invalid");
  return value;
}
