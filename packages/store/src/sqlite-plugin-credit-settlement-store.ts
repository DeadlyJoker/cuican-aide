import type { DatabaseSync } from "node:sqlite";
import type {
  PluginCreditSettlementCommitResult,
  PluginCreditSettlementFinalization,
  PluginCreditSettlementLocator,
  PluginCreditSettlementStore,
} from "@crewon/application";
import {
  releaseCreditReservation,
  settleCreditReservation,
} from "@crewon/domain";
import {
  assertExtensionCreditSchemaVersion,
  decodeExtensionCreditAdmission,
} from "./extension-credit-admission-records.ts";
import { creditEntry, creditScopeValues } from "./plugin-credit-support.ts";
import { loadSqlitePluginTask } from "./plugin-task-admission-store-support.ts";
import { assertPluginTaskAdmissionSchemaVersion } from "./plugin-task-admission-schema.ts";
import {
  assertPluginCreditSettlementSchemaVersion,
  pluginCreditSettlementSchemaSql,
} from "./plugin-credit-settlement-schema.ts";
import {
  SETTLEMENT_COLLECTION_LIMIT,
  assertSettlementReplay,
  buildSettlementSnapshot,
  createSettlementFinalization,
  parseSettlementDecision,
  parseSettlementFinalization,
  parseSettlementLocator,
  type SettlementEvidenceRows,
} from "./plugin-credit-settlement-records.ts";

type Row = Record<string, unknown>;
const settlementTables = [
  "plugin_credit_settlement_schema_version",
  "plugin_credit_settlement_finalizations",
] as const;
const admissionTables = [
  "extension_credit_schema_version",
  "extension_credit_admissions",
] as const;
const creditTables = [
  "plugin_credit_schema_version",
  "plugin_credit_accounts",
  "plugin_credit_reservations",
  "plugin_credit_entries",
] as const;
const installedAdmissionTables = [
  "plugin_task_admission_schema_version",
  "plugin_task_admissions",
] as const;

