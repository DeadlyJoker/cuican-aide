import type { DatabaseSync } from "node:sqlite";
import type {
  PluginCreditAccountListInput,
  PluginCreditEntriesReadInput,
} from "@crewon/application";
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

/** Shares the actual parent connection; reads do not migrate, acquire writer locks, or create accounts. */
export class SqlitePluginCreditRead {
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  constructor(input: { database: DatabaseSync; assertOpen(): void }) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
  }
  listAccounts(input: PluginCreditAccountListInput) {
    const query = creditAccountListInput(input);
    return this.#snapshot(() => {
      if (!this.#schema()) return creditAccountsUnconfigured;
      const cursor =
        query.afterPoolId === null ? "" : " AND pool_id COLLATE BINARY>?";
      const values: (string | number)[] = [query.tenantId, query.principalId];
      if (query.afterPoolId !== null) values.push(query.afterPoolId);
      values.push(query.limit + 1);
      return creditAccountsReadPage(
        query,
        this.#all(
          `SELECT tenant_id,principal_id,pool_id,revision,account_json FROM main.plugin_credit_accounts WHERE tenant_id COLLATE BINARY=? AND principal_id COLLATE BINARY=?${cursor} ORDER BY pool_id COLLATE BINARY ASC LIMIT ?`,
          values,
        ),
      );
    });
  }
  readEntries(input: PluginCreditEntriesReadInput) {
    const query = creditEntriesReadInput(input);
    return this.#snapshot(() => {
      if (!this.#schema()) return creditEntriesUnconfigured;
      const account = decodeCreditAccount(
        this.#all(
          "SELECT revision,account_json FROM main.plugin_credit_accounts WHERE tenant_id=? AND principal_id=? AND pool_id=?",
          [...creditScopeValues(query.scope)],
        )[0] as { revision: unknown; account_json: unknown } | undefined,
        query.scope,
      );
      const rows = this.#all(
        "SELECT revision,entry_json FROM main.plugin_credit_entries WHERE tenant_id=? AND principal_id=? AND pool_id=? AND revision>? AND revision<=? ORDER BY revision ASC LIMIT ?",
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
  #schema(): boolean {
    const marks = creditReadNames.map(() => "?").join(",");
    const catalog = this.#all(
      `SELECT name,type,'main' AS source FROM main.sqlite_master WHERE name IN(${marks}) UNION ALL SELECT name,type,'temp' AS source FROM temp.sqlite_master WHERE name IN(${marks}) LIMIT ?`,
      [...creditReadNames, ...creditReadNames, creditReadNames.length + 1],
    );
    if (catalog.length === 0) return false;
    if (
      catalog.length !== creditReadNames.length ||
      creditReadNames.some(
        (name) =>
          catalog.filter(
            (row) =>
              row.name === name &&
              row.type === "table" &&
              row.source === "main",
          ).length !== 1,
      )
    )
      creditReadFailure();
    const tables = this.#all("PRAGMA main.table_list");
    for (const name of creditReadNames) {
      if (
        tables.find((row) => row.name === name && row.schema === "main")
          ?.strict !== 1
      )
        creditReadFailure();
      const columns = this.#all(`PRAGMA main.table_xinfo('${name}')`),
        fields = Object.entries(creditReadTables[name]),
        keys: readonly string[] = creditReadPrimaryKeys[name];
      if (
        columns.length !== fields.length ||
        columns.some(
          (row, index) =>
            row.name !== fields[index]?.[0] ||
            row.type !==
              (fields[index]?.[1] === "integer" ? "INTEGER" : "TEXT") ||
            row.hidden !== 0 ||
            row.pk !== Math.max(0, keys.indexOf(String(row.name)) + 1) ||
            row.notnull !==
              (name === "plugin_credit_schema_version" && row.name === "id"
                ? 0
                : 1),
        )
      )
        creditReadFailure();
      if (name === "plugin_credit_schema_version") continue;
      const indexes = this.#all(`PRAGMA main.index_list('${name}')`).filter(
        (row) => row.origin === "pk",
      );
      if (
        indexes.length !== 1 ||
        indexes[0]?.unique !== 1 ||
        indexes[0]?.partial !== 0 ||
        typeof indexes[0]?.name !== "string"
      )
        creditReadFailure();
      const indexName = String(indexes[0]!.name).replaceAll("'", "''");
      const indexKeys = this.#all(
        `PRAGMA main.index_xinfo('${indexName}')`,
      ).filter((row) => row.key === 1);
      if (
        indexKeys.length !== keys.length ||
        indexKeys.some(
          (row, position) =>
            row.seqno !== position ||
            row.name !== keys[position] ||
            row.coll !== "BINARY" ||
            row.desc !== 0,
        )
      )
        creditReadFailure();
    }
    creditReadVersion(
      this.#all(
        "SELECT id,version FROM main.plugin_credit_schema_version LIMIT 2",
      ),
    );
    return true;
  }
  #all(sql: string, values: (string | number | null)[] = []): CreditReadRow[] {
    this.#assertOpen();
    const rows = this.#database.prepare(sql).all(...values) as CreditReadRow[];
    this.#assertOpen();
    return rows;
  }
  #snapshot<T>(read: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN");
    try {
      const result = read();
      this.#assertOpen();
      this.#database.exec("COMMIT");
      this.#assertOpen();
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}
