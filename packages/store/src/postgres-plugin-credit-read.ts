import type { Pool, PoolClient } from "pg";
import type {
  PluginCreditAccountListInput,
  PluginCreditEntriesReadInput,
} from "@crewon/application";
import { pluginCreditSchemaName } from "./plugin-credit-schema.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import {
  creditScopeValues,
  decodeCreditAccount,
} from "./plugin-credit-support.ts";
import {
  creditAccountListInput,
  creditEntriesReadInput,
  creditAccountsReadPage,
  creditEntriesReadPage,
  creditAccountsUnconfigured,
  creditEntriesUnconfigured,
  creditReadFailure,
  creditReadNames,
  creditReadTables,
  creditReadPrimaryKeys,
  creditReadVersion,
  type CreditReadRow,
} from "./plugin-credit-read-support.ts";

/** One bounded, read-only MVCC snapshot; original ledger and owner stay in charge. */
export class PostgresPluginCreditRead {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #assertOpen: () => void;
  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    this.#prefix = `${pluginCreditSchemaName(input.schema)}.`;
    this.#assertOpen = input.assertOpen;
  }
  async listAccounts(input: PluginCreditAccountListInput) {
    const query = creditAccountListInput(input);
    return this.#snapshot(async (client) => {
      if (!(await this.#schemaReady(client))) return creditAccountsUnconfigured;
      // Preserve the original PK prefix on legacy locales; C fixes cursor ordering without a read-time migration.
      // A non-C pool index may require sorting within this exact personal prefix.
      const cursor =
        query.afterPoolId === null ? "" : ' AND pool_id COLLATE "C">$3';
      const values: (string | number)[] = [query.tenantId, query.principalId];
      if (query.afterPoolId !== null) values.push(query.afterPoolId);
      values.push(query.limit + 1);
      return creditAccountsReadPage(
        query,
        await this.#rows(
          client,
          `SELECT tenant_id,principal_id,pool_id,revision,account_json FROM ${this.#prefix}plugin_credit_accounts WHERE tenant_id=$1 AND principal_id=$2 AND tenant_id COLLATE "C"=$1 AND principal_id COLLATE "C"=$2${cursor} ORDER BY pool_id COLLATE "C" ASC LIMIT $${values.length}`,
          values,
        ),
      );
    });
  }
  async readEntries(input: PluginCreditEntriesReadInput) {
    const query = creditEntriesReadInput(input);
    return this.#snapshot(async (client) => {
      if (!(await this.#schemaReady(client))) return creditEntriesUnconfigured;
      const exactScope =
        'tenant_id=$1 AND principal_id=$2 AND pool_id=$3 AND tenant_id COLLATE "C"=$1 AND principal_id COLLATE "C"=$2 AND pool_id COLLATE "C"=$3';
      const account = decodeCreditAccount(
        (
          await this.#rows(
            client,
            `SELECT revision,account_json FROM ${this.#prefix}plugin_credit_accounts WHERE ${exactScope}`,
            [...creditScopeValues(query.scope)],
          )
        )[0] as { revision: unknown; account_json: unknown } | undefined,
        query.scope,
      );
      const rows = await this.#rows(
        client,
        `SELECT revision,entry_json FROM ${this.#prefix}plugin_credit_entries WHERE ${exactScope} AND revision>$4 AND revision<=$5 ORDER BY revision ASC LIMIT $6`,
        [
          ...creditScopeValues(query.scope),
          query.afterRevision,
          account?.revision ?? 2_147_483_647,
          query.limit + 1,
        ],
      );
      return creditEntriesReadPage(query, account, rows);
    });
  }
  async #schemaReady(client: PoolClient): Promise<boolean> {
    const catalogSql = `SELECT c.relname AS name,c.relkind AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) LIMIT $3`;
    const parameters = [
      this.#schema,
      creditReadNames,
      creditReadNames.length + 1,
    ];
    const catalog = await this.#rows(client, catalogSql, parameters);
    if (catalog.length === 0) return false;
    const assertTables = (rows: readonly CreditReadRow[]) => {
      if (
        rows.length !== creditReadNames.length ||
        creditReadNames.some(
          (name) =>
            rows.filter((row) => row.name === name && row.kind === "r")
              .length !== 1,
        )
      )
        creditReadFailure();
    };
    assertTables(catalog);
    await this.#rows(
      client,
      `LOCK TABLE ${creditReadNames.map((name) => `${this.#prefix}${name}`).join(",")} IN ACCESS SHARE MODE`,
    );
    assertTables(await this.#rows(client, catalogSql, parameters));
    const columns = await this.#rows(
      client,
      `SELECT c.relname AS table_name,a.attname AS name,t.typname AS type,a.attnotnull AS required,a.attnum AS position FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid JOIN pg_catalog.pg_type t ON t.oid=a.atttypid WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,
      [this.#schema, creditReadNames],
    );
    const primaryKeys = await this.#rows(
      client,
      `SELECT c.relname AS table_name,i.indisvalid AS valid,i.indisready AS ready,i.indnkeyatts AS key_count,
      ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(i.indkey) WITH ORDINALITY AS key(id,position) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=key.id ORDER BY key.position) AS columns
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_index i ON i.indrelid=c.oid WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND i.indisprimary`,
      [this.#schema, creditReadNames],
    );
    for (const name of creditReadNames) {
      const fields = Object.entries(creditReadTables[name]),
        actual = columns.filter((row) => row.table_name === name);
      if (
        actual.length !== fields.length ||
        actual.some(
          (row, position) =>
            row.name !== fields[position]?.[0] ||
            row.position !== position + 1 ||
            row.type !==
              (fields[position]?.[1] === "integer"
                ? name === "plugin_credit_schema_version"
                  ? "int4"
                  : "int8"
                : fields[position]?.[1] === "json"
                  ? "jsonb"
                  : "text") ||
            row.required !== true,
        )
      )
        creditReadFailure();
      const keys = primaryKeys.filter((row) => row.table_name === name),
        expected = creditReadPrimaryKeys[name];
      if (
        keys.length !== 1 ||
        keys[0]?.valid !== true ||
        keys[0]?.ready !== true ||
        keys[0]?.key_count !== expected.length ||
        !Array.isArray(keys[0]?.columns) ||
        keys[0].columns.join(",") !== expected.join(",")
      )
        creditReadFailure();
    }
    creditReadVersion(
      await this.#rows(
        client,
        `SELECT id,version FROM ${this.#prefix}plugin_credit_schema_version LIMIT 2`,
      ),
    );
    return true;
  }
  async #rows(
    client: PoolClient,
    sql: string,
    values: unknown[] = [],
  ): Promise<CreditReadRow[]> {
    this.#assertOpen();
    const result = await client.query(sql, values);
    this.#assertOpen();
    return result.rows as CreditReadRow[];
  }
  async #snapshot<T>(read: (client: PoolClient) => Promise<T>): Promise<T> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      this.#assertOpen();
      await this.#rows(
        client,
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const result = await read(client);
      this.#assertOpen();
      await client.query("COMMIT");
      this.#assertOpen();
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
