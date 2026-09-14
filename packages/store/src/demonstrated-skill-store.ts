import { DatabaseSync } from "node:sqlite";
import {
  ApplicationError,
  type DemonstratedSkillRecord,
  type DemonstratedSkillStore,
  type SkillExecutionRecord,
  type SkillLocator,
  type SkillScope,
  type SkillTrialReview,
} from "@crewon/application";
import {
  SkillError,
  createSkillVersion,
  parseSkillInvocationSpec,
  renderSkillInvocationContext,
  parseSkillMethod,
  parseSkillVersionRef,
  skillJson,
  skillKeys,
  validateSkillInvocation,
  verifySkillVersion,
  type SkillDigester,
  type SkillVersion,
  type SkillVersionRef,
} from "@crewon/domain";

type JsonRow = { record_json: string };
type VersionRow = { version_json: string; content_digest: string };
const scopeWhere = "tenant_id = ? AND space_id = ? AND owner_actor_id = ?";
const skillWhere = `${scopeWhere} AND skill_id = ?`;

/** Local Skill authority. Run lifecycle and authorization remain in the existing host. */
export class SqliteDemonstratedSkillStore implements DemonstratedSkillStore {
  readonly #database: DatabaseSync;
  readonly #digester: SkillDigester;
  #closed = false;

