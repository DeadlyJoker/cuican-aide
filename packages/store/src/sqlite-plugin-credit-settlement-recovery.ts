import type { DatabaseSync } from "node:sqlite";
import type { PluginCreditSettlementRecoveryScan } from "@crewon/application";
import { assertPluginTaskAdmissionSchemaVersion } from "./plugin-task-admission-schema.ts";
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

type Row = Record<string, unknown>;
const installedNames = [
  "plugin_task_admission_schema_version",
  "plugin_task_admissions",
];

/** Synchronous helper borrowing the adapter's original BEGIN/COMMIT and owner fence. */
export class SqlitePluginCreditSettlementRecovery {
  readonly #database: DatabaseSync;
  readonly #assertCurrent: () => void;
  constructor(
    input: Readonly<{ database: DatabaseSync; assertCurrent(): void }>,
  ) {
    this.#database = input.database;
    this.#assertCurrent = input.assertCurrent.bind(input);
  }
  migrate(): void {
    this.#installed();
    if (this.#catalog([recoveryMarkerName, recoveryIndexName]).length !== 0) {
      this.#schema();
      return;
    }
    this.#assertCurrent();
    this.#database.exec(
      pluginCreditSettlementRecoverySchemaSql({ dialect: "sqlite" }),
    );
    this.#assertCurrent();
    this.#schema();
  }
  scan(input: PluginCreditSettlementRecoveryScan) {
    const scan = parseSettlementRecoveryScan(input);
    this.#installed();
    this.#schema();
    const { sql, values } = sqliteSettlementRecoveryQuery(scan);
    return buildSettlementRecoveryPage(scan, this.#all(sql, values));
  }
  #installed(): void {
    this.#tables(installedNames);
    this.#markerColumns("plugin_task_admission_schema_version");
    assertPluginTaskAdmissionSchemaVersion(
      this.#all(
        "SELECT id,version FROM main.plugin_task_admission_schema_version LIMIT 2",
      ) as { id: unknown; version: unknown }[],
    );
    const columns = this.#all(
      "PRAGMA main.table_info('plugin_task_admissions')",
    );
    if (
      recoveryIndexColumns.some(
        (name) =>
          columns.filter(
            (column) =>
              column.name === name &&
              column.type === "TEXT" &&
              column.notnull === 1,
          ).length !== 1,
      )
    )
      throw new Error("plugin_credit_settlement_recovery_schema_incomplete");
  }
  #schema(): void {
    this.#tables([recoveryMarkerName]);
    const catalog = this.#catalog([recoveryIndexName]);
    if (
      catalog.length !== 1 ||
      catalog[0]?.source !== "main" ||
      catalog[0]?.type !== "index"
    )
      throw new Error("plugin_credit_settlement_recovery_schema_incomplete");
    this.#markerColumns(recoveryMarkerName);
    assertPluginCreditSettlementRecoveryVersion(
      this.#all(
        `SELECT id,version FROM main.${recoveryMarkerName} LIMIT 2`,
      ) as { id: unknown; version: unknown }[],
    );
    const index = this.#all(
      "PRAGMA main.index_list('plugin_task_admissions')",
    ).filter((row) => row.name === recoveryIndexName);
    const keys = this.#all(
      `PRAGMA main.index_xinfo('${recoveryIndexName}')`,
    ).filter((row) => row.key === 1);
    if (
      index.length !== 1 ||
      index[0]?.unique !== 0 ||
      index[0]?.partial !== 0 ||
      keys.length !== 4 ||
      keys.some(
        (row, position) =>
          row.seqno !== position ||
          row.name !== recoveryIndexColumns[position] ||
          row.coll !== "BINARY" ||
          row.desc !== 0,
      )
    )
      throw new Error("plugin_credit_settlement_recovery_schema_incomplete");
  }
  #markerColumns(name: string): void {
    const columns = this.#all(`PRAGMA main.table_info('${name}')`);
    if (
      columns.length !== 2 ||
      columns[0]?.name !== "id" ||
      columns[0]?.type !== "INTEGER" ||
      columns[0]?.pk !== 1 ||
      columns[1]?.name !== "version" ||
      columns[1]?.type !== "INTEGER" ||
      columns[1]?.notnull !== 1
    )
      throw new Error("plugin_credit_settlement_recovery_schema_incomplete");
    const table = this.#all("PRAGMA main.table_list").find(
      (row) => row.name === name && row.schema === "main",
    );
    if (table?.strict !== 1)
      throw new Error("plugin_credit_settlement_recovery_schema_incomplete");
  }
  #tables(names: readonly string[]): void {
    const rows = this.#catalog(names);
    if (
      rows.length !== names.length ||
      names.some(
        (name) =>
          rows.filter(
            (row) =>
              row.name === name &&
              row.type === "table" &&
              row.source === "main",
          ).length !== 1,
      )
    )
      throw new Error("plugin_credit_settlement_recovery_schema_incomplete");
  }
  #catalog(names: readonly string[]): Row[] {
    const placeholders = names.map(() => "?").join(",");
    return this.#all(
      `SELECT name,type,'main' AS source FROM main.sqlite_master WHERE name IN(${placeholders})
      UNION ALL SELECT name,type,'temp' AS source FROM temp.sqlite_master WHERE name IN(${placeholders}) LIMIT ?`,
      [...names, ...names, names.length + 1],
    );
  }
  #all(sql: string, values: (string | number | null)[] = []): Row[] {
    this.#assertCurrent();
    const rows = this.#database.prepare(sql).all(...values) as Row[];
    this.#assertCurrent();
    return rows;
  }
}

export function sqliteSettlementRecoveryQuery(
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
    cursor = " AND run_id COLLATE BINARY > ?";
    values.push(scan.afterRunId);
  }
  values.push(scan.limit + 1);
  return {
    sql: `SELECT tenant_id,space_id,profile_id,run_id FROM main.plugin_task_admissions INDEXED BY ${recoveryIndexName}
    WHERE tenant_id COLLATE BINARY=? AND space_id COLLATE BINARY=? AND profile_id COLLATE BINARY=?${cursor}
    ORDER BY run_id COLLATE BINARY ASC LIMIT ?`,
    values,
  };
}