/** Borrows the original host connection. Construction grants no money or authority. */
export class SqlitePluginCreditSettlementStore
  implements PluginCreditSettlementStore
{
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;

  constructor(input: Readonly<{ database: DatabaseSync; assertOpen(): void }>) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
  }

  async migrate(): Promise<void> {
    this.#transaction(() => {
      if (this.#tables(settlementTables)) this.#settlementVersion();
      this.#database.exec(
        pluginCreditSettlementSchemaSql({ dialect: "sqlite" }),
      );
      this.#settlementSchema();
    });
  }

  async loadEvidence(input: PluginCreditSettlementLocator) {
    const locator = parseSettlementLocator(input);
    return this.#transaction(() => {
      this.#settlementSchema();
      return this.#snapshot(locator)?.evidence ?? null;
    });
  }

  async getFinalization(input: PluginCreditSettlementLocator) {
    const locator = parseSettlementLocator(input);
    return this.#transaction(() => {
      this.#settlementSchema();
      return this.#finalization(locator);
    });
  }

  async finalize(
    input: Parameters<PluginCreditSettlementStore["finalize"]>[0],
  ): Promise<PluginCreditSettlementCommitResult> {
    const captured = captureFinalizationInput(input);
    const locator = parseSettlementLocator(captured.locator);
    const decision = parseSettlementDecision(captured.decision);
    return this.#transaction(() => {
      this.#settlementSchema();
      const saved = this.#finalization(locator);
      if (saved !== null) {
        assertSettlementReplay(saved, decision);
        return { disposition: "replayed", finalization: saved };
      }
      const snapshot = this.#snapshot(locator);
      if (snapshot === null)
        throw new Error("plugin_credit_settlement_admission_required");
      if (snapshot.reservation.state !== "reserved")
        throw new Error(
          "plugin_credit_settlement_unbound_terminal_reservation",
        );
      if (snapshot.evidence.evidenceDigest !== decision.evidenceDigest)
        return { disposition: "evidence_changed" };
      if (!snapshot.evidence.readyToFinalize)
        return { disposition: "not_ready" };
      const reused = this.#database
        .prepare(
          `SELECT tenant_id,run_id FROM main.plugin_credit_settlement_finalizations
           WHERE authority_id=? AND decision_id=? LIMIT 1`,
        )
        .get(decision.authorityId, decision.decisionId);
      if (reused !== undefined)
        throw new Error("plugin_credit_settlement_decision_conflict");
      const next =
        decision.outcome.kind === "settle"
          ? settleCreditReservation(
              snapshot.account,
              snapshot.reservation,
              decision.outcome.actualCredits,
            )
          : releaseCreditReservation(snapshot.account, snapshot.reservation);
      const finalization = createSettlementFinalization(
        snapshot,
        decision,
        next,
      );
      const scope = creditScopeValues(snapshot.account.scope);
      const accountWrite = this.#database
        .prepare(
          `UPDATE main.plugin_credit_accounts SET revision=?,account_json=?
           WHERE tenant_id=? AND principal_id=? AND pool_id=? AND revision=?`,
        )
        .run(
          next.account.revision,
          JSON.stringify(next.account),
          ...scope,
          snapshot.account.revision,
        );
      if (accountWrite.changes !== 1)
        throw new Error("plugin_credit_settlement_account_conflict");
      const reservationWrite = this.#database
        .prepare(
          `UPDATE main.plugin_credit_reservations SET record_json=?
           WHERE tenant_id=? AND principal_id=? AND pool_id=? AND reservation_id=?`,
        )
        .run(
          JSON.stringify(next.reservation),
          ...scope,
          snapshot.reservation.reservationId,
        );
      if (reservationWrite.changes !== 1)
        throw new Error("plugin_credit_settlement_reservation_conflict");
      const entry = creditEntry({
        account: next.account,
        kind: decision.outcome.kind,
        credits:
          decision.outcome.kind === "settle"
            ? decision.outcome.actualCredits
            : snapshot.reservation.quotedCredits,
        reservationId: snapshot.reservation.reservationId,
      });
      this.#database
        .prepare(
          `INSERT INTO main.plugin_credit_entries
           (tenant_id,principal_id,pool_id,revision,entry_json) VALUES(?,?,?,?,?)`,
        )
        .run(...scope, entry.revision, JSON.stringify(entry));
      this.#database
        .prepare(
          `INSERT INTO main.plugin_credit_settlement_finalizations
           (tenant_id,run_id,authority_id,decision_id,evidence_digest,record_json)
           VALUES(?,?,?,?,?,?)`,
        )
        .run(
          locator.tenantId,
          locator.runId,
          decision.authorityId,
          decision.decisionId,
          decision.evidenceDigest,
          JSON.stringify(finalization),
        );
      return { disposition: "committed", finalization };
    });
  }

  #snapshot(locator: PluginCreditSettlementLocator) {
    const admissionSchema = this.#tables(admissionTables);
    if (!admissionSchema) {
      this.#assertNoPaidReceipt(locator);
      return null;
    }
    const admissionVersions = this.#versions("extension_credit_schema_version");
    assertExtensionCreditSchemaVersion(admissionVersions);
    const admissionRow = this.#database
      .prepare(
        `SELECT * FROM main.extension_credit_admissions WHERE tenant_id=? AND run_id=?`,
      )
      .get(locator.tenantId, locator.runId);
    const admission = decodeExtensionCreditAdmission(
      admissionRow as Parameters<typeof decodeExtensionCreditAdmission>[0],
    );
    if (admission === null) {
      this.#assertNoPaidReceipt(locator);
      return buildSettlementSnapshot(locator, {
        admissionRow,
        admissionVersions,
        creditVersions: [],
        installedAdmission: null,
        operations: [],
        toolReceipts: [],
        steps: [],
        attempts: [],
        workItems: [],
      });
    }
    this.#requiredTables(creditTables);
    this.#requiredTables([
      "extension_run_bindings",
      "extension_mutation_receipts",
      "run_snapshots",
      "run_thread_bindings",
      "extension_external_operations",
      "tool_execution_receipts",
      "run_steps",
      "run_attempts",
      "work_items",
    ]);
    const bindingRow = this.#database
      .prepare(
        "SELECT * FROM main.extension_run_bindings WHERE tenant_id=? AND run_id=?",
      )
      .get(locator.tenantId, locator.runId);
    const taskReceiptRow = this.#database
      .prepare(
        `SELECT * FROM main.extension_mutation_receipts
         WHERE tenant_id=? AND space_id=? AND plugin_id=? AND kind='task'
         AND actor_id=? AND idempotency_key=?`,
      )
      .get(
        admission.tenantId,
        admission.spaceId,
        typeof bindingRow?.plugin_id === "string" ? bindingRow.plugin_id : "",
        admission.actorId,
        admission.commandIdempotencyKey,
      );
    const runRow = this.#database
      .prepare(
        `SELECT r.*,t.thread_id FROM main.run_snapshots r
         LEFT JOIN main.run_thread_bindings t ON t.tenant_id=r.tenant_id AND t.run_id=r.run_id
         WHERE r.tenant_id=? AND r.run_id=?`,
      )
      .get(locator.tenantId, locator.runId);
    const scope = creditScopeValues(admission.reservation.scope);
    const accountRow = this.#database
      .prepare(
        "SELECT * FROM main.plugin_credit_accounts WHERE tenant_id=? AND principal_id=? AND pool_id=?",
      )
      .get(...scope);
    const reservationRow = this.#database
      .prepare(
        `SELECT * FROM main.plugin_credit_reservations
         WHERE tenant_id=? AND principal_id=? AND pool_id=? AND reservation_id=?`,
      )
      .get(...scope, admission.reservation.reservationId);
    let installedAdmission: SettlementEvidenceRows["installedAdmission"] = null;
    if (this.#tables(installedAdmissionTables)) {
      assertPluginTaskAdmissionSchemaVersion(
        this.#versions("plugin_task_admission_schema_version"),
      );
      const present = this.#database
        .prepare(
          "SELECT 1 FROM main.plugin_task_admissions WHERE tenant_id=? AND run_id=? LIMIT 1",
        )
        .get(locator.tenantId, locator.runId);
      if (present !== undefined) {
        this.#requiredTables(["installed_plugin_packages"]);
        installedAdmission = loadSqlitePluginTask(this.#database, {
          ...locator,
          spaceId: admission.spaceId,
        });
        if (installedAdmission === null)
          throw new Error(
            "plugin_credit_settlement_installed_admission_invalid",
          );
      }
    }
    return buildSettlementSnapshot(locator, {
      admissionRow,
      bindingRow,
      taskReceiptRow,
      runRow,
      accountRow,
      reservationRow,
      admissionVersions,
      creditVersions: this.#versions("plugin_credit_schema_version"),
      installedAdmission,
      operations: this.#collection(
        "extension_external_operations",
        "operation_id",
        locator,
      ),
      toolReceipts: this.#collection(
        "tool_execution_receipts",
        "receipt_id",
        locator,
      ),
      steps: this.#collection("run_steps", "step_id", locator),
      attempts: this.#collection("run_attempts", "attempt_id", locator),
      workItems: this.#collection("work_items", "work_item_id", locator),
    });
  }

  #assertNoPaidReceipt(locator: PluginCreditSettlementLocator): void {
    if (!this.#tables(["extension_mutation_receipts"])) return;
    const paid = this.#database
      .prepare(
        `SELECT 1 FROM main.extension_mutation_receipts
         WHERE tenant_id=? AND kind='task' AND json_type(result_json,'$.creditAdmission') IS NOT NULL
         AND (json_extract(result_json,'$.runId')=? OR json_extract(result_json,'$.binding.runId')=?
           OR json_extract(result_json,'$.creditAdmission.runId')=?
           OR json_extract(result_json,'$.run.state.runId')=?
           OR json_extract(result_json,'$.turn.runState.runId')=?) LIMIT 1`,
      )
      .get(locator.tenantId, ...Array<string>(5).fill(locator.runId));
    if (paid !== undefined)
      throw new Error("plugin_credit_settlement_admission_missing");
  }

  #collection(
    table: string,
    order: string,
    locator: PluginCreditSettlementLocator,
  ): Row[] {
    return this.#database
      .prepare(
        `SELECT * FROM main.${table} WHERE tenant_id=? AND run_id=? ORDER BY ${order} LIMIT ?`,
      )
      .all(locator.tenantId, locator.runId, SETTLEMENT_COLLECTION_LIMIT + 1);
  }

  #finalization(
    locator: PluginCreditSettlementLocator,
  ): PluginCreditSettlementFinalization | null {
    const row = this.#database
      .prepare(
        "SELECT * FROM main.plugin_credit_settlement_finalizations WHERE tenant_id=? AND run_id=?",
      )
      .get(locator.tenantId, locator.runId);
    if (row === undefined) return null;
    const result = parseSettlementFinalization(row.record_json, locator);
    if (
      row.tenant_id !== result.locator.tenantId ||
      row.run_id !== result.locator.runId ||
      row.authority_id !== result.decision.authorityId ||
      row.decision_id !== result.decision.decisionId ||
      row.evidence_digest !== result.decision.evidenceDigest
    )
      throw new Error(
        "plugin_credit_settlement_finalization_identity_mismatch",
      );
    return result;
  }

  #tables(names: readonly string[]): boolean {
    const placeholders = names.map(() => "?").join(",");
    const rows = this.#database
      .prepare(
        `SELECT name,type,'main' AS source FROM main.sqlite_master WHERE name IN (${placeholders})
         UNION ALL SELECT name,type,'temp' AS source FROM temp.sqlite_master WHERE name IN (${placeholders})`,
      )
      .all(...names, ...names);
    if (rows.length === 0) return false;
    if (
      rows.length !== names.length ||
      names.some(
        (name) => rows.filter((row) => row.name === name).length !== 1,
      ) ||
      rows.some((row) => row.type !== "table" || row.source !== "main")
    )
      throw new Error("plugin_credit_settlement_schema_incomplete");
    return true;
  }

  #requiredTables(names: readonly string[]): void {
    if (!this.#tables(names))
      throw new Error("plugin_credit_settlement_schema_incomplete");
  }

  #versions(table: string): { id: unknown; version: unknown }[] {
    return this.#database
      .prepare(`SELECT id,version FROM main.${table} LIMIT 2`)
      .all() as {
      id: unknown;
      version: unknown;
    }[];
  }

  #settlementVersion(): void {
    assertPluginCreditSettlementSchemaVersion(
      this.#versions("plugin_credit_settlement_schema_version"),
    );
  }

  #settlementSchema(): void {
    this.#requiredTables(settlementTables);
    this.#settlementVersion();
    const triggers = this.#database
      .prepare(
        `SELECT name FROM main.sqlite_master WHERE type='trigger'
         AND tbl_name='plugin_credit_settlement_finalizations'
         AND name IN ('plugin_credit_settlement_no_update','plugin_credit_settlement_no_delete')`,
      )
      .all();
    if (triggers.length !== 2)
      throw new Error("plugin_credit_settlement_schema_incomplete");
  }

  #transaction<T>(body: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#assertOpen();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}

function captureFinalizationInput(
  input: unknown,
): Readonly<{ locator: unknown; decision: unknown }> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Object.getOwnPropertySymbols(input).length !== 0 ||
    Object.getOwnPropertyNames(input).sort().join("\0") !== "decision\0locator"
  )
    throw new Error("plugin_credit_settlement_input_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.values(descriptors).some(
      (field) => !Object.hasOwn(field, "value") || !field.enumerable,
    )
  )
    throw new Error("plugin_credit_settlement_input_invalid");
  return {
    locator: descriptors.locator!.value,
    decision: descriptors.decision!.value,
  };
}