  constructor(path: string, digester: SkillDigester) {
    if (typeof path !== "string" || !path.length || path.includes("\0"))
      invalid("skill_sqlite_path_invalid");
    this.#digester = digester;
    this.#database = new DatabaseSync(path);
    try {
      this.#database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS demonstrated_skills (
          tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
          skill_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
          record_json TEXT NOT NULL CHECK(json_valid(record_json)),
          PRIMARY KEY (tenant_id, space_id, owner_actor_id, skill_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS demonstrated_skill_versions (
          tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
          skill_id TEXT NOT NULL, version_id TEXT NOT NULL, content_digest TEXT NOT NULL,
          created_at TEXT NOT NULL, version_json TEXT NOT NULL CHECK(json_valid(version_json)),
          PRIMARY KEY (tenant_id, space_id, owner_actor_id, skill_id, version_id),
          FOREIGN KEY (tenant_id, space_id, owner_actor_id, skill_id)
            REFERENCES demonstrated_skills(tenant_id, space_id, owner_actor_id, skill_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS demonstrated_skill_executions (
          tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, owner_actor_id TEXT NOT NULL,
          skill_id TEXT NOT NULL, execution_id TEXT NOT NULL, version_id TEXT NOT NULL,
          created_at TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
          PRIMARY KEY (tenant_id, space_id, owner_actor_id, skill_id, execution_id),
          FOREIGN KEY (tenant_id, space_id, owner_actor_id, skill_id, version_id)
            REFERENCES demonstrated_skill_versions(tenant_id, space_id, owner_actor_id, skill_id, version_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS demonstrated_skill_executions_recent
          ON demonstrated_skill_executions(tenant_id, space_id, owner_actor_id, skill_id, created_at DESC, execution_id DESC);
        CREATE INDEX IF NOT EXISTS demonstrated_skill_run_lookup
          ON demonstrated_skill_executions(tenant_id, space_id, owner_actor_id, json_extract(record_json, '$.runId'));
        COMMIT;
      `);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  async getSkill(
    locator: SkillLocator,
  ): Promise<DemonstratedSkillRecord | null> {
    this.#assertOpen();
    return this.#skill(locator);
  }

  async listSkills(
    scope: SkillScope,
    query: { after: string | null; limit: number },
  ): Promise<readonly DemonstratedSkillRecord[]> {
    this.#assertOpen();
    scopeArgs(scope);
    if (
      !query ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100
    )
      invalid("skill_list_invalid");
    if (query.after !== null) identifier(query.after, 128);
    const rows = this.#database
      .prepare(
        `SELECT record_json FROM demonstrated_skills
      WHERE ${scopeWhere} AND skill_id > ? COLLATE BINARY ORDER BY skill_id COLLATE BINARY LIMIT ?`,
      )
      .all(...scopeArgs(scope), query.after ?? "", query.limit) as JsonRow[];
    return rows.map((row) => {
      const record = validateRecord(
        JSON.parse(row.record_json),
        this.#digester,
      );
      exactScope(record, scope);
      return record;
    });
  }

  async saveSkill(
    record: DemonstratedSkillRecord,
    expectedRevision: number,
  ): Promise<void> {
    const next = validateRecord(record, this.#digester);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      next.revision !== expectedRevision + 1
    )
      invalid("skill_revision_invalid");
    this.#transaction(() => {
      const current = this.#skill(next);
      if ((current?.revision ?? 0) !== expectedRevision)
        conflict("skill_revision_conflict");
      if (
        current &&
        (current.createdAt !== next.createdAt ||
          skillJson(current.source) !== skillJson(next.source))
      )
        conflict("skill_source_conflict");
      for (const versionId of next.activatedVersionIds) {
        if (!this.#versionById(next, versionId))
          missing("skill_version_not_found");
      }
      if (current === null) {
        this.#database
          .prepare(
            `INSERT INTO demonstrated_skills
          (tenant_id, space_id, owner_actor_id, skill_id, revision, record_json) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(...locatorArgs(next), next.revision, skillJson(next));
      } else {
        const result = this.#database
          .prepare(
            `UPDATE demonstrated_skills SET revision = ?, record_json = ?
          WHERE ${skillWhere} AND revision = ?`,
          )
          .run(
            next.revision,
            skillJson(next),
            ...locatorArgs(next),
            expectedRevision,
          );
        if (result.changes !== 1) conflict("skill_revision_conflict");
      }
    });
  }

  async putVersion(
    locator: SkillLocator,
    version: SkillVersion,
  ): Promise<void> {
    locatorArgs(locator);
    const next = validateVersion(version, this.#digester);
    if (next.ref.skillId !== locator.skillId)
      throw new SkillError("skill_ref_mismatch");
    this.#transaction(() => {
      if (!this.#skill(locator)) missing("skill_not_found");
      const existing = this.#versionById(locator, next.ref.versionId);
      if (existing) {
        if (skillJson(existing) !== skillJson(next))
          conflict("skill_version_conflict");
        return;
      }
      const row = this.#database
        .prepare(
          `SELECT count(*) AS count FROM demonstrated_skill_versions WHERE ${skillWhere}`,
        )
        .get(...locatorArgs(locator)) as { count: number };
      if (row.count >= 100) conflict("skill_version_limit");
      this.#database
        .prepare(
          `INSERT INTO demonstrated_skill_versions
        (tenant_id, space_id, owner_actor_id, skill_id, version_id, content_digest, created_at, version_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ...locatorArgs(locator),
          next.ref.versionId,
          next.ref.contentDigest,
          next.createdAt,
          skillJson(next),
        );
    });
  }

  async getVersion(
    locator: SkillLocator,
    ref: SkillVersionRef,
  ): Promise<SkillVersion | null> {
    this.#assertOpen();
    return this.#version(locator, ref);
  }

  async listVersions(locator: SkillLocator): Promise<readonly SkillVersion[]> {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        `SELECT version_id, version_json, content_digest FROM demonstrated_skill_versions
      WHERE ${skillWhere} ORDER BY created_at, version_id COLLATE BINARY LIMIT 100`,
      )
      .all(...locatorArgs(locator)) as (VersionRow & { version_id: string })[];
    return rows.map((row) => this.#decodeVersion(row, locator, row.version_id));
  }

  async putExecution(
    record: SkillExecutionRecord,
  ): Promise<SkillExecutionRecord> {
    const next = validateExecution(record);
    return this.#transaction(() => {
      const version = this.#version(next, next.invocation.skill);
      if (!version) missing("skill_version_not_found");
      validateSkillInvocation(version.method, next.invocation);
      if (
        next.command.content !==
        renderSkillInvocationContext(version, next.invocation)
      )
        invalid("skill_execution_context_mismatch");
      const existing = this.#execution(next, next.executionId);
      if (existing) {
        if (
          executionIdentity(existing) !== executionIdentity(next) ||
          (next.runId !== null && next.runId !== existing.runId) ||
          (next.review !== null &&
            skillJson(next.review) !== skillJson(existing.review))
        )
          conflict("skill_execution_conflict");
        return existing;
      }
      if (next.runId !== null || next.review !== null)
        invalid("skill_execution_initial_state_invalid");
      const currentSkill = this.#skill(next);
      if (!currentSkill || currentSkill.disabled || currentSkill.deleted)
        conflict("skill_disabled");
      if (
        next.purpose === "execute" &&
        !currentSkill.activatedVersionIds.includes(version.ref.versionId)
      )
        conflict("skill_not_active");
      this.#database
        .prepare(
          `INSERT INTO demonstrated_skill_executions
        (tenant_id, space_id, owner_actor_id, skill_id, execution_id, version_id, created_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ...locatorArgs(next),
          next.executionId,
          next.invocation.skill.versionId,
          next.createdAt,
          skillJson(next),
        );
      return next;
    });
  }

  async getExecution(
    locator: SkillLocator,
    executionId: string,
  ): Promise<SkillExecutionRecord | null> {
    this.#assertOpen();
    return this.#execution(locator, executionId);
  }

  async bindExecutionRun(
    locator: SkillLocator,
    executionId: string,
    runId: string,
  ): Promise<void> {
    identifier(runId);
    this.#transaction(() => {
      const current = this.#execution(locator, executionId);
      if (!current) missing("skill_execution_not_found");
      if (current.runId !== null) {
        if (current.runId !== runId) conflict("skill_execution_run_conflict");
        return;
      }
      this.#writeExecution({ ...current, runId });
    });
  }

  async reviewExecution(
    locator: SkillLocator,
    executionId: string,
    review: SkillTrialReview,
  ): Promise<void> {
    validateReview(review);
    this.#transaction(() => {
      const current = this.#execution(locator, executionId);
      if (!current) missing("skill_execution_not_found");
      if (current.review !== null) {
        if (skillJson(current.review) !== skillJson(review))
          conflict("skill_execution_review_conflict");
        return;
      }
      if (current.purpose !== "trial" || current.runId === null)
        conflict("skill_execution_review_not_ready");
      this.#writeExecution({ ...current, review });
    });
  }

