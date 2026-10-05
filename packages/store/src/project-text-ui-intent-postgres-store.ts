import type { Pool, PoolClient } from "pg";
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
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { assertPostgresProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertPostgresTextIntentSchema,
  migratePostgresTextIntent,
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
import type { TextIdentity } from "./project-text-store-support.ts";

/** One borrowed parent connection, with the same installation→receipt→journal→project lock order as business writes. */
export class PostgresProjectTextUiIntentJournalStore
  implements ProjectTextUiIntentJournalStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #assertOpen: () => void;
  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    creativeProjectSchemaName(input.schema);
    this.#assertOpen = input.assertOpen.bind(input);
  }
  async migrate(): Promise<void> {
    await this.#transaction((client) =>
      migratePostgresTextIntent(client, this.#schema),
    );
  }
  async stage(
    input: IntentInput<"stage">,
    options: CreativeProjectCommitOptions,
  ) {
    const p = textIntentStage(input, options);
    await assertCreativeProjectCommitCurrent(p.authority);
    return this.#transaction(
      async (client) => {
        await assertPostgresTextIntentSchema(client, this.#schema);
        await assertPostgresProjectTextUiCommit(client, this.#schema, p.q);
        await this.#receiptLock(client, p.identity);
        await this.#scopeLock(client, p.scope);
        await this.#projectLock(client, p.scope);
        await this.#project(client, p.scope);
        let record = decodeTextIntent(
          await this.#get(
            client,
            `SELECT * FROM project_text_ui_intents WHERE ${textIntentReceiptFilter} FOR UPDATE`,
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
            await this.#get(
              client,
              "SELECT intent_id FROM project_text_ui_intents WHERE scope_digest=? AND acknowledged=0",
              [textIntentScopeDigest(p.scope)],
            )
          )
            throw new Error("project_text_ui_intent_unacknowledged");
          record = p.record;
          await this.#query(
            client,
            `INSERT INTO project_text_ui_intents(${textIntentColumns}) VALUES(${Array(14).fill("?").join(",")})`,
            textIntentValues(record),
          );
        }
        const receipt = await this.#receipt(client, record);
        if (receipt !== undefined)
          record = await this.#accept(
            client,
            record,
            receipt,
            p.record.updatedAt,
          );
        return record;
      },
      () => assertCreativeProjectCommitActive(p.authority),
      () => p.q.assertCurrent(),
    );
  }
  async getPending(
    input: IntentInput<"getPending">,
    options: ProjectTextRecoveryCommitOptions,
  ) {
    const p = textIntentRecovery("getPending", input, options);
    await textRecoveryCurrent(p.authority);
    return this.#transaction(
      async (client) => {
        await assertPostgresTextIntentSchema(client, this.#schema);
        await assertPostgresProjectTextUiCommit(client, this.#schema, p.q);
        await this.#scopeLock(client, p.scope);
        await this.#project(client, p.scope);
        const record = decodeTextIntent(
          await this.#get(
            client,
            "SELECT * FROM project_text_ui_intents WHERE scope_digest=? AND acknowledged=0",
            [textIntentScopeDigest(p.scope)],
          ),
        );
        if (record === null) return null;
        assertProjectTextUiIntentScope(record.scope, p.scope);
        return this.#validateReceipt(client, record);
      },
      () => textRecoveryActive(p.authority),
      () => p.q.assertCurrent(),
    );
  }
  async acknowledge(
    input: IntentInput<"acknowledge">,
    options: ProjectTextRecoveryCommitOptions,
  ) {
    const p = textIntentRecovery("acknowledge", input, options);
    await textRecoveryCurrent(p.authority);
    return this.#transaction(
      async (client) => {
        await assertPostgresTextIntentSchema(client, this.#schema);
        await assertPostgresProjectTextUiCommit(client, this.#schema, p.q);
        // The preliminary lookup is immutable identity only. Never hold a row/scope lock before the receipt lock.
        const first = decodeTextIntent(
          await this.#get(
            client,
            "SELECT * FROM project_text_ui_intents WHERE intent_id=? AND scope_digest=?",
            [p.intentId!, textIntentScopeDigest(p.scope)],
          ),
        );
        if (first === null) throw new Error("project_text_ui_intent_not_found");
        assertProjectTextUiIntentScope(first.scope, p.scope);
        await this.#receiptLock(client, textIntentIdentity(first));
        await this.#scopeLock(client, p.scope);
        await this.#projectLock(client, p.scope);
        await this.#project(client, p.scope);
        const record = decodeTextIntent(
          await this.#get(
            client,
            "SELECT * FROM project_text_ui_intents WHERE intent_id=? AND scope_digest=? FOR UPDATE",
            [p.intentId!, textIntentScopeDigest(p.scope)],
          ),
        );
        if (record === null)
          throw new Error("project_text_ui_intent_not_found");
        assertProjectTextUiIntentScope(record.scope, p.scope);
        await this.#validateReceipt(client, record);
        const next = acknowledgedTextIntent(record, p.expectedRevision!, p.at!);
        if (next !== record) await this.#update(client, record, next);
        return Object.freeze({
          intent: next,
          disposition:
            record.acknowledgedAt === null
              ? ("acknowledged" as const)
              : ("replayed" as const),
        });
      },
      () => textRecoveryActive(p.authority),
      () => p.q.assertCurrent(),
    );
  }
  async observeRejected(
    input: IntentInput<"observeRejected">,
    options: CreativeProjectCommitOptions,
  ) {
    const p = textIntentRejected(input, options);
    await assertCreativeProjectCommitCurrent(p.authority);
    return this.#transaction(
      async (client) => {
        await assertPostgresTextIntentSchema(client, this.#schema);
        await assertPostgresProjectTextUiCommit(client, this.#schema, p.q);
        await this.#receiptLock(client, p.identity);
        await this.#scopeLock(client, p.scope);
        await this.#projectLock(client, p.scope);
        const project = await this.#project(client, p.scope);
        const record = decodeTextIntent(
          await this.#get(
            client,
            "SELECT * FROM project_text_ui_intents WHERE intent_id=? FOR UPDATE",
            [p.intentId],
          ),
        );
        if (record === null) fail();
        assertTextIntentCommand(record, p.q, p.identity);
        const receipt = await this.#receipt(client, record);
        if (receipt !== undefined)
          return this.#accept(client, record, receipt, p.at);
        if (record.phase !== "pending") return record;
        const rows = await this.#refusalRows(client, record);
        if (!actualTextIntentRefusal(record, p.code, project, rows))
          return record;
        const next = refusedTextIntent(record, p.code, p.at);
        await this.#update(client, record, next);
        return next;
      },
      () => assertCreativeProjectCommitActive(p.authority),
      () => p.q.assertCurrent(),
    );
  }
  async #refusalRows(client: PoolClient, record: ProjectTextUiIntent) {
    const q = record.input,
      request = q.request as Record<string, unknown>;
    const base = [
      record.scope.actor.tenantId,
      record.scope.actor.spaceId,
      record.scope.projectId,
    ];
    const head = await this.#get(
      client,
      `SELECT * FROM project_text_artifacts WHERE tenant_id=? AND space_id=? AND project_id=? AND ${record.actionId.endsWith("saveOutlineCandidate") ? "kind='outline' AND episode_id=''" : record.actionId.endsWith("saveScriptCandidate") ? "kind='script' AND episode_id=?" : "artifact_id=?"}`,
      [
        ...base,
        ...(record.actionId.endsWith("saveOutlineCandidate")
          ? []
          : [String(q.episodeId ?? q.artifactId)]),
      ],
    );
    const revision = record.actionId.endsWith("selectRevision")
      ? await this.#get(
          client,
          "SELECT c.*,? AS owner_principal_id FROM project_text_revisions c WHERE tenant_id=? AND space_id=? AND project_id=? AND artifact_id=? AND content_revision=?",
          [
            record.scope.actor.principalId,
            ...base,
            String(q.artifactId),
            Number(request.contentRevision),
          ],
        )
      : undefined;
    const outline = await this.#get(
      client,
      "SELECT * FROM project_text_artifacts WHERE tenant_id=? AND space_id=? AND project_id=? AND kind='outline' AND episode_id=''",
      base,
    );
    return { head, revision, outline };
  }
  async #validateReceipt(
    client: PoolClient,
    record: ProjectTextUiIntent,
  ): Promise<ProjectTextUiIntent> {
    const receipt = await this.#receipt(client, record);
    if (record.phase === "accepted") {
      if (receipt === undefined) fail();
      return acceptedTextIntent(record, receipt);
    }
    if (receipt !== undefined) fail();
    return record;
  }
  async #accept(
    client: PoolClient,
    record: ProjectTextUiIntent,
    receipt: Record<string, unknown>,
    at: string,
  ) {
    const next = acceptedTextIntent(record, receipt, at);
    if (next !== record) await this.#update(client, record, next);
    return next;
  }
  async #receipt(client: PoolClient, record: ProjectTextUiIntent) {
    return this.#get(
      client,
      `SELECT * FROM project_text_mutation_receipts WHERE ${textIntentReceiptFilter}`,
      textIntentReceiptValues(textIntentIdentity(record)),
    );
  }
  async #project(client: PoolClient, scope: IntentInput<"stage">["scope"]) {
    const row = await this.#get(
      client,
      `SELECT * FROM creative_projects WHERE ${textIntentProjectFilter}`,
      textIntentProjectValues(scope),
    );
    const project = decodeCreativeProject(row, scope.actor, scope.projectId);
    if (project === null) throw new Error("creative_project_not_found");
    return project;
  }
  async #receiptLock(client: PoolClient, identity: TextIdentity) {
    await this.#lock(client, [
      "project-text-receipt",
      this.#schema,
      ...textIntentReceiptValues(identity),
    ]);
  }
  async #scopeLock(client: PoolClient, scope: IntentInput<"stage">["scope"]) {
    await this.#lock(client, [
      "project-text-ui-intent",
      this.#schema,
      textIntentScopeDigest(scope),
    ]);
  }
  async #projectLock(client: PoolClient, scope: IntentInput<"stage">["scope"]) {
    await this.#lock(client, [
      "creative-project-project",
      this.#schema,
      scope.actor.tenantId,
      scope.actor.spaceId,
      scope.projectId,
    ]);
  }
  async #lock(client: PoolClient, key: readonly string[]) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify(key),
    ]);
  }
  async #update(
    client: PoolClient,
    old: ProjectTextUiIntent,
    next: ProjectTextUiIntent,
  ) {
    const changed = await this.#query(
      client,
      "UPDATE project_text_ui_intents SET revision=?,phase=?,acknowledged=?,record_json=? WHERE intent_id=? AND revision=?",
      [
        next.revision,
        next.phase,
        next.acknowledgedAt === null ? 0 : 1,
        JSON.stringify(next),
        old.intentId,
        old.revision,
      ],
    );
    if (changed.rowCount !== 1) fail();
  }
  async #get(client: PoolClient, sql: string, values: unknown[] = []) {
    return (await this.#query(client, sql, values)).rows[0];
  }
  async #query(client: PoolClient, sql: string, values: unknown[] = []) {
    this.#assertOpen();
    let i = 0;
    const statement = sql
      .replace(
        /\b(creative_projects|project_text_ui_intents|project_text_mutation_receipts|project_text_artifacts|project_text_revisions)\b/gu,
        (name) => `${creativeProjectSchemaName(this.#schema)}.${name}`,
      )
      .replace(/\?/gu, () => `$${++i}`);
    const result = await client.query<Record<string, unknown>>(
      statement,
      values,
    );
    this.#assertOpen();
    return result;
  }
  async #transaction<T>(
    work: (client: PoolClient) => Promise<T>,
    active?: () => void,
    current?: () => Promise<void>,
  ): Promise<T> {
    this.#assertOpen();
    active?.();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await current?.();
      active?.();
      this.#assertOpen();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
