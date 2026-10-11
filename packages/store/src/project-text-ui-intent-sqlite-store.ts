import { captureSqliteCreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import {
  assertSqliteTextPlanProject,
  assertSqliteTextPlanReceiptProject,
} from "./project-text-plan-legacy-access.ts";
import { commitOriginalSqliteProjectMigration } from "./original-project-migration.ts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  type CreativeProjectCommitOptions,
  type ProjectTextRecoveryCommitOptions,
  type ProjectTextUiIntentJournalStore,
} from "@crewon/application";
import {
  assertProjectTextUiIntentScope,
  extensionCanonicalJson,
  type ProjectTextUiIntent,
} from "@crewon/domain";
import { decodeCreativeProject } from "./creative-project-store-records.ts";
import { assertSqliteProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertSqliteTextIntentSchema,
  migrateSqliteTextIntent,
} from "./project-text-ui-intent-schema.ts";
import {
  acceptedTextIntent,
  acknowledgedTextIntent,
  assertTextIntentCommand,
  decodeTextIntent,
  fail,
  refusedTextIntent,
  textIntentColumns,
  textIntentIdentity,
  textIntentProjectFilter,
  textIntentProjectValues,
  textIntentReceiptFilter,
  textIntentReceiptValues,
  textIntentRecovery,
  textIntentRejected,
  textIntentScopeDigest,
  textIntentStage,
  textIntentValues,
  textRecoveryActive,
  textRecoveryCurrent,
  type IntentInput,
} from "./project-text-ui-intent-support.ts";
import { actualTextIntentRefusal } from "./project-text-ui-intent-refusal.ts";

