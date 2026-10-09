import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  captureProjectOutlineRunCommitTransaction,
  projectOutlineRunMutation,
  projectStructuredOutlineCommandReceipt,
  type ActorContext,
  type CreativeProjectCommitAuthority,
  type CreativeProjectMutationReceipt,
  type ProjectStructuredOutlineMutationKind,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  type StoredProjectTextArtifactRevision,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  assertSqliteInstalledProjectRunExecution,
  assertSqliteProjectRunLease,
} from "./creative-project-run-commit-sqlite.ts";
import {
  assertPostgresInstalledProjectRunExecution,
  assertPostgresProjectRunLease,
} from "./creative-project-run-commit-postgres.ts";
import {
  loadSqliteStageIfAvailable,
  loadPostgresStageIfAvailable,
} from "./project-stage-run-store-support.ts";
import {
  captureSqliteFoundationRunFacts,
  capturePostgresFoundationRunFacts,
} from "./project-foundation-run-facts.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { assertProjectOutlinePreparedCommand } from "./project-outline-prepared-command.ts";
import type { StructuredTextPrepared } from "./project-structured-outline-store-support.ts";

export function projectOutlineRunCommitQualification(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectStructuredOutlineMutationKind,
  receipt: CreativeProjectMutationReceipt,
) {
  if (!authority?.outlineRunTransaction) return undefined;
  const transaction = captureProjectOutlineRunCommitTransaction(
    authority.outlineRunTransaction,
  );
  const mutation = projectOutlineRunMutation(
    transaction,
    creativeStoreDigester,
  );
  const { command, expectedFoundationRevision } = mutation;
  const expected = projectStructuredOutlineCommandReceipt(
    transaction.actor,
    "save-outline",
    command,
    creativeStoreDigester,
  );
  if (
    kind !== "save-outline" ||
    extensionCanonicalJson(actor) !==
      extensionCanonicalJson(transaction.actor) ||
    receipt.idempotencyKey !== expected.idempotencyKey ||
    receipt.requestDigest !== expected.requestDigest
  )
    denied();
  return Object.freeze({ ...transaction, command, expectedFoundationRevision });
}
type Qualification = ReturnType<typeof projectOutlineRunCommitQualification>;

export function assertProjectOutlineRunPrepared(
  q: Qualification,
  prepared: StructuredTextPrepared,
  base: StoredProjectTextArtifactRevision | null,
): void {
  if (!q) return;
  if (
    prepared.kind !== "save-outline" ||
    prepared.contentRevision.brief.contentDigest !==
      q.projectStageAdmission.sources.brief?.contentDigest
  )
    denied();
  assertProjectOutlinePreparedCommand(q.command, prepared, base, denied);
}

/** Check actual original SQL facts. A scheduling lease or captured object is never sufficient. */
export function assertSqliteProjectOutlineRunCommit(
  db: DatabaseSync,
  q: Qualification,
  mode: "fresh-candidate" | "receipt-publication" = "fresh-candidate",
): void {
  if (!q) return;
  assertSqliteInstalledProjectRunExecution(db, q);
  const stage = loadSqliteStageIfAvailable(db, {
    tenantId: q.actor.tenantId,
    runId: q.run.runId,
  });
  if (
    extensionCanonicalJson(stage) !==
    extensionCanonicalJson(q.projectStageAdmission)
  )
    denied();
  // Includes current actor-owned active project, exact conversation revision and installation.
  const facts = captureSqliteFoundationRunFacts(db, q.projectStageAdmission);
  if (
    facts === null ||
    (mode === "fresh-candidate" &&
      facts.foundation.revision !== q.expectedFoundationRevision)
  )
    denied();
  assertSqliteProjectRunLease(db, q);
}

export async function assertPostgresProjectOutlineRunCommit(
  c: PoolClient,
  schema: string,
  q: Qualification,
  mode: "fresh-candidate" | "receipt-publication" = "fresh-candidate",
): Promise<void> {
  if (!q) return;
  await assertPostgresInstalledProjectRunExecution(c, schema, q);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-project",
      schema,
      q.actor.tenantId,
      q.actor.spaceId,
      q.projectStageAdmission.projectId,
    ]),
  ]);
  const stage = await loadPostgresStageIfAvailable(c, schema, {
    tenantId: q.actor.tenantId,
    runId: q.run.runId,
  });
  if (
    extensionCanonicalJson(stage) !==
    extensionCanonicalJson(q.projectStageAdmission)
  )
    denied();
  // Lock the existing binding as well as validating the Foundation reader's owner and revision.
  await c.query(
    `SELECT binding_id FROM ${creativeProjectSchemaName(schema)}.project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
    [q.actor.tenantId, q.actor.spaceId, q.projectStageAdmission.bindingId],
  );
  const facts = await capturePostgresFoundationRunFacts(
    c,
    schema,
    q.projectStageAdmission,
  );
  if (
    facts === null ||
    (mode === "fresh-candidate" &&
      facts.foundation.revision !== q.expectedFoundationRevision)
  )
    denied();
  await assertPostgresProjectRunLease(c, schema, q);
}
function denied(): never {
  throw new Error("project_outline_run_commit_qualification_denied");
}
