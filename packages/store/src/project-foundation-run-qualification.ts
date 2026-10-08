import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  captureProjectFoundationRunCommitTransaction,
  projectFoundationRunMutationCommand,
  type ProjectFoundationCommitAuthority,
  type ProjectFoundationRunCommitTransactionAuthority,
} from "@crewon/application";
import {
  assertProjectFoundationRunFoundation,
  extensionCanonicalJson,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
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
  loadSqliteFoundationRun,
  loadPostgresFoundationRun,
} from "./project-foundation-run-store.ts";
import {
  captureSqliteFoundationRunFacts,
  capturePostgresFoundationRunFacts,
} from "./project-foundation-run-facts.ts";
import {
  foundationFailure,
  type FoundationIdentity,
  type FoundationPrepared,
} from "./project-foundation-store-support.ts";

export function qualifyFoundationRunMutation(
  authority: ProjectFoundationCommitAuthority | undefined,
  identity: FoundationIdentity,
  prepared?: FoundationPrepared,
): ProjectFoundationRunCommitTransactionAuthority | undefined {
  if (authority?.runTransaction === undefined) return undefined;
  const q = captureProjectFoundationRunCommitTransaction(
    authority.runTransaction,
  );
  const command = projectFoundationRunMutationCommand(q, creativeStoreDigester);
  const digest = creativeStoreDigester.sha256(
    extensionCanonicalJson({
      schemaVersion: "crewon.project-foundation-command.v1",
      actor: q.actor,
      kind: "save-proposal",
      command,
    }),
  );
  if (
    authority.transaction !== undefined ||
    identity.kind !== "save-proposal" ||
    extensionCanonicalJson(identity.actor) !==
      extensionCanonicalJson(q.actor) ||
    identity.receipt.idempotencyKey !== command.idempotencyKey ||
    identity.receipt.requestDigest !== digest
  )
    fail();
  if (
    prepared !== undefined &&
    (prepared.kind !== "save-proposal" ||
      prepared.foundation.projectId !== command.projectId ||
      prepared.expectedFoundationRevision !==
        command.expectedFoundationRevision ||
      prepared.proposal.revision !== command.expectedProposalRevision + 1 ||
      prepared.proposal.kind !== command.kind ||
      prepared.proposal.text !== command.text)
  )
    fail();
  return q;
}
function fail(): never {
  return foundationFailure(
    "project_foundation_run_commit_qualification_denied",
  );
}
/** Internal Store result only: replay publishes a durable fact and performs no new write. */
export function isFoundationReplay(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    Object.getOwnPropertyDescriptor(result, "disposition")?.value === "replayed"
  );
}
function same(actual: unknown, expected: unknown): void {
  if (extensionCanonicalJson(actual) !== extensionCanonicalJson(expected))
    fail();
}
export function assertSqliteFoundationRunCommit(
  db: DatabaseSync,
  q: ProjectFoundationRunCommitTransactionAuthority | undefined,
  mode: "fresh-proposal" | "receipt-publication" = "fresh-proposal",
): void {
  if (q === undefined) return;
  assertSqliteInstalledProjectRunExecution(db, q);
  same(
    loadSqliteStageIfAvailable(db, {
      tenantId: q.actor.tenantId,
      runId: q.run.runId,
    }),
    q.projectStageAdmission,
  );
  same(
    loadSqliteFoundationRun(db, {
      tenantId: q.actor.tenantId,
      spaceId: q.actor.spaceId,
      runId: q.run.runId,
    }),
    q.foundationAdmission,
  );
  const facts = captureSqliteFoundationRunFacts(db, q.projectStageAdmission);
  if (facts === null) fail();
  if (mode === "fresh-proposal")
    assertProjectFoundationRunFoundation(
      q.foundationAdmission,
      facts.foundation,
      creativeStoreDigester,
    );
  assertSqliteProjectRunLease(db, q);
}
export async function assertPostgresFoundationRunCommit(
  c: PoolClient,
  schema: string,
  q: ProjectFoundationRunCommitTransactionAuthority | undefined,
  mode: "fresh-proposal" | "receipt-publication" = "fresh-proposal",
): Promise<void> {
  if (q === undefined) return;
  // Follow original Run/WorkItem/installation locks, then original project CAS namespace.
  await assertPostgresInstalledProjectRunExecution(c, schema, q);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-project",
      schema,
      q.actor.tenantId,
      q.actor.spaceId,
      q.foundationAdmission.projectId,
    ]),
  ]);
  same(
    await loadPostgresStageIfAvailable(c, schema, {
      tenantId: q.actor.tenantId,
      runId: q.run.runId,
    }),
    q.projectStageAdmission,
  );
  same(
    await loadPostgresFoundationRun(c, schema, {
      tenantId: q.actor.tenantId,
      spaceId: q.actor.spaceId,
      runId: q.run.runId,
    }),
    q.foundationAdmission,
  );
  const facts = await capturePostgresFoundationRunFacts(
    c,
    schema,
    q.projectStageAdmission,
  );
  if (facts === null) fail();
  if (mode === "fresh-proposal")
    assertProjectFoundationRunFoundation(
      q.foundationAdmission,
      facts.foundation,
      creativeStoreDigester,
    );
  // Physical database time is read after all awaited proof reads, immediately before return.
  await assertPostgresProjectRunLease(c, schema, q);
}
