import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  PluginCreditSettlementCommitResult,
  PluginCreditSettlementDecision,
  PluginCreditSettlementFinalization,
  PluginCreditSettlementLocator,
  PluginCreditSettlementStore,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  releaseCreditReservation,
  settleCreditReservation,
  type CreditMutation,
} from "@crewon/domain";
import { decodeExtensionCreditAdmission } from "./extension-credit-admission-records.ts";
import { creditEntry, creditScopeValues } from "./plugin-credit-support.ts";
import { pluginCreditSchemaName } from "./plugin-credit-schema.ts";
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
import {
  assertPluginCreditSettlementSchemaVersion,
  pluginCreditSettlementSchemaSql,
} from "./plugin-credit-settlement-schema.ts";
import { loadPostgresPluginTask } from "./plugin-task-admission-store-support.ts";
import { assertPluginTaskAdmissionSchemaVersion } from "./plugin-task-admission-schema.ts";
import { lockPostgresPluginCreditAccount } from "./postgres-plugin-credit-reservation.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";

type Row = Record<string, unknown>;
type AdmissionRow = NonNullable<
  Parameters<typeof decodeExtensionCreditAdmission>[0]
>;
type Snapshot = NonNullable<ReturnType<typeof buildSettlementSnapshot>>;

/** Explicit server decisions share the original personal ledger and Run transaction. */
export class PostgresPluginCreditSettlementStore
  implements PluginCreditSettlementStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #assertOpen: () => void;

  constructor(
    input: Readonly<{ pool: Pool; schema: string; assertOpen(): void }>,
  ) {
    this.#prefix = `${pluginCreditSchemaName(input.schema)}.`;
    this.#schema = input.schema;
    this.#pool = input.pool;
    const checker = Object.getOwnPropertyDescriptor(input, "assertOpen");
    if (
      checker === undefined ||
      !Object.hasOwn(checker, "value") ||
      typeof checker.value !== "function"
    )
      throw new Error("plugin_credit_settlement_owner_invalid");
    this.#assertOpen = (checker.value as () => void).bind(input);
  }

  async migrate(): Promise<void> {
    await this.#transaction(async (client) => {
      await this.#query(
        client,
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify(["plugin-credit-settlement-migration", this.#schema])],
      );
      const present = await this.#query(
        client,
        `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,
        [
          this.#schema,
          [
            "plugin_credit_settlement_schema_version",
            "plugin_credit_settlement_finalizations",
          ],
        ],
      );
      if (present.rows.length !== 0) await this.#assertVersion(client);
      await this.#query(
        client,
        pluginCreditSettlementSchemaSql({
          dialect: "postgres",
          schema: this.#schema,
        }),
      );
      await this.#assertVersion(client);
      await this.#query(
        client,
        `SELECT tenant_id,run_id,authority_id,decision_id,evidence_digest,record_json FROM ${this.#prefix}plugin_credit_settlement_finalizations LIMIT 0`,
      );
    });
  }

  async getFinalization(
    input: PluginCreditSettlementLocator,
  ): Promise<PluginCreditSettlementFinalization | null> {
    const locator = parseSettlementLocator(input);
    return this.#transaction(async (client) => {
      await this.#assertVersion(client);
      return this.#readFinalization(client, locator);
    });
  }

  async loadEvidence(input: PluginCreditSettlementLocator) {
    const locator = parseSettlementLocator(input);
    return this.#withEvidenceTransaction(
      locator,
      async (client, admissionRow) => {
        const snapshot = await this.#snapshot(client, locator, admissionRow);
        return snapshot?.evidence ?? null;
      },
    );
  }

  async finalize(
    input: Readonly<{
      locator: PluginCreditSettlementLocator;
      decision: PluginCreditSettlementDecision;
    }>,
  ): Promise<PluginCreditSettlementCommitResult> {
    const captured = captureFinalizationInput(input);
    const locator = parseSettlementLocator(captured.locator);
    const decision = parseSettlementDecision(captured.decision);
    return this.#withEvidenceTransaction<PluginCreditSettlementCommitResult>(
      locator,
      async (client, admissionRow) => {
        const saved = await this.#readFinalization(client, locator);
        if (saved !== null) {
          assertSettlementReplay(saved, decision);
          return { disposition: "replayed", finalization: saved };
        }
        const snapshot = await this.#snapshot(client, locator, admissionRow);
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
        await this.#query(
          client,
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [
            JSON.stringify([
              "plugin-credit-settlement-decision",
              this.#schema,
              decision.authorityId,
              decision.decisionId,
            ]),
          ],
        );
        const reused = await this.#query(
          client,
          `SELECT tenant_id,run_id FROM ${this.#prefix}plugin_credit_settlement_finalizations WHERE authority_id=$1 AND decision_id=$2 LIMIT 2`,
          [decision.authorityId, decision.decisionId],
        );
        if (reused.rows.length !== 0)
          throw new Error("plugin_credit_settlement_decision_conflict");
        const mutation =
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
          mutation,
        );
        await this.#writeLedger(client, snapshot, decision, mutation);
        await this.#query(
          client,
          `INSERT INTO ${this.#prefix}plugin_credit_settlement_finalizations
         (tenant_id,run_id,authority_id,decision_id,evidence_digest,record_json)
         VALUES($1,$2,$3,$4,$5,$6)`,
          [
            locator.tenantId,
            locator.runId,
            decision.authorityId,
            decision.decisionId,
            decision.evidenceDigest,
            finalization,
          ],
        );
        return { disposition: "committed", finalization };
      },
    );
  }

  async #withEvidenceTransaction<T>(
    locator: PluginCreditSettlementLocator,
    body: (
      client: PoolClient,
      admission: AdmissionRow | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    // A new admission can commit while this reader waits for its Run. Restart
    // before acquiring an account lock in the opposite order to paid creation.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.#transaction(async (client) => {
          await this.#assertVersion(client);
          // Validate source relations before reading even the payer lookup.
          // A same-name view must never project financial or terminal evidence.
          await this.#assertEvidenceTables(client);
          const initialRow = await this.#admissionRow(client, locator, false);
          const admission = decodeExtensionCreditAdmission(initialRow);
          if (admission !== null)
            await lockPostgresPluginCreditAccount({
              client,
              schema: this.#schema,
              scope: admission.reservation.scope,
              assertOpen: this.#assertOpen,
            });
          await this.#query(
            client,
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`run:${locator.tenantId}:${locator.runId}`],
          );
          const lockedRow = await this.#admissionRow(client, locator, true);
          if (initialRow === undefined && lockedRow !== undefined)
            throw new AdmissionAppeared();
          if (initialRow !== undefined && lockedRow === undefined)
            throw new Error("plugin_credit_settlement_admission_missing");
          if (
            admission !== null &&
            extensionCanonicalJson(admission) !==
              extensionCanonicalJson(decodeExtensionCreditAdmission(lockedRow))
          )
            throw new Error("plugin_credit_settlement_admission_changed");
          return body(client, lockedRow);
        });
      } catch (error) {
        if (!(error instanceof AdmissionAppeared)) throw error;
      }
    }
    throw new Error("plugin_credit_settlement_admission_changed");
  }

  async #snapshot(
    client: PoolClient,
    locator: PluginCreditSettlementLocator,
    admissionRow: AdmissionRow | undefined,
  ): Promise<Snapshot | null> {
    const keys = [locator.tenantId, locator.runId];
    // Queue claim/renew lock only the work item; checkpoint/provider state
    // writers lock work item before Attempt. Retain that ordering here.
    const workItems = await this.#collection(
      client,
      "work_items",
      keys,
      "work_item_id",
    );
    const runRow = await this.#one<Row>(
      client,
      `SELECT snapshots.*,bindings.thread_id FROM ${this.#prefix}run_snapshots snapshots
       LEFT JOIN ${this.#prefix}run_thread_bindings bindings
         ON bindings.tenant_id=snapshots.tenant_id AND bindings.run_id=snapshots.run_id
       WHERE snapshots.tenant_id=$1 AND snapshots.run_id=$2 LIMIT 2 FOR UPDATE OF snapshots`,
      keys,
    );
    const bindingRow = await this.#one<Row>(
      client,
      `SELECT * FROM ${this.#prefix}extension_run_bindings WHERE tenant_id=$1 AND run_id=$2 LIMIT 2 FOR UPDATE`,
      keys,
    );
    const taskReceiptRow = await this.#one<Row>(
      client,
      `SELECT * FROM ${this.#prefix}extension_mutation_receipts WHERE tenant_id=$1 AND kind='task' AND (
         result_json->'binding'->>'runId'=$2 OR result_json->'creditAdmission'->>'runId'=$2 OR
         result_json->'run'->'state'->>'runId'=$2 OR result_json->'turn'->'runState'->>'runId'=$2
       ) LIMIT 2 FOR UPDATE`,
      keys,
    );
    const admission = decodeExtensionCreditAdmission(admissionRow);
    let accountRow: Row | undefined;
    let reservationRow: Row | undefined;
    let installedAdmission: SettlementEvidenceRows["installedAdmission"] = null;
    if (admission !== null) {
      const scope = [...creditScopeValues(admission.reservation.scope)];
      accountRow = await this.#one<Row>(
        client,
        `SELECT * FROM ${this.#prefix}plugin_credit_accounts WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 LIMIT 2 FOR UPDATE`,
        scope,
      );
      reservationRow = await this.#one<Row>(
        client,
        `SELECT * FROM ${this.#prefix}plugin_credit_reservations WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 AND reservation_id=$4 LIMIT 2 FOR UPDATE`,
        [...scope, admission.reservation.reservationId],
      );
      installedAdmission = await this.#installedAdmission(
        client,
        locator,
        admission.spaceId,
      );
    }
    // Operation advance is revision-CAS without the Run advisory. Its row lock
    // is essential even after the original Run reaches a terminal state.
    const operations = await this.#collection(
      client,
      "extension_external_operations",
      keys,
      "binding_digest,operation_id",
    );
    const steps = await this.#collection(client, "run_steps", keys, "step_id");
    const attempts = await this.#collection(
      client,
      "run_attempts",
      keys,
      "step_id,attempt_id",
    );
    const toolReceipts = await this.#collection(
      client,
      "tool_execution_receipts",
      keys,
      "receipt_id",
    );
    const creditVersions = (
      await this.#query<{ id: unknown; version: unknown }>(
        client,
        `SELECT id,version FROM ${this.#prefix}plugin_credit_schema_version LIMIT 2 FOR SHARE`,
      )
    ).rows;
    const admissionVersions = (
      await this.#query<{ id: unknown; version: unknown }>(
        client,
        `SELECT id,version FROM ${this.#prefix}extension_credit_schema_version LIMIT 2 FOR SHARE`,
      )
    ).rows;
    return buildSettlementSnapshot(locator, {
      admissionRow,
      bindingRow,
      taskReceiptRow,
      runRow,
      accountRow,
      reservationRow,
      installedAdmission,
      creditVersions,
      admissionVersions,
      operations,
      toolReceipts,
      steps,
      attempts,
      workItems,
    });
  }

  async #installedAdmission(
    client: PoolClient,
    locator: PluginCreditSettlementLocator,
    spaceId: string,
  ): Promise<SettlementEvidenceRows["installedAdmission"]> {
    const names = [
      "plugin_task_admission_schema_version",
      "plugin_task_admissions",
    ];
    const catalog = await this.#query<{ name: string; kind: string }>(
      client,
      `SELECT c.relname AS name,c.relkind AS kind FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) LIMIT 3`,
      [this.#schema, names],
    );
    if (catalog.rows.length === 0) return null;
    if (
      catalog.rows.length !== 2 ||
      names.some(
        (name) => catalog.rows.filter((row) => row.name === name).length !== 1,
      ) ||
      catalog.rows.some((row) => row.kind !== "r")
    )
      throw new Error("plugin_task_admission_schema_incomplete");
    await this.#assertPhysicalTables(
      client,
      names,
      "plugin_task_admission_schema_incomplete",
    );
    const versions = await this.#query<{ id: unknown; version: unknown }>(
      client,
      `SELECT id,version FROM ${this.#prefix}plugin_task_admission_schema_version LIMIT 2 FOR SHARE`,
    );
    assertPluginTaskAdmissionSchemaVersion(versions.rows);
    const present = await this.#one<Row>(
      client,
      `SELECT run_id FROM ${this.#prefix}plugin_task_admissions WHERE tenant_id=$1 AND run_id=$2 LIMIT 2 FOR UPDATE`,
      [locator.tenantId, locator.runId],
    );
    if (present === undefined) return null;
    const packages = await this.#query<{ kind: string }>(
      client,
      `SELECT c.relkind AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname='installed_plugin_packages' LIMIT 2`,
      [this.#schema],
    );
    if (packages.rows.length !== 1 || packages.rows[0]?.kind !== "r")
      throw new Error("plugin_task_admission_schema_incomplete");
    await this.#assertPhysicalTables(
      client,
      ["installed_plugin_packages"],
      "plugin_task_admission_schema_incomplete",
    );
    const installed = await loadPostgresPluginTask(client, this.#schema, {
      ...locator,
      spaceId,
    });
    this.#assertOpen();
    if (installed === null)
      throw new Error("plugin_credit_settlement_installed_admission_invalid");
    return installed;
  }

  async #collection(
    client: PoolClient,
    table: string,
    keys: string[],
    order: string,
  ): Promise<Row[]> {
    const result = await this.#query<Row>(
      client,
      `SELECT * FROM ${this.#prefix}${table} WHERE tenant_id=$1 AND run_id=$2 ORDER BY ${order} LIMIT $3 FOR UPDATE`,
      [...keys, SETTLEMENT_COLLECTION_LIMIT + 1],
    );
    if (result.rows.length > SETTLEMENT_COLLECTION_LIMIT)
      throw new Error("plugin_credit_settlement_evidence_limit_exceeded");
    return result.rows;
  }

  async #admissionRow(
    client: PoolClient,
    locator: PluginCreditSettlementLocator,
    lock: boolean,
  ) {
    return this.#one<AdmissionRow>(
      client,
      `SELECT * FROM ${this.#prefix}extension_credit_admissions WHERE tenant_id=$1 AND run_id=$2 LIMIT 2${lock ? " FOR UPDATE" : ""}`,
      [locator.tenantId, locator.runId],
    );
  }

  async #readFinalization(
    client: PoolClient,
    locator: PluginCreditSettlementLocator,
  ) {
    const row = await this.#one<Row>(
      client,
      `SELECT tenant_id,run_id,authority_id,decision_id,evidence_digest,record_json FROM ${this.#prefix}plugin_credit_settlement_finalizations WHERE tenant_id=$1 AND run_id=$2 LIMIT 2`,
      [locator.tenantId, locator.runId],
    );
    if (row === undefined) return null;
    const saved = parseSettlementFinalization(row.record_json, locator);
    if (
      row.tenant_id !== locator.tenantId ||
      row.run_id !== locator.runId ||
      row.authority_id !== saved.decision.authorityId ||
      row.decision_id !== saved.decision.decisionId ||
      row.evidence_digest !== saved.decision.evidenceDigest
    )
      throw new Error("plugin_credit_settlement_finalization_identity_invalid");
    return saved;
  }

  async #writeLedger(
    client: PoolClient,
    snapshot: Snapshot,
    decision: PluginCreditSettlementDecision,
    mutation: CreditMutation,
  ): Promise<void> {
    const scope = [...creditScopeValues(mutation.account.scope)];
    const account = await this.#query(
      client,
      `UPDATE ${this.#prefix}plugin_credit_accounts SET revision=$1,account_json=$2 WHERE tenant_id=$3 AND principal_id=$4 AND pool_id=$5 AND revision=$6`,
      [
        mutation.account.revision,
        mutation.account,
        ...scope,
        snapshot.account.revision,
      ],
    );
    const reservation = await this.#query(
      client,
      `UPDATE ${this.#prefix}plugin_credit_reservations SET record_json=$1 WHERE tenant_id=$2 AND principal_id=$3 AND pool_id=$4 AND reservation_id=$5 AND record_json->>'state'='reserved'`,
      [mutation.reservation, ...scope, mutation.reservation.reservationId],
    );
    if (account.rowCount !== 1 || reservation.rowCount !== 1)
      throw new Error("plugin_credit_settlement_ledger_conflict");
    const entry = creditEntry({
      account: mutation.account,
      kind: decision.outcome.kind,
      credits:
        decision.outcome.kind === "settle"
          ? decision.outcome.actualCredits
          : mutation.reservation.quotedCredits,
      reservationId: mutation.reservation.reservationId,
    });
    await this.#query(
      client,
      `INSERT INTO ${this.#prefix}plugin_credit_entries VALUES($1,$2,$3,$4,$5)`,
      [...scope, entry.revision, entry],
    );
  }

  async #assertVersion(client: PoolClient): Promise<void> {
    const tables = [
      "plugin_credit_settlement_schema_version",
      "plugin_credit_settlement_finalizations",
    ];
    await this.#assertPhysicalTables(
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

  async #assertEvidenceTables(client: PoolClient): Promise<void> {
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
    await this.#assertPhysicalTables(
      client,
      names,
      "plugin_credit_settlement_schema_incomplete",
    );
  }

  async #assertPhysicalTables(
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

  async #one<T extends QueryResultRow>(
    client: PoolClient,
    sql: string,
    values: unknown[],
  ): Promise<T | undefined> {
    const result = await this.#query<T>(client, sql, values);
    if (result.rows.length > 1)
      throw new Error("plugin_credit_settlement_evidence_ambiguous");
    return result.rows[0];
  }

  async #query<T extends QueryResultRow = Row>(
    client: PoolClient,
    sql: string,
    values?: unknown[],
  ) {
    this.#assertOpen();
    const result = await client.query<T>(sql, values);
    this.#assertOpen();
    return result;
  }

  async #transaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      await this.#query(client, "BEGIN");
      const result = await body(client);
      this.#assertOpen();
      // A confirmed COMMIT remains success when host closure races its response.
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

class AdmissionAppeared extends Error {}

function captureFinalizationInput(
  input: unknown,
): Readonly<{ locator: unknown; decision: unknown }> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Reflect.ownKeys(input).some((key) => typeof key !== "string")
  )
    throw new Error("plugin_credit_settlement_record_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.keys(descriptors).sort().join(",") !== "decision,locator" ||
    Object.values(descriptors).some(
      (field) => !Object.hasOwn(field, "value") || !field.enumerable,
    )
  )
    throw new Error("plugin_credit_settlement_record_invalid");
  return {
    locator: descriptors.locator!.value,
    decision: descriptors.decision!.value,
  };
}
