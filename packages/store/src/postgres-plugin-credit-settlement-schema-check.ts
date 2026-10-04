import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { pluginCreditSchemaName } from "./plugin-credit-schema.ts";
import { assertPluginCreditSettlementSchemaVersion } from "./plugin-credit-settlement-schema.ts";

type Row = Record<string, unknown>;
export type SettlementPostgresQuery = <T extends QueryResultRow = Row>(
  client: PoolClient,
  sql: string,
  values?: unknown[],
) => Promise<QueryResult<T>>;

/** Shares the owner's exact transaction and query fence; construction performs no SQL. */
export class PostgresPluginCreditSettlementSchemaCheck {
  readonly #schema: string;
  readonly #prefix: string;
  readonly #query: SettlementPostgresQuery;
  constructor(
    input: Readonly<{ schema: string; query: SettlementPostgresQuery }>,
  ) {
    this.#schema = input.schema;
    this.#prefix = `${pluginCreditSchemaName(input.schema)}.`;
    this.#query = input.query.bind(input);
  }

  async assertVersion(client: PoolClient): Promise<void> {
    const tables = [
      "plugin_credit_settlement_schema_version",
      "plugin_credit_settlement_finalizations",
    ];
    await this.assertPhysicalTables(
      client,
      tables,
      "plugin_credit_settlement_schema_incomplete",
    );
    const columns = await this.#query<{
      table_name: string;
      name: string;
      type: string;
      required: boolean;
    }>(
      client,
      `SELECT c.relname AS table_name,a.attname AS name,t.typname AS type,a.attnotnull AS required
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
       JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped
       ORDER BY c.relname,a.attnum`,
      [this.#schema, tables],
    );
    const expected = {
      plugin_credit_settlement_schema_version: { id: "int4", version: "int4" },
      plugin_credit_settlement_finalizations: {
        tenant_id: "text",
        run_id: "text",
        authority_id: "text",
        decision_id: "text",
        evidence_digest: "text",
        record_json: "jsonb",
      },
    };
    for (const table of tables) {
      const fields = expected[table as keyof typeof expected] as Record<
        string,
        string
      >;
      const actual = columns.rows.filter((row) => row.table_name === table);
      if (
        actual.length !== Object.keys(fields).length ||
        actual.some((row) => fields[row.name] !== row.type || !row.required)
      )
        throw new Error("plugin_credit_settlement_schema_incomplete");
    }
    const trigger = await this.#query<{
      type: number;
      enabled: string;
      function_name: string;
      function_schema: string;
      arguments: number;
      body: string;
    }>(
      client,
      `SELECT g.tgtype AS type,g.tgenabled AS enabled,p.proname AS function_name,pn.nspname AS function_schema,p.pronargs AS arguments,p.prosrc AS body
       FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid=g.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_catalog.pg_proc p ON p.oid=g.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
       WHERE n.nspname=$1 AND c.relname='plugin_credit_settlement_finalizations'
         AND g.tgname='plugin_credit_settlement_no_update_or_delete' AND NOT g.tgisinternal`,
      [this.#schema],
    );
    const guard = trigger.rows[0];
    if (
      trigger.rows.length !== 1 ||
      guard === undefined ||
      guard.type !== 27 ||
      guard.enabled !== "O" ||
      guard.function_name !== "plugin_credit_settlement_immutable" ||
      guard.function_schema !== this.#schema ||
      guard.arguments !== 0 ||
      typeof guard.body !== "string" ||
      guard.body.replaceAll(/\s/gu, "") !==
        "BEGINRAISEEXCEPTION'plugin_credit_settlement_immutable';END"
    )
      throw new Error("plugin_credit_settlement_schema_incomplete");
    await this.#assertConstraints(client);
    const result = await this.#query<{ id: unknown; version: unknown }>(
      client,
      `SELECT id,version FROM ${this.#prefix}plugin_credit_settlement_schema_version LIMIT 2 FOR SHARE`,
    );
    assertPluginCreditSettlementSchemaVersion(result.rows);
  }

  async assertEvidenceTables(client: PoolClient): Promise<void> {
    const names = [
      "extension_credit_schema_version",
      "extension_credit_admissions",
      "plugin_credit_schema_version",
      "plugin_credit_accounts",
      "plugin_credit_reservations",
      "plugin_credit_entries",
      "extension_run_bindings",
      "extension_mutation_receipts",
      "run_snapshots",
      "run_thread_bindings",
      "extension_external_operations",
      "tool_execution_receipts",
      "run_steps",
      "run_attempts",
      "work_items",
    ];
    await this.assertPhysicalTables(
      client,
      names,
      "plugin_credit_settlement_schema_incomplete",
    );
  }

  async assertPhysicalTables(
    client: PoolClient,
    names: readonly string[],
    errorCode: string,
  ): Promise<void> {
    const assertCatalog = async () => {
      const catalog = await this.#query<{ name: string; kind: string }>(
        client,
        `SELECT c.relname AS name,c.relkind AS kind FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) LIMIT $3`,
        [this.#schema, names, names.length + 1],
      );
      if (
        catalog.rows.length !== names.length ||
        names.some(
          (name) =>
            catalog.rows.filter((row) => row.name === name).length !== 1,
        ) ||
        catalog.rows.some((row) => row.kind !== "r")
      )
        throw new Error(errorCode);
    };
    await assertCatalog();
    // Hold relation identity against concurrent rename/drop/view replacement;
    // ordinary row writers remain compatible with ACCESS SHARE.
    await this.#query(
      client,
      `LOCK TABLE ${names.map((name) => `${this.#prefix}${name}`).join(",")} IN ACCESS SHARE MODE`,
    );
    await assertCatalog();
  }

  async #assertConstraints(client: PoolClient): Promise<void> {
    const result = await this.#query<{
      table_name: string;
      kind: string;
      columns: string[];
      reference_schema: string | null;
      reference_table: string | null;
      reference_columns: string[];
      delete_action: string;
    }>(
      client,
      `SELECT c.relname AS table_name,k.contype AS kind,
         ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY AS key(id,position)
           JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=key.id ORDER BY key.position) AS columns,
         rn.nspname AS reference_schema,rc.relname AS reference_table,
         ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(k.confkey) WITH ORDINALITY AS key(id,position)
           JOIN pg_catalog.pg_attribute a ON a.attrelid=rc.oid AND a.attnum=key.id ORDER BY key.position) AS reference_columns,
         k.confdeltype AS delete_action
       FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       LEFT JOIN pg_catalog.pg_class rc ON rc.oid=k.confrelid LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid=rc.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND k.contype IN ('p','u','f')`,
      [
        this.#schema,
        [
          "plugin_credit_settlement_schema_version",
          "plugin_credit_settlement_finalizations",
        ],
      ],
    );
    const marker = result.rows.filter(
      (row) => row.table_name === "plugin_credit_settlement_schema_version",
    );
    const finalizations = result.rows.filter(
      (row) => row.table_name === "plugin_credit_settlement_finalizations",
    );
    if (
      marker.length !== 1 ||
      marker[0]?.kind !== "p" ||
      marker[0].columns.join(",") !== "id" ||
      finalizations.length !== 3 ||
      !finalizations.some(
        (row) =>
          row.kind === "p" && row.columns.join(",") === "tenant_id,run_id",
      ) ||
      !finalizations.some(
        (row) =>
          row.kind === "u" &&
          row.columns.join(",") === "authority_id,decision_id",
      ) ||
      !finalizations.some(
        (row) =>
          row.kind === "f" &&
          row.columns.join(",") === "tenant_id,run_id" &&
          row.reference_schema === this.#schema &&
          row.reference_table === "extension_credit_admissions" &&
          row.reference_columns.join(",") === "tenant_id,run_id" &&
          row.delete_action === "r",
      )
    )
      throw new Error("plugin_credit_settlement_schema_incomplete");
  }
}