  async listExecutions(
    locator: SkillLocator,
  ): Promise<readonly SkillExecutionRecord[]> {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        `SELECT execution_id, record_json FROM demonstrated_skill_executions
      WHERE ${skillWhere} ORDER BY created_at DESC, execution_id COLLATE BINARY DESC LIMIT 100`,
      )
      .all(...locatorArgs(locator)) as (JsonRow & { execution_id: string })[];
    return rows.map((row) =>
      this.#decodeExecution(row, locator, row.execution_id),
    );
  }

  async findExecutionByRun(
    scope: SkillScope,
    runId: string,
  ): Promise<SkillExecutionRecord | null> {
    this.#assertOpen();
    identifier(runId);
    const row = this.#database
      .prepare(
        `SELECT skill_id, execution_id, record_json FROM demonstrated_skill_executions
      WHERE ${scopeWhere} AND json_extract(record_json, '$.runId') = ? LIMIT 2`,
      )
      .all(...scopeArgs(scope), runId) as (JsonRow & {
      skill_id: string;
      execution_id: string;
    })[];
    if (row.length > 1) invalid("skill_run_binding_ambiguous");
    return row[0]
      ? this.#decodeExecution(
          row[0],
          { ...scope, skillId: row[0].skill_id },
          row[0].execution_id,
        )
      : null;
  }

  async findReviewedTrial(
    locator: SkillLocator,
    ref: SkillVersionRef,
  ): Promise<SkillExecutionRecord | null> {
    this.#assertOpen();
    if (!this.#version(locator, ref)) return null;
    const row = this.#database
      .prepare(
        `SELECT execution_id, record_json FROM demonstrated_skill_executions
      WHERE ${skillWhere} AND version_id = ?
      AND json_extract(record_json, '$.purpose') = 'trial'
      AND json_type(record_json, '$.review') = 'object'
      ORDER BY created_at DESC, execution_id DESC LIMIT 1`,
      )
      .get(...locatorArgs(locator), ref.versionId) as
      | (JsonRow & { execution_id: string })
      | undefined;
    return row ? this.#decodeExecution(row, locator, row.execution_id) : null;
  }

  #skill(locator: SkillLocator): DemonstratedSkillRecord | null {
    const row = this.#database
      .prepare(
        `SELECT revision, record_json FROM demonstrated_skills WHERE ${skillWhere}`,
      )
      .get(...locatorArgs(locator)) as
      | (JsonRow & { revision: number })
      | undefined;
    if (!row) return null;
    const record = validateRecord(JSON.parse(row.record_json), this.#digester);
    exactLocator(record, locator);
    if (record.revision !== row.revision) invalid("skill_store_corrupt");
    return record;
  }

  #version(locator: SkillLocator, ref: SkillVersionRef): SkillVersion | null {
    const parsed = parseSkillVersionRef(ref);
    if (parsed.skillId !== locator.skillId)
      throw new SkillError("skill_ref_mismatch");
    const version = this.#versionById(locator, parsed.versionId);
    if (version && version.ref.contentDigest !== parsed.contentDigest)
      throw new SkillError("skill_digest_mismatch");
    return version;
  }

  #versionById(locator: SkillLocator, versionId: string): SkillVersion | null {
    identifier(versionId, 128);
    const row = this.#database
      .prepare(
        `SELECT version_json, content_digest FROM demonstrated_skill_versions
      WHERE ${skillWhere} AND version_id = ?`,
      )
      .get(...locatorArgs(locator), versionId) as VersionRow | undefined;
    return row ? this.#decodeVersion(row, locator, versionId) : null;
  }

  #decodeVersion(
    row: VersionRow,
    locator: SkillLocator,
    versionId: string,
  ): SkillVersion {
    const version = validateVersion(
      JSON.parse(row.version_json),
      this.#digester,
    );
    if (
      version.ref.skillId !== locator.skillId ||
      version.ref.versionId !== versionId
    )
      invalid("skill_store_corrupt");
    if (version.ref.contentDigest !== row.content_digest)
      throw new SkillError("skill_digest_mismatch");
    return version;
  }

  #execution(
    locator: SkillLocator,
    executionId: string,
  ): SkillExecutionRecord | null {
    identifier(executionId);
    const row = this.#database
      .prepare(
        `SELECT record_json FROM demonstrated_skill_executions
      WHERE ${skillWhere} AND execution_id = ?`,
      )
      .get(...locatorArgs(locator), executionId) as JsonRow | undefined;
    return row ? this.#decodeExecution(row, locator, executionId) : null;
  }

  #decodeExecution(
    row: JsonRow,
    locator: SkillLocator,
    executionId: string,
  ): SkillExecutionRecord {
    const record = validateExecution(JSON.parse(row.record_json));
    exactLocator(record, locator);
    if (record.executionId !== executionId) invalid("skill_store_corrupt");
    const version = this.#version(locator, record.invocation.skill);
    if (
      !version ||
      record.command.content !==
        renderSkillInvocationContext(version, record.invocation)
    )
      invalid("skill_execution_context_mismatch");
    return record;
  }

  #writeExecution(record: SkillExecutionRecord): void {
    const changed = this.#database
      .prepare(
        `UPDATE demonstrated_skill_executions SET record_json = ?
      WHERE ${skillWhere} AND execution_id = ?`,
      )
      .run(
        skillJson(record),
        ...locatorArgs(record),
        record.executionId,
      ).changes;
    if (changed !== 1) conflict("skill_execution_conflict");
  }

  #transaction<T>(operation: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new ApplicationError("internal", "skill_store_closed");
  }
}

