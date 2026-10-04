import type { PoolClient } from "pg";
import type { PluginCreditSettlementRecoveryScan } from "@crewon/application";
import { pluginCreditSchemaName } from "./plugin-credit-schema.ts";
import { assertPluginTaskAdmissionSchemaVersion } from "./plugin-task-admission-schema.ts";
import {
  PostgresPluginCreditSettlementSchemaCheck,
  type SettlementPostgresQuery,
} from "./postgres-plugin-credit-settlement-schema-check.ts";
import {
  buildSettlementRecoveryPage,
  parseSettlementRecoveryScan,
} from "./plugin-credit-settlement-recovery-records.ts";
import {
  assertPluginCreditSettlementRecoveryVersion,
  pluginCreditSettlementRecoverySchemaSql,
  recoveryIndexColumns,
  recoveryIndexName,
  recoveryMarkerName,
} from "./plugin-credit-settlement-recovery-schema.ts";

/** No connection acquisition or transaction nesting; the adapter retains physical ownership. */
export class PostgresPluginCreditSettlementRecovery {
  readonly #schema: string;
  readonly #prefix: string;
  readonly #query: SettlementPostgresQuery;
  readonly #checks: PostgresPluginCreditSettlementSchemaCheck;
  constructor(
    input: Readonly<{ schema: string; query: SettlementPostgresQuery }>,
  ) {
    this.#schema = input.schema;
    this.#prefix = `${pluginCreditSchemaName(input.schema)}.`;
    this.#query = input.query.bind(input);
    this.#checks = new PostgresPluginCreditSettlementSchemaCheck(input);
  }
  async migrate(client: PoolClient): Promise<void> {
    await this.#query(
      client,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [
        JSON.stringify([
          "plugin-credit-settlement-recovery-migration",
          this.#schema,
        ]),
      ],
    );
    await this.#installed(client);
    const present = await this.#query(
      client,
      `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) LIMIT 3`,
      [this.#schema, [recoveryMarkerName, recoveryIndexName]],
    );
    if (present.rows.length !== 0) {
      await this.#schemaCheck(client);
      return;
    }
    await this.#query(
      client,
      pluginCreditSettlementRecoverySchemaSql({
        dialect: "postgres",
        schema: this.#schema,
      }),
    );
    await this.#schemaCheck(client);
  }
  async scan(client: PoolClient, input: PluginCreditSettlementRecoveryScan) {
    const scan = parseSettlementRecoveryScan(input);
    await this.#installed(client);
    await this.#schemaCheck(client);
    const { sql, values } = postgresSettlementRecoveryQuery(this.#schema, scan);
    const rows = (await this.#query(client, sql, values)).rows;
    return buildSettlementRecoveryPage(scan, rows);
  }
  async #installed(client: PoolClient): Promise<void> {
    await this.#checks.assertPhysicalTables(
      client,
      ["plugin_task_admission_schema_version", "plugin_task_admissions"],
      "plugin_credit_settlement_recovery_schema_incomplete",
    );
    await this.#markerColumns(client, "plugin_task_admission_schema_version");
    // Compatible with ordinary admission inserts; excludes concurrent index/schema DDL.
    await this.#query(
      client,
      `LOCK TABLE ${this.#prefix}plugin_task_admissions IN SHARE UPDATE EXCLUSIVE MODE`,
    );
    const version = await this.#query<{ id: unknown; version: unknown }>(
      client,
      `SELECT id,version FROM ${this.#prefix}plugin_task_admission_schema_version LIMIT 2 FOR SHARE`,
    );
    assertPluginTaskAdmissionSchemaVersion(version.rows);
    const columns = await this.#query<{
      name: string;
      type: string;
      required: boolean;
    }>(
      client,
      `SELECT a.attname AS name,t.typname AS type,a.attnotnull AS required FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid WHERE n.nspname=$1 AND c.relname='plugin_task_admissions' AND a.attnum>0 AND NOT a.attisdropped`,
      [this.#schema],
    );
    if (
      recoveryIndexColumns.some(
        (name) =>
          columns.rows.filter(
            (row) => row.name === name && row.type === "text" && row.required,
          ).length !== 1,
      )
    )
      throw new Error("plugin_credit_settlement_recovery_schema_incomplete");
  }
  async #schemaCheck(client: PoolClient): Promise<void> {
    await this.#checks.assertPhysicalTables(
      client,
      [recoveryMarkerName],
      "plugin_credit_settlement_recovery_schema_incomplete",
    );
    await this.#markerColumns(client, recoveryMarkerName);
    const version = await this.#query<{ id: unknown; version: unknown }>(
      client,
      `SELECT id,version FROM ${this.#prefix}${recoveryMarkerName} LIMIT 2 FOR SHARE`,
    );
    assertPluginCreditSettlementRecoveryVersion(version.rows);
    await this.#index(client);
  }
  async #markerColumns(client: PoolClient, name: string): Promise<void> {
    const columns = await this.#query<{
      name: string;
      type: string;
      required: boolean;
      primary: boolean;
    }>(
      client,
      `SELECT a.attname AS name,t.typname AS type,a.attnotnull AS required,EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p' AND k.conkey=ARRAY[a.attnum]::smallint[]) AS primary
       FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
       WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [this.#schema, name],
    );
    if (
      columns.rows.length !== 2 ||
      columns.rows[0]?.name !== "id" ||
      columns.rows[0]?.type !== "int4" ||
      !columns.rows[0]?.required ||
      !columns.rows[0]?.primary ||
      columns.rows[1]?.name !== "version" ||
      columns.rows[1]?.type !== "int4" ||
      !columns.rows[1]?.required
    )
      throw new Error("plugin_credit_settlement_recovery_schema_incomplete");
  }
  async #index(client: PoolClient): Promise<void> {
    const indexes = await this.#query<{
      kind: string;
      table_schema: string;
      table_name: string;
      method: string;
      valid: boolean;
      ready: boolean;
      live: boolean;
      unique: boolean;
      primary: boolean;
      simple: boolean;
      complete: boolean;
      keys: number;
      total: number;
      columns: string[];
      collations: string[];
      collation_schemas: string[];
      directions: number[];
      opclasses: string[];
      opclass_schemas: string[];
      opclass_inputs: boolean[];
    }>(
      client,
      `SELECT x.relkind AS kind,tn.nspname AS table_schema,t.relname AS table_name,am.amname AS method,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,i.indisunique AS unique,i.indisprimary AS primary,i.indexprs IS NULL AS simple,i.indpred IS NULL AS complete,i.indnkeyatts AS keys,i.indnatts AS total,
         ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(i.indkey) WITH ORDINALITY k(id,pos) JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.id ORDER BY k.pos) AS columns,
         ARRAY(SELECT co.collname::text FROM pg_catalog.unnest(i.indcollation) WITH ORDINALITY k(id,pos) JOIN pg_catalog.pg_collation co ON co.oid=k.id ORDER BY k.pos) AS collations,
         ARRAY(SELECT cn.nspname::text FROM pg_catalog.unnest(i.indcollation) WITH ORDINALITY k(id,pos) JOIN pg_catalog.pg_collation co ON co.oid=k.id JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace ORDER BY k.pos) AS collation_schemas,
         ARRAY(SELECT value::integer FROM pg_catalog.unnest(i.indoption) WITH ORDINALITY k(value,pos) ORDER BY k.pos) AS directions,
         ARRAY(SELECT op.opcname::text FROM pg_catalog.unnest(i.indclass) WITH ORDINALITY k(id,pos) JOIN pg_catalog.pg_opclass op ON op.oid=k.id ORDER BY k.pos) AS opclasses,
         ARRAY(SELECT pn.nspname::text FROM pg_catalog.unnest(i.indclass) WITH ORDINALITY k(id,pos) JOIN pg_catalog.pg_opclass op ON op.oid=k.id JOIN pg_catalog.pg_namespace pn ON pn.oid=op.opcnamespace ORDER BY k.pos) AS opclass_schemas,
         ARRAY(SELECT op.opcintype='pg_catalog.text'::regtype AND op.opcmethod=am.oid FROM pg_catalog.unnest(i.indclass) WITH ORDINALITY k(id,pos) JOIN pg_catalog.pg_opclass op ON op.oid=k.id ORDER BY k.pos) AS opclass_inputs
       FROM pg_catalog.pg_class x JOIN pg_catalog.pg_namespace n ON n.oid=x.relnamespace JOIN pg_catalog.pg_index i ON i.indexrelid=x.oid
       JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.relnamespace JOIN pg_catalog.pg_am am ON am.oid=x.relam
       WHERE n.nspname=$1 AND x.relname=$2 LIMIT 2`,
      [this.#schema, recoveryIndexName],
    );
    const index = indexes.rows[0];
    if (
      indexes.rows.length !== 1 ||
      index === undefined ||
      index.kind !== "i" ||
      index.table_schema !== this.#schema ||
      index.table_name !== "plugin_task_admissions" ||
      index.method !== "btree" ||
      !index.valid ||
      !index.ready ||
      !index.live ||
      index.unique ||
      index.primary ||
      !index.simple ||
      !index.complete ||
      index.keys !== 4 ||
      index.total !== 4 ||
      index.columns.join(",") !== recoveryIndexColumns.join(",") ||
      index.collations.length !== 4 ||
      index.collations.some((value) => value !== "C") ||
      index.collation_schemas.length !== 4 ||
      index.collation_schemas.some((value) => value !== "pg_catalog") ||
      index.directions.length !== 4 ||
      index.directions.some((value) => value !== 0) ||
      index.opclasses.length !== 4 ||
      index.opclasses.some((value) => value !== "text_ops") ||
      index.opclass_schemas.length !== 4 ||
      index.opclass_schemas.some((value) => value !== "pg_catalog") ||
      index.opclass_inputs.length !== 4 ||
      index.opclass_inputs.some((value) => value !== true)
    )
      throw new Error("plugin_credit_settlement_recovery_schema_incomplete");
  }
}

export function postgresSettlementRecoveryQuery(
  schema: string,
  input: PluginCreditSettlementRecoveryScan,
): Readonly<{ sql: string; values: (string | number)[] }> {
  const scan = parseSettlementRecoveryScan(input);
  const values: (string | number)[] = [
    scan.scope.tenantId,
    scan.scope.spaceId,
    scan.scope.profileId,
  ];
  let cursor = "";
  if (scan.afterRunId !== null) {
    cursor = ' AND run_id COLLATE "C">$4::text COLLATE "C"';
    values.push(scan.afterRunId);
  }
  values.push(scan.limit + 1);
  return {
    sql: `SELECT tenant_id,space_id,profile_id,run_id FROM ${pluginCreditSchemaName(schema)}.plugin_task_admissions
    WHERE tenant_id COLLATE "C"=$1::text COLLATE "C" AND space_id COLLATE "C"=$2::text COLLATE "C" AND profile_id COLLATE "C"=$3::text COLLATE "C"${cursor}
    ORDER BY run_id COLLATE "C" ASC LIMIT $${values.length}`,
    values,
  };
}