/** Explicit independent journal on the original parent's connection and lifetime. */
export class SqliteProjectTextUiIntentJournalStore
  implements ProjectTextUiIntentJournalStore
{
  readonly #db: DatabaseSync;
  readonly #assertOpen: () => void;
  constructor(input: { database: DatabaseSync; assertOpen(): void }) {
    this.#db = input.database;
    this.#assertOpen = input.assertOpen.bind(input);
  }
  async migrate(): Promise<void> {
    commitOriginalSqliteProjectMigration({
      database: this.#db,
      assertOpen: this.#assertOpen,
      migrate: () => migrateSqliteTextIntent(this.#db),
    });
  }
  async stage(
    input: IntentInput<"stage">,
    options: CreativeProjectCommitOptions,
  ) {
    const p = textIntentStage(input, options);
    await assertCreativeProjectCommitCurrent(p.authority);
    await p.q.assertCurrent();
    return this.#transaction(
      () => {
        assertSqliteTextIntentSchema(this.#db);
        assertSqliteProjectTextUiCommit(this.#db, p.q);
        this.#project(p.scope);
        let record = decodeTextIntent(
          this.#get(
            `SELECT * FROM project_text_ui_intents WHERE ${textIntentReceiptFilter}`,
            textIntentReceiptValues(p.identity),
          ),
        );
        if (record !== null) {
          assertProjectTextUiIntentScope(record.scope, p.scope);
          if (
            record.requestDigest !== p.record.requestDigest ||
            extensionCanonicalJson(record.input) !==
              extensionCanonicalJson(p.record.input)
          )
            throw new Error("project_text_idempotency_conflict");
          if (
            record.actionId !== p.record.actionId ||
            record.requestDigest !== p.record.requestDigest ||
            extensionCanonicalJson(record.input) !==
              extensionCanonicalJson(p.record.input) ||
            record.intentId !== p.record.intentId
          )
            fail();
        } else {
          if (
            this.#get(
              "SELECT intent_id FROM project_text_ui_intents WHERE scope_digest=? AND acknowledged=0",
              [textIntentScopeDigest(p.scope)],
            ) !== undefined
          )
            throw new Error("project_text_ui_intent_unacknowledged");
          record = p.record;
          this.#db
            .prepare(
              `INSERT INTO project_text_ui_intents(${textIntentColumns}) VALUES(${Array(14).fill("?").join(",")})`,
            )
            .run(...textIntentValues(record));
        }
        const receipt = this.#receipt(record);
        if (receipt !== undefined)
          record = this.#accept(record, receipt, p.record.updatedAt);
        return record;
      },
      () => {
        assertCreativeProjectCommitActive(p.authority);
        assertSqliteProjectTextUiCommit(this.#db, p.q);
      },
    );
  }
  async getPending(
    input: IntentInput<"getPending">,
    options: ProjectTextRecoveryCommitOptions,
  ) {
    const p = textIntentRecovery("getPending", input, options);
    await textRecoveryCurrent(p.authority);
    await p.q.assertCurrent();
    return this.#transaction(
      () => {
        assertSqliteTextIntentSchema(this.#db);
        assertSqliteProjectTextUiCommit(this.#db, p.q);
        this.#project(p.scope);
        const record = decodeTextIntent(
          this.#get(
            "SELECT * FROM project_text_ui_intents WHERE scope_digest=? AND acknowledged=0",
            [textIntentScopeDigest(p.scope)],
          ),
        );
        if (record === null) return null;
        assertProjectTextUiIntentScope(record.scope, p.scope);
        return this.#validateReceipt(record);
      },
      () => {
        textRecoveryActive(p.authority);
        assertSqliteProjectTextUiCommit(this.#db, p.q);
      },
    );
  }
  async acknowledge(
    input: IntentInput<"acknowledge">,
    options: ProjectTextRecoveryCommitOptions,
  ) {
    const p = textIntentRecovery("acknowledge", input, options);
    await textRecoveryCurrent(p.authority);
    await p.q.assertCurrent();
    return this.#transaction(
      () => {
        assertSqliteTextIntentSchema(this.#db);
        assertSqliteProjectTextUiCommit(this.#db, p.q);
        this.#project(p.scope);
        const record = decodeTextIntent(
          this.#get(
            "SELECT * FROM project_text_ui_intents WHERE intent_id=? AND scope_digest=?",
            [p.intentId!, textIntentScopeDigest(p.scope)],
          ),
        );
        if (record === null)
          throw new Error("project_text_ui_intent_not_found");
        assertProjectTextUiIntentScope(record.scope, p.scope);
        this.#validateReceipt(record);
        const next = acknowledgedTextIntent(record, p.expectedRevision!, p.at!);
        if (next !== record) this.#update(record, next);
        return Object.freeze({
          intent: next,
          disposition:
            record.acknowledgedAt === null
              ? ("acknowledged" as const)
              : ("replayed" as const),
        });
      },
      () => {
        textRecoveryActive(p.authority);
        assertSqliteProjectTextUiCommit(this.#db, p.q);
      },
    );
  }
  async observeRejected(
    input: IntentInput<"observeRejected">,
    options: CreativeProjectCommitOptions,
  ) {
    const p = textIntentRejected(input, options);
    await assertCreativeProjectCommitCurrent(p.authority);
    await p.q.assertCurrent();
    return this.#transaction(
      () => {
        assertSqliteTextIntentSchema(this.#db);
        assertSqliteProjectTextUiCommit(this.#db, p.q);
        const project = this.#project(p.scope);
        const record = decodeTextIntent(
          this.#get("SELECT * FROM project_text_ui_intents WHERE intent_id=?", [
            p.intentId,
          ]),
        );
        if (record === null) fail();
        assertTextIntentCommand(record, p.q, p.identity);
        const receipt = this.#receipt(record);
        if (receipt !== undefined) return this.#accept(record, receipt, p.at);
        if (record.phase !== "pending") return record;
        const rows = this.#refusalRows(record);
        if (!actualTextIntentRefusal(record, p.code, project, rows))
          return record;
        const next = refusedTextIntent(record, p.code, p.at);
        this.#update(record, next);
        return next;
      },
      () => {
        assertCreativeProjectCommitActive(p.authority);
        assertSqliteProjectTextUiCommit(this.#db, p.q);
      },
    );
  }
  #refusalRows(record: ProjectTextUiIntent) {
    const q = record.input,
      request = q.request as Record<string, unknown>;
    const base = [
      record.scope.actor.tenantId,
      record.scope.actor.spaceId,
      record.scope.projectId,
    ];
    const head = this.#get(
      `SELECT * FROM project_text_artifacts WHERE tenant_id=? AND space_id=? AND project_id=? AND ${record.actionId.endsWith("saveOutlineCandidate") ? "kind='outline' AND episode_id=''" : record.actionId.endsWith("saveScriptCandidate") ? "kind='script' AND episode_id=?" : "artifact_id=?"}`,
      [
        ...base,
        ...(record.actionId.endsWith("saveOutlineCandidate")
          ? []
          : [String(q.episodeId ?? q.artifactId)]),
      ],
    );
    const revision = record.actionId.endsWith("selectRevision")
      ? this.#get(
          "SELECT c.*,? AS owner_principal_id FROM project_text_revisions c WHERE tenant_id=? AND space_id=? AND project_id=? AND artifact_id=? AND content_revision=?",
          [
            record.scope.actor.principalId,
            ...base,
            String(q.artifactId),
            Number(request.contentRevision),
          ],
        )
      : undefined;
    const outline = this.#get(
      "SELECT * FROM project_text_artifacts WHERE tenant_id=? AND space_id=? AND project_id=? AND kind='outline' AND episode_id=''",
      base,
    );
    return { head, revision, outline };
  }
  #validateReceipt(record: ProjectTextUiIntent): ProjectTextUiIntent {
    const receipt = this.#receipt(record);
    if (record.phase === "accepted") {
      if (receipt === undefined) fail();
      return acceptedTextIntent(record, receipt);
    }
    if (receipt !== undefined) fail();
    return record;
  }
  #accept(
    record: ProjectTextUiIntent,
    receipt: Record<string, unknown>,
    at: string,
  ) {
    const next = acceptedTextIntent(record, receipt, at);
    if (next !== record) this.#update(record, next);
    return next;
  }
  #receipt(record: ProjectTextUiIntent) {
    assertSqliteTextPlanProject(
      this.#db,
      record.scope.actor,
      record.scope.projectId,
    );
    const row = this.#get(
      `SELECT * FROM project_text_mutation_receipts WHERE ${textIntentReceiptFilter}`,
      textIntentReceiptValues(textIntentIdentity(record)),
    );
    assertSqliteTextPlanReceiptProject(this.#db, row);
    return row;
  }
  #project(scope: IntentInput<"stage">["scope"]) {
    assertSqliteTextPlanProject(this.#db, scope.actor, scope.projectId);
    const row = this.#get(
      `SELECT * FROM creative_projects WHERE ${textIntentProjectFilter}`,
      textIntentProjectValues(scope),
    );
    const project = decodeCreativeProject(row, scope.actor, scope.projectId);
    if (project === null) throw new Error("creative_project_not_found");
    return project;
  }
  #update(old: ProjectTextUiIntent, next: ProjectTextUiIntent) {
    const changed = this.#db
      .prepare(
        "UPDATE project_text_ui_intents SET revision=?,phase=?,acknowledged=?,record_json=? WHERE intent_id=? AND revision=?",
      )
      .run(
        next.revision,
        next.phase,
        next.acknowledgedAt === null ? 0 : 1,
        JSON.stringify(next),
        old.intentId,
        old.revision,
      );
    if (changed.changes !== 1) fail();
  }
  #get(sql: string, values: SQLInputValue[] = []) {
    this.#assertOpen();
    const row = this.#db.prepare(sql).get(...values);
    if (row?.project_id !== undefined)
      assertSqliteTextPlanReceiptProject(this.#db, row);
    return row;
  }
  #transaction<
    T extends ProjectTextUiIntent | null | { intent: ProjectTextUiIntent },
  >(work: () => T, active?: () => void): T {
    this.#assertOpen();
    active?.();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      captureSqliteCreativeProjectLegacyAccess(this.#db);
      const result = work();
      const intent = journalResultIntent(result);
      if (intent)
        assertSqliteTextPlanProject(
          this.#db,
          intent.scope.actor,
          intent.scope.projectId,
        );
      active?.();
      this.#assertOpen();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* preserve original */
      }
      throw error;
    }
  }
}

function journalResultIntent(
  result: ProjectTextUiIntent | null | { intent: ProjectTextUiIntent },
): ProjectTextUiIntent | null {
  if (result === null) return null;
  if ("scope" in result) return result;
  return result.intent;
}