function validateRecord(
  value: unknown,
  digester: SkillDigester,
): DemonstratedSkillRecord {
  skillKeys(value, [
    "tenantId",
    "spaceId",
    "ownerActorId",
    "skillId",
    "revision",
    "draft",
    "source",
    "disabled",
    "deleted",
    "activatedVersionIds",
    "createdAt",
    "updatedAt",
  ]);
  const record = value as DemonstratedSkillRecord;
  locatorArgs(record);
  if (
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    typeof record.disabled !== "boolean" ||
    typeof record.deleted !== "boolean"
  )
    invalid("skill_record_invalid");
  timestamp(record.createdAt);
  timestamp(record.updatedAt);
  const draft = parseSkillMethod(record.draft);
  createSkillVersion(
    {
      skillId: record.skillId,
      versionId: "validation",
      method: draft,
      source: record.source,
      createdAt: record.createdAt,
    },
    digester,
  );
  stringList(record.activatedVersionIds, 100, 128, true);
  if (
    new Set(record.activatedVersionIds).size !==
    record.activatedVersionIds.length
  )
    invalid("skill_record_invalid");
  for (const id of record.activatedVersionIds) identifier(id, 128);
  boundedJson(record, 32768);
  return structuredClone({ ...record, draft });
}

function validateVersion(
  value: unknown,
  digester: SkillDigester,
): SkillVersion {
  skillKeys(value, [
    "schemaVersion",
    "ref",
    "method",
    "source",
    "markdown",
    "createdAt",
  ]);
  const version = value as SkillVersion;
  parseSkillVersionRef(version.ref);
  timestamp(version.createdAt);
  verifySkillVersion(version, digester);
  boundedJson(version, 32768);
  return structuredClone(version);
}

