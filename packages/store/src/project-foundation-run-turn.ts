import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { CommitExtensionTurnInput } from "@crewon/application";
import {
  createProjectFoundationRunAdmission,
  extensionCanonicalJson,
  type ProjectFoundationRunAdmission,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  assertPostgresProjectFoundationRunSchema,
  assertSqliteProjectFoundationRunSchema,
} from "./project-foundation-run-schema.ts";
import {
  capturePostgresFoundationRunFacts,
  captureSqliteFoundationRunFacts,
  assertFoundationRunFactsUnchanged,
  type FoundationRunFacts,
} from "./project-foundation-run-facts.ts";
import {
  loadPostgresFoundationRun,
  loadSqliteFoundationRun,
} from "./project-foundation-run-store.ts";

type Attached = Readonly<{
  admission: ProjectFoundationRunAdmission;
  facts: FoundationRunFacts;
}>;
function prepare(
  stage: ProjectStageRunAdmission,
  input: CommitExtensionTurnInput,
  facts: FoundationRunFacts | null,
): Attached | null {
  if (facts === null) return null;
  if (input.pluginAdmission === undefined) invalid();
  const admission = createProjectFoundationRunAdmission(
    {
      actor: stage.actor,
      binding: facts.binding,
      admission: input.pluginAdmission,
      extensionBinding: input.binding,
      stageAdmission: stage,
      foundation: facts.foundation,
      latestProposal: facts.latestProposal,
      at: stage.createdAt,
    },
    creativeStoreDigester,
  );
  return Object.freeze({ admission, facts });
}
function values(a: ProjectFoundationRunAdmission) {
  return [
    a.actor.tenantId,
    a.actor.spaceId,
    a.runId,
    a.contentDigest,
    extensionCanonicalJson(a),
  ];
}
/** No caller-issued grant or payload. The genuine stage Turn already holds its project lock. */
export function attachSqliteFoundationRun(
  db: DatabaseSync,
  stage: ProjectStageRunAdmission | null,
  input: CommitExtensionTurnInput,
): Attached | null {
  if (
    stage?.stage.kind !== "discussion" ||
    !assertSqliteProjectFoundationRunSchema(db)
  )
    return null;
  const result = prepare(
    stage,
    input,
    captureSqliteFoundationRunFacts(db, stage, true),
  );
  if (result === null) return null;
  db.prepare(
    "INSERT INTO project_foundation_run_admissions VALUES(?,?,?,?,?)",
  ).run(...values(result.admission));
  db.prepare(
    "INSERT INTO project_foundation_run_requirements VALUES(?,?,?,?)",
  ).run(...values(result.admission).slice(0, 4));
  return result;
}
export async function attachPostgresFoundationRun(
  c: PoolClient,
  schema: string,
  stage: ProjectStageRunAdmission | null,
  input: CommitExtensionTurnInput,
): Promise<Attached | null> {
  if (
    stage?.stage.kind !== "discussion" ||
    !(await assertPostgresProjectFoundationRunSchema(c, schema))
  )
    return null;
  const result = prepare(
    stage,
    input,
    await capturePostgresFoundationRunFacts(c, schema, stage, true),
  );
  if (result === null) return null;
  const p = `${creativeProjectSchemaName(schema)}.`;
  await c.query(
    `INSERT INTO ${p}project_foundation_run_admissions VALUES($1,$2,$3,$4,$5)`,
    values(result.admission),
  );
  await c.query(
    `INSERT INTO ${p}project_foundation_run_requirements VALUES($1,$2,$3,$4)`,
    values(result.admission).slice(0, 4),
  );
  return result;
}
export function assertSqliteFoundationTurnCurrent(
  db: DatabaseSync,
  stage: ProjectStageRunAdmission | null,
  attached: Attached | null,
): void {
  if (attached !== null && stage !== null)
    assertFoundationRunFactsUnchanged(
      attached.facts,
      captureSqliteFoundationRunFacts(db, stage, true),
    );
}
export async function assertPostgresFoundationTurnCurrent(
  c: PoolClient,
  schema: string,
  stage: ProjectStageRunAdmission | null,
  attached: Attached | null,
): Promise<void> {
  if (attached !== null && stage !== null)
    assertFoundationRunFactsUnchanged(
      attached.facts,
      await capturePostgresFoundationRunFacts(c, schema, stage, true),
    );
}
function replay(
  stage: ProjectStageRunAdmission | null,
  saved: ProjectFoundationRunAdmission | null,
): void {
  if (
    saved !== null &&
    (stage === null ||
      stage.stage.kind !== "discussion" ||
      saved.projectStageAdmissionDigest !== stage.contentDigest)
  )
    invalid();
}
export function assertSqliteFoundationTurnReplay(
  db: DatabaseSync,
  stage: ProjectStageRunAdmission | null,
  input: CommitExtensionTurnInput,
): void {
  replay(
    stage,
    loadSqliteFoundationRun(db, {
      tenantId: input.binding.tenantId,
      spaceId: input.binding.spaceId,
      runId: input.binding.runId,
    }),
  );
}
export async function assertPostgresFoundationTurnReplay(
  c: PoolClient,
  schema: string,
  stage: ProjectStageRunAdmission | null,
  input: CommitExtensionTurnInput,
): Promise<void> {
  replay(
    stage,
    await loadPostgresFoundationRun(c, schema, {
      tenantId: input.binding.tenantId,
      spaceId: input.binding.spaceId,
      runId: input.binding.runId,
    }),
  );
}
function invalid(): never {
  throw new Error("project_foundation_run_turn_invalid");
}
