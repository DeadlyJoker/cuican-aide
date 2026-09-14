import { DatabaseSync } from "node:sqlite";
import {
  ApplicationError,
  type SkillDraftGenerationRecord,
  type SkillDraftGenerationResult,
  type SkillDraftGenerationStore,
  type SkillLocator,
} from "@crewon/application";
import {
  parseSkillMethod,
  skillJson,
  skillKeys,
  skillText,
} from "@crewon/domain";

const where =
  "tenant_id = ? AND space_id = ? AND owner_actor_id = ? AND skill_id = ?";
type Row = { record_json: string };
export class SqliteSkillDraftGenerationStore
  implements SkillDraftGenerationStore
{
  readonly #db: DatabaseSync;
  #closed = false;
  constructor(path: string) {
    skillText(path, 4096);
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS skill_draft_generations (
        tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
        skill_id TEXT NOT NULL, generation_id TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        PRIMARY KEY(tenant_id, space_id, owner_actor_id, skill_id, generation_id)
      ) STRICT;`);
  }
  async close() {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
  async putGeneration(record: SkillDraftGenerationRecord) {
    const next = validate(record);
    return this.transaction(() => {
      const current = this.get(next, next.generationId);
      if (current) {
        if (identity(current) !== identity(next))
          conflict("skill_generation_id_conflict");
        return current;
      }
      if (
        next.runId !== null ||
        next.outcome !== "pending" ||
        next.applyRequested
      )
        invalid();
      const count = this.#db
        .prepare(
          `SELECT count(*) AS count FROM skill_draft_generations WHERE ${where}`,
        )
        .get(...args(next)) as { count: number };
      if (count.count >= 20) conflict("skill_generation_limit");
      this.#db
        .prepare(
          "INSERT INTO skill_draft_generations VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(...args(next), next.generationId, skillJson(next));
      return next;
    });
  }
  async getGeneration(locator: SkillLocator, generationId: string) {
    return this.get(locator, generationId);
  }
  async listGenerations(locator: SkillLocator) {
    const rows = this.#db
      .prepare(
        `SELECT record_json FROM skill_draft_generations WHERE ${where} ORDER BY json_extract(record_json, '$.createdAt') DESC, generation_id LIMIT 20`,
      )
      .all(...args(locator)) as Row[];
    return rows.map((row) => {
      const record = validate(JSON.parse(row.record_json));
      checkScope(record, locator);
      return record;
    });
  }
  async bindGenerationRun(
    locator: SkillLocator,
    generationId: string,
    binding: {
      runId: string;
      startMessageId: string;
      startMessageSequence: number;
    },
  ) {
    this.change(locator, generationId, (current) => {
      if (
        current.runId !== null &&
        (current.runId !== binding.runId ||
          current.startMessageId !== binding.startMessageId ||
          current.startMessageSequence !== binding.startMessageSequence)
      )
        conflict("skill_generation_run_conflict");
      return { ...current, ...binding };
    });
  }
  async finishGeneration(
    locator: SkillLocator,
    generationId: string,
    result: SkillDraftGenerationResult,
  ) {
    this.change(locator, generationId, (current) => {
      if (!current.runId || result.outcome === "pending") invalid();
      if (current.outcome !== "pending") {
        const saved = {
          outcome: current.outcome,
          candidate: current.candidate,
          reasonCode: current.reasonCode,
          verification: current.verification,
          outputMessageId: current.outputMessageId,
          completedAt: current.completedAt,
        };
        if (
          skillJson({ ...saved, completedAt: null }) !==
          skillJson({ ...result, completedAt: null })
        )
          conflict("skill_generation_result_conflict");
        return current;
      }
      return { ...current, ...result };
    });
  }
  async requestGenerationApply(locator: SkillLocator, generationId: string) {
    this.change(locator, generationId, (current) => {
      if (current.outcome !== "candidate")
        conflict("skill_generation_candidate_required");
      return { ...current, applyRequested: true };
    });
  }
  async markGenerationApplied(
    locator: SkillLocator,
    generationId: string,
    appliedRevision: number,
  ) {
    this.change(locator, generationId, (current) => {
      if (
        !current.applyRequested ||
        current.outcome !== "candidate" ||
        appliedRevision !== current.expectedSkillRevision + 1 ||
        (current.appliedRevision !== null &&
          current.appliedRevision !== appliedRevision)
      )
        conflict("skill_generation_apply_conflict");
      return { ...current, appliedRevision };
    });
  }
  private get(locator: SkillLocator, generationId: string) {
    skillText(generationId, 128);
    const row = this.#db
      .prepare(
        `SELECT record_json FROM skill_draft_generations WHERE ${where} AND generation_id = ?`,
      )
      .get(...args(locator), generationId) as Row | undefined;
    if (!row) return null;
    const record = validate(JSON.parse(row.record_json));
    checkScope(record, locator);
    if (record.generationId !== generationId) invalid();
    return record;
  }
  private change(
    locator: SkillLocator,
    generationId: string,
    update: (current: SkillDraftGenerationRecord) => SkillDraftGenerationRecord,
  ) {
    this.transaction(() => {
      const current = this.get(locator, generationId);
      if (!current)
        throw new ApplicationError("notFound", "skill_generation_not_found");
      const next = validate(update(current));
      if (identity(current) !== identity(next))
        conflict("skill_generation_id_conflict");
      this.#db
        .prepare(
          `UPDATE skill_draft_generations SET record_json = ? WHERE ${where} AND generation_id = ?`,
        )
        .run(skillJson(next), ...args(locator), generationId);
    });
  }
  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
function identity(record: SkillDraftGenerationRecord) {
  return skillJson({
    ...Object.fromEntries(
      [
        "tenantId",
        "spaceId",
        "ownerActorId",
        "skillId",
        "generationId",
        "expectedSkillRevision",
      ].map((key) => [key, record[key as keyof SkillDraftGenerationRecord]]),
    ),
    command: record.command,
  });
}
function args(locator: SkillLocator) {
  const values = [
    locator.tenantId,
    locator.spaceId,
    locator.ownerActorId,
    locator.skillId,
  ];
  for (const value of values) skillText(value, 256);
  return values;
}
function checkScope(record: SkillDraftGenerationRecord, locator: SkillLocator) {
  if (skillJson(args(record)) !== skillJson(args(locator))) invalid();
}
function conflict(code: string): never {
  throw new ApplicationError("conflict", code);
}
function invalid(): never {
  throw new ApplicationError("validation", "skill_generation_record_invalid");
}
function validate(value: unknown): SkillDraftGenerationRecord {
  skillKeys(value, [
    "tenantId",
    "spaceId",
    "ownerActorId",
    "skillId",
    "generationId",
    "expectedSkillRevision",
    "command",
    "runId",
    "startMessageId",
    "startMessageSequence",
    "outcome",
    "candidate",
    "reasonCode",
    "verification",
    "outputMessageId",
    "completedAt",
    "applyRequested",
    "appliedRevision",
    "createdAt",
  ]);
  const record = value as SkillDraftGenerationRecord;
  args(record);
  skillText(record.generationId, 128);
  if (
    !Number.isSafeInteger(record.expectedSkillRevision) ||
    record.expectedSkillRevision < 1
  )
    invalid();
  skillKeys(record.command, [
    "kind",
    "idempotencyKey",
    "threadId",
    "expectedThreadRevision",
    "content",
    "requestedAgentVersionId",
    "executionIntent",
    "toolPermissionMode",
    "route",
  ]);
  const command = record.command;
  if (
    command.kind !== "turn.start" ||
    command.executionIntent !== "none" ||
    command.toolPermissionMode !== "requestApproval" ||
    !Number.isSafeInteger(command.expectedThreadRevision) ||
    command.expectedThreadRevision < 1
  )
    invalid();
  skillText(command.idempotencyKey, 512);
  skillText(command.threadId, 256);
  skillText(command.content, 9216);
  if (
    command.idempotencyKey !==
    `skill-generation:${record.skillId}:${record.generationId}`
  )
    invalid();
  if (command.requestedAgentVersionId !== null)
    skillText(command.requestedAgentVersionId, 512);
  skillKeys(command.route, [
    "authorityId",
    "runtimeGeneration",
    "agentVersionId",
    "policySnapshotId",
    "workspaceBindingId",
  ]);
  for (const key of [
    "authorityId",
    "runtimeGeneration",
    "agentVersionId",
    "policySnapshotId",
  ] as const)
    skillText(command.route[key], 512);
  if (command.route.workspaceBindingId !== null)
    skillText(command.route.workspaceBindingId, 512);
  if (record.runId === null) {
    if (record.startMessageId !== null || record.startMessageSequence !== null)
      invalid();
  } else {
    skillText(record.runId, 512);
    skillText(record.startMessageId, 512);
    if (
      !Number.isSafeInteger(record.startMessageSequence) ||
      (record.startMessageSequence ?? 0) < 1
    )
      invalid();
  }
  if (
    !["pending", "candidate", "invalid"].includes(record.outcome) ||
    !["real", "simulated", "unknown"].includes(record.verification) ||
    typeof record.applyRequested !== "boolean"
  )
    invalid();
  if (record.outcome === "candidate") {
    parseSkillMethod(record.candidate);
    if (record.reasonCode !== null || record.outputMessageId === null)
      invalid();
  } else if (record.candidate !== null) invalid();
  if (record.outcome === "invalid") skillText(record.reasonCode, 128);
  if (record.outcome === "pending") {
    if (
      record.completedAt !== null ||
      record.reasonCode !== null ||
      record.outputMessageId !== null ||
      record.verification !== "unknown" ||
      record.applyRequested ||
      record.appliedRevision !== null
    )
      invalid();
  } else {
    if (
      !record.runId ||
      !record.completedAt ||
      !Number.isFinite(Date.parse(record.completedAt))
    )
      invalid();
  }
  if (record.outputMessageId !== null) skillText(record.outputMessageId, 512);
  if (
    record.appliedRevision !== null &&
    (!record.applyRequested ||
      record.outcome !== "candidate" ||
      record.appliedRevision !== record.expectedSkillRevision + 1)
  )
    invalid();
  if (
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  )
    invalid();
  if (new TextEncoder().encode(skillJson(record)).length > 40 * 1024) invalid();
  return structuredClone(record);
}