function validateExecution(value: unknown): SkillExecutionRecord {
  skillKeys(value, [
    "tenantId",
    "spaceId",
    "ownerActorId",
    "skillId",
    "executionId",
    "invocation",
    "purpose",
    "command",
    "runId",
    "review",
    "createdAt",
  ]);
  const record = value as SkillExecutionRecord;
  locatorArgs(record);
  identifier(record.executionId);
  timestamp(record.createdAt);
  const invocation = parseSkillInvocationSpec(record.invocation);
  if (invocation.skill.skillId !== record.skillId)
    throw new SkillError("skill_ref_mismatch");
  if (record.purpose !== "trial" && record.purpose !== "execute")
    invalid("skill_execution_invalid");
  if (record.runId !== null) identifier(record.runId);
  if (record.review !== null) validateReview(record.review);
  if (
    record.review !== null &&
    (record.purpose !== "trial" || record.runId === null)
  )
    invalid("skill_execution_invalid");
  const command = record.command;
  skillKeys(command, [
    "kind",
    "skillExecution",
    "idempotencyKey",
    "executionIntentVersion",
    "threadId",
    "expectedThreadRevision",
    "content",
    "requestedAgentVersionId",
    "executionIntent",
    "toolPermissionMode",
    "route",
  ]);
  if (
    command.kind !== "turn.start" ||
    !Number.isSafeInteger(command.expectedThreadRevision) ||
    command.expectedThreadRevision < 0 ||
    !["none", "goal", "plan", "resumeGoal"].includes(command.executionIntent)
  )
    invalid("skill_execution_command_invalid");
  identifier(command.idempotencyKey);
  identifier(command.threadId);
  nonemptyText(command.content, 32768);
  if (command.requestedAgentVersionId !== null)
    identifier(command.requestedAgentVersionId);
  if (
    command.executionIntentVersion !== undefined &&
    command.executionIntentVersion !== "v1"
  )
    invalid("skill_execution_command_invalid");
  if (
    command.toolPermissionMode !== undefined &&
    !["requestApproval", "approveForMe", "fullAccess"].includes(
      command.toolPermissionMode,
    )
  )
    invalid("skill_execution_command_invalid");
  skillKeys(command.route, [
    "authorityId",
    "runtimeGeneration",
    "agentVersionId",
    "policySnapshotId",
    "workspaceBindingId",
  ]);
  for (const field of [
    "authorityId",
    "runtimeGeneration",
    "agentVersionId",
    "policySnapshotId",
  ] as const)
    identifier(command.route[field]);
  if (command.route.workspaceBindingId !== null)
    identifier(command.route.workspaceBindingId);
  boundedJson(record, 65536);
  return structuredClone({ ...record, invocation });
}

function validateReview(value: unknown): asserts value is SkillTrialReview {
  skillKeys(value, ["confirmedAt", "resultNote", "criteria", "coverage"]);
  const review = value as SkillTrialReview;
  timestamp(review.confirmedAt);
  nonemptyText(review.resultNote, 2048);
  stringList(review.criteria, 12, 512);
  stringList(review.coverage, 3, 32, true);
  if (
    review.coverage.some(
      (item) => !["new-date", "new-input", "handled-exception"].includes(item),
    ) ||
    new Set(review.coverage).size !== review.coverage.length
  )
    invalid("skill_review_invalid");
}

function scopeArgs(scope: SkillScope): [string, string, string] {
  if (!scope) invalid("skill_scope_invalid");
  identifier(scope.tenantId);
  identifier(scope.spaceId);
  identifier(scope.ownerActorId);
  return [scope.tenantId, scope.spaceId, scope.ownerActorId];
}
function locatorArgs(locator: SkillLocator): [string, string, string, string] {
  const scope = scopeArgs(locator);
  identifier(locator.skillId, 128);
  return [...scope, locator.skillId];
}
function exactScope(actual: SkillScope, expected: SkillScope): void {
  if (scopeArgs(actual).some((id, i) => id !== scopeArgs(expected)[i]))
    invalid("skill_store_corrupt");
}
function exactLocator(actual: SkillLocator, expected: SkillLocator): void {
  exactScope(actual, expected);
  if (actual.skillId !== expected.skillId) invalid("skill_store_corrupt");
}
function executionIdentity(record: SkillExecutionRecord): string {
  return skillJson({
    invocation: record.invocation,
    purpose: record.purpose,
    command: record.command,
  });
}
function identifier(value: unknown, limit = 512): asserts value is string {
  nonemptyText(value, limit);
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value))
    invalid("skill_identifier_invalid");
}
function nonemptyText(value: unknown, limit: number): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > limit
  )
    invalid("skill_value_invalid");
}
function timestamp(value: unknown): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid("skill_timestamp_invalid");
}
function stringList(
  value: unknown,
  count: number,
  bytes: number,
  empty = false,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > count ||
    (!empty && !value.length)
  )
    invalid("skill_list_invalid");
  for (const item of value) nonemptyText(item, bytes);
}
function boundedJson(value: unknown, limit: number): void {
  if (Buffer.byteLength(skillJson(value)) > limit)
    invalid("skill_record_too_large");
}
function invalid(code: string): never {
  throw new ApplicationError("validation", code);
}
function conflict(code: string): never {
  throw new ApplicationError("conflict", code);
}
function missing(code: string): never {
  throw new ApplicationError("notFound", code);
}
