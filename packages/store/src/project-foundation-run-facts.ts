import {
  captureSqliteCreativeProjectLegacyAccess,
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
} from "./creative-project-legacy-access.ts";
import { foundationLegacyScope } from "./project-foundation-legacy-scope.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  assertProjectProposalFoundation,
  extensionCanonicalJson,
  type ProjectStageRunAdmission,
  type ProjectConversationBinding,
  type ProjectFoundation,
  type ProjectProposal,
  type ProjectSource,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  decodeCreativeProject,
  creativeStoreDigester,
} from "./creative-project-store-records.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";
import {
  decodePostgresFoundation,
  decodePostgresFoundationSource,
  decodePostgresFoundationProposal,
} from "./project-foundation-postgres-records.ts";
import {
  assertPostgresProjectFoundationSchema,
  assertSqliteProjectFoundationSchema,
} from "./project-foundation-schema.ts";
import { foundationFailure } from "./project-foundation-store-support.ts";

type Row = Record<string, unknown>;
export type FoundationRunFacts = Readonly<{
  binding: ProjectConversationBinding;
  foundation: ProjectFoundation;
  source: ProjectSource | null;
  confirmedProposal: ProjectProposal | null;
  latestProposal: ProjectProposal | null;
}>;
type Query = Readonly<{ sql: string; values: readonly (string | number)[] }>;
/** Sequential queries intentionally use the original committing connection and project lock. */
function* facts(
  p: string,
  stage: ProjectStageRunAdmission,
  latest: boolean,
  predicate: (alias: string) => string,
): Generator<Query, FoundationRunFacts | null, Row | undefined> {
  const owner = {
    tenantId: stage.actor.tenantId,
    spaceId: stage.actor.spaceId,
    principalId: stage.actor.principalId,
  };
  const scope = { owner, projectId: stage.projectId };
  const values = [
    owner.tenantId,
    owner.spaceId,
    stage.projectId,
    owner.principalId,
  ];
  const projectRow = yield {
    sql: `SELECT p.* FROM ${p}creative_projects p WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.project_id=$3 AND p.owner_principal_id=$4 AND ${predicate("p")}`,
    values,
  };
  const project = decodeCreativeProject(projectRow, owner, stage.projectId);
  if (project === null || project.state !== "active") fail();
  const bindingRow = yield {
    sql: `SELECT * FROM ${p}project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3`,
    values: [owner.tenantId, owner.spaceId, stage.bindingId],
  };
  const binding = decodeConversation(bindingRow);
  if (
    binding === null ||
    binding.state !== "active" ||
    binding.revision !== stage.bindingRevision ||
    binding.projectId !== stage.projectId ||
    binding.threadId !== stage.threadId ||
    binding.workspaceId !== stage.workspaceId ||
    extensionCanonicalJson(binding.owner) !==
      extensionCanonicalJson(stage.actor) ||
    extensionCanonicalJson(binding.currentInstallation) !==
      extensionCanonicalJson(stage.installation)
  )
    fail();
  const child = (
    table: string,
    revisionColumn?: string,
    revision?: number,
  ): Query => ({
    sql: `SELECT c.*,p.owner_principal_id FROM ${p}${table} c JOIN ${p}creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id WHERE c.tenant_id=$1 AND c.space_id=$2 AND c.project_id=$3 AND p.owner_principal_id=$4 AND ${predicate("p")}${revisionColumn ? ` AND c.${revisionColumn}=$5` : ""}`,
    values: revision === undefined ? values : [...values, revision],
  });
  const foundationRow = yield child("project_foundations");
  if (foundationRow === undefined) return null;
  const foundation = decodePostgresFoundation(foundationRow, scope);
  let source: ProjectSource | null = null,
    confirmedProposal: ProjectProposal | null = null,
    latestProposal: ProjectProposal | null = null;
  if (foundation.source !== null) {
    const row = yield child(
      "project_sources",
      "source_revision",
      foundation.source.revision,
    );
    if (row === undefined) fail();
    source = decodePostgresFoundationSource(
      row,
      scope,
      foundation.source.revision,
    );
    if (source.digest !== foundation.source.digest) fail();
  }
  if (foundation.confirmedProposal !== null) {
    const row = yield child(
      "project_proposals",
      "proposal_revision",
      foundation.confirmedProposal.revision,
    );
    if (row === undefined) fail();
    confirmedProposal = decodePostgresFoundationProposal(
      row,
      scope,
      foundation.confirmedProposal.revision,
    );
    if (confirmedProposal.contentDigest !== foundation.confirmedProposal.digest)
      fail();
    assertProjectProposalFoundation(foundation, confirmedProposal, {
      confirmed: true,
    });
  }
  if (latest) {
    const q = child("project_proposals");
    const row = yield {
      ...q,
      sql: `${q.sql} ORDER BY c.proposal_revision DESC LIMIT 1`,
    };
    if (row !== undefined)
      latestProposal = decodePostgresFoundationProposal(row, scope);
  }
  return Object.freeze({
    binding,
    foundation,
    source,
    confirmedProposal,
    latestProposal,
  });
}
function fail(): never {
  return foundationFailure("project_foundation_run_facts_invalid");
}
export function captureSqliteFoundationRunFacts(
  db: DatabaseSync,
  stage: ProjectStageRunAdmission,
  latest = false,
): FoundationRunFacts | null {
  const access = captureSqliteCreativeProjectLegacyAccess(db);
  access.assertProject(foundationLegacyScope(stage.actor, stage.projectId));
  if (!assertSqliteProjectFoundationSchema(db)) return null;
  const iterator = facts("", stage, latest, access.predicate);
  let step = iterator.next();
  while (!step.done) {
    const q = step.value;
    step = iterator.next(
      db.prepare(q.sql.replaceAll(/\$[1-5]/gu, "?")).get(...q.values),
    );
  }
  return step.value;
}
export async function capturePostgresFoundationRunFacts(
  c: PoolClient,
  schema: string,
  stage: ProjectStageRunAdmission,
  latest = false,
): Promise<FoundationRunFacts | null> {
  await lockPostgresCreativeProjectLegacySchema(c, schema);
  const access = await capturePostgresCreativeProjectLegacyAccess(c, schema);
  await access.assertProject(
    foundationLegacyScope(stage.actor, stage.projectId),
  );
  if (!(await assertPostgresProjectFoundationSchema(c, schema))) {
    await access.assertProject(
      foundationLegacyScope(stage.actor, stage.projectId),
    );
    return null;
  }
  const iterator = facts(
    `${creativeProjectSchemaName(schema)}.`,
    stage,
    latest,
    access.predicate,
  );
  let step = iterator.next();
  while (!step.done) {
    const q = step.value;
    step = iterator.next((await c.query(q.sql, [...q.values])).rows[0]);
  }
  await access.assertProject(
    foundationLegacyScope(stage.actor, stage.projectId),
  );
  return step.value;
}
export function assertFoundationRunFactsUnchanged(
  expected: FoundationRunFacts,
  actual: FoundationRunFacts | null,
): void {
  if (extensionCanonicalJson(actual) !== extensionCanonicalJson(expected))
    fail();
}
