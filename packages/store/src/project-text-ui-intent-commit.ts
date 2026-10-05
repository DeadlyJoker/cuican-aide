import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { ProjectTextUiCommitTransactionAuthority } from "@crewon/application";
import { type ProjectTextUiIntent } from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertSqliteTextIntentSchema,
  assertPostgresTextIntentSchema,
} from "./project-text-ui-intent-schema.ts";
import {
  acceptedTextIntent,
  assertTextIntentCommand,
  decodeTextIntent,
  fail,
  textIntentIdentity,
  textIntentReceiptFilter,
  textIntentReceiptValues,
  textIntentScopeDigest,
} from "./project-text-ui-intent-support.ts";
import type { TextIdentity } from "./project-text-store-support.ts";

/** A journal locator supplies no authority. Every write/replay remains bound to the original captured invocation. */
function qualified(
  record: ProjectTextUiIntent | null,
  q: ProjectTextUiCommitTransactionAuthority | undefined,
  identity: TextIdentity,
): ProjectTextUiIntent | null {
  if (record === null) {
    if (q?.intentRef !== undefined) fail();
    return null;
  }
  if (q === undefined || q.intentRef === undefined)
    throw new Error("project_text_ui_intent_authority_required");
  assertTextIntentCommand(record, q, identity);
  if (record.phase === "refused")
    throw new Error("project_text_ui_intent_refused");
  return record;
}
export function beginSqliteTextIntentCommit(
  db: DatabaseSync,
  q: ProjectTextUiCommitTransactionAuthority | undefined,
  identity: TextIdentity,
): ProjectTextUiIntent | null {
  if (!assertSqliteTextIntentSchema(db, true)) {
    if (q?.intentRef !== undefined) fail();
    return null;
  }
  return qualified(
    decodeTextIntent(
      db
        .prepare(
          `SELECT * FROM project_text_ui_intents WHERE ${textIntentReceiptFilter}`,
        )
        .get(...textIntentReceiptValues(identity)),
    ),
    q,
    identity,
  );
}
export function finishSqliteTextIntentCommit(
  db: DatabaseSync,
  record: ProjectTextUiIntent | null,
): void {
  if (record === null) return;
  const row = db
    .prepare(
      `SELECT * FROM project_text_mutation_receipts WHERE ${textIntentReceiptFilter}`,
    )
    .get(...textIntentReceiptValues(textIntentIdentity(record)));
  const next = acceptedTextIntent(record, row);
  if (next === record) return;
  const result = db
    .prepare(
      "UPDATE project_text_ui_intents SET revision=?,phase=?,record_json=? WHERE intent_id=? AND revision=?",
    )
    .run(
      next.revision,
      next.phase,
      JSON.stringify(next),
      record.intentId,
      record.revision,
    );
  if (result.changes !== 1) fail();
}
/** Receipt-key lock first matches the original text Store; no journal/account→receipt inversion. */
export async function beginPostgresTextIntentCommit(
  client: PoolClient,
  schema: string,
  q: ProjectTextUiCommitTransactionAuthority | undefined,
  identity: TextIdentity,
): Promise<ProjectTextUiIntent | null> {
  if (!(await assertPostgresTextIntentSchema(client, schema, true))) {
    if (q?.intentRef !== undefined) fail();
    return null;
  }
  const p = `${creativeProjectSchemaName(schema)}.`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "project-text-receipt",
      schema,
      ...textIntentReceiptValues(identity),
    ]),
  ]);
  // Read immutable identity before acquiring its scope lock; re-read mutable state after the lock.
  const first = decodeTextIntent(
    (
      await client.query(
        `SELECT * FROM ${p}project_text_ui_intents WHERE ${pgFilter()}`,
        textIntentReceiptValues(identity),
      )
    ).rows[0],
  );
  if (first === null) {
    if (q?.intentRef !== undefined) fail();
    return null;
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "project-text-ui-intent",
      schema,
      textIntentScopeDigest(first.scope),
    ]),
  ]);
  return qualified(
    decodeTextIntent(
      (
        await client.query(
          `SELECT * FROM ${p}project_text_ui_intents WHERE ${pgFilter()} FOR UPDATE`,
          textIntentReceiptValues(identity),
        )
      ).rows[0],
    ),
    q,
    identity,
  );
}
export async function finishPostgresTextIntentCommit(
  client: PoolClient,
  schema: string,
  record: ProjectTextUiIntent | null,
): Promise<void> {
  if (record === null) return;
  const p = `${creativeProjectSchemaName(schema)}.`;
  const row = (
    await client.query(
      `SELECT * FROM ${p}project_text_mutation_receipts WHERE ${pgFilter()}`,
      textIntentReceiptValues(textIntentIdentity(record)),
    )
  ).rows[0];
  const next = acceptedTextIntent(record, row);
  if (next === record) return;
  const result = await client.query(
    `UPDATE ${p}project_text_ui_intents SET revision=$1,phase=$2,record_json=$3 WHERE intent_id=$4 AND revision=$5`,
    [
      next.revision,
      next.phase,
      JSON.stringify(next),
      record.intentId,
      record.revision,
    ],
  );
  if (result.rowCount !== 1) fail();
}
function pgFilter(): string {
  let i = 0;
  return textIntentReceiptFilter.replace(/\?/gu, () => `$${++i}`);
}
