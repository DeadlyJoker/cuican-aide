import type { Pool, PoolClient } from "pg";
import {
  ApplicationError,
  RunStoreError,
  canonicalJson,
  type CommitRunInput,
  type CommitRunResult,
  type CommitWorkflowRunStartInput,
  type CommitWorkflowRunStartResult,
  type RunRoute,
  type ThreadLocator,
  type WorkflowRunAdmissionStore,
  type WorkflowRunInputAuthority,
  type WorkflowVersionAsset,
} from "@crewon/application";
import {
  MAX_WORKFLOW_DEFINITION_BYTES,
  type ThreadState,
} from "@crewon/domain";
import { validatePostgresSchemaName as validatePostgresSchemaIdentifier } from "./postgres-queue-schema.ts";
import { advisoryLock, threadLockKey } from "./postgres-thread-lock.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { assertPostgresProviderSettingsAdmissionOpen } from "./postgres-model-provider-settings-store.ts";
import { POSTGRES_LIVE_RUN_PREDICATE } from "./active-run-read.ts";
import { migratePostgresWorkflowRunAdmission } from "./postgres-workflow-run-admission-schema.ts";
import {
  validateWorkflowAdmissionInput,
  validateWorkflowAdmissionAuthority,
  validateWorkflowAdmissionPreparation,
  validateWorkflowInputAuthority,
} from "./workflow-run-admission-validation.ts";
import {
  MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES,
  decodeWorkflowAdmissionReceipt,
  completeWorkflowAdmissionReplay,
  type WorkflowAdmissionReceiptRow,
} from "./workflow-run-admission-receipt.ts";

/** Trusted composition callback: only use this transaction's client for route authority reads. */
export type PostgresWorkflowRouteResolver = (
  input: Readonly<{
    client: PoolClient;
    tenantId: string;
    spaceId: string;
    thread: ThreadState;
    workflowVersion: WorkflowVersionAsset;
  }>,
) => RunRoute | Promise<RunRoute>;
type Dependencies = Readonly<{
  assertOpen(): void;
  loadThread(
    client: PoolClient,
    locator: ThreadLocator,
  ): Promise<ThreadState | null>;
  commitRun(
    client: PoolClient,
    input: CommitRunInput,
  ): Promise<CommitRunResult>;
  resolveRouteWithinTransaction: PostgresWorkflowRouteResolver;
}>;

/** Atomic admission foundation. Explicit migration and scheduler composition are separate capabilities. */
export class ExperimentalPostgresWorkflowRunAdmissionStore
  implements WorkflowRunAdmissionStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #sql: string;
  readonly #d: Dependencies;
  constructor(pool: Pool, schema: string, dependencies: Dependencies) {
    validatePostgresSchemaIdentifier(schema);
    dependencies.assertOpen();
    this.#pool = pool;
    this.#schema = schema;
    this.#sql = `"${schema}"`;
    this.#d = dependencies;
  }
  async migrate(): Promise<void> {
    this.#d.assertOpen();
    const client = await this.#pool.connect();
    try {
      await migratePostgresWorkflowRunAdmission(client, this.#schema);
    } catch (error) {
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }
  async commitWorkflowRunStart(
    command: CommitWorkflowRunStartInput,
  ): Promise<CommitWorkflowRunStartResult> {
    this.#d.assertOpen();
    validateWorkflowAdmissionInput(command);
    const { prepare, ...fields } = command;
    const input = { ...structuredClone(fields), prepare };
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await advisoryLock(
        client,
        `idempotency:${input.idempotency.scope}:${input.idempotency.key}`,
      );
      const replay = await this.#loadReceipt(client, input);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      const version = await client.query<{
        singleton: boolean;
        version: number;
      }>(
        `SELECT singleton,version FROM ${this.#sql}.workflow_run_admission_schema LIMIT 2`,
      );
      if (
        version.rows.length !== 1 ||
        version.rows[0]?.singleton !== true ||
        version.rows[0].version !== 1
      )
        throw new RunStoreError("workflow_run_admission_schema_unsupported");
      await assertPostgresProviderSettingsAdmissionOpen(
        client,
        this.#sql,
        input.tenantId,
      );
      await advisoryLock(client, threadLockKey(input.tenantId, input.threadId));
      const thread = await this.#d.loadThread(client, input);
      if (!thread || thread.spaceId !== input.spaceId)
        throw new RunStoreError("thread_not_found");
      if (thread.status !== "active")
        throw new RunStoreError("thread_not_active");
      const active = await client.query(
        `SELECT 1 FROM ${this.#sql}.run_snapshots AS snapshots
        LEFT JOIN ${this.#sql}.run_thread_bindings AS bindings
        ON bindings.tenant_id=snapshots.tenant_id AND bindings.run_id=snapshots.run_id
        WHERE snapshots.tenant_id=$1
        AND (bindings.thread_id=$3 OR (bindings.thread_id IS NULL AND snapshots.space_id=$2))
        AND ${POSTGRES_LIVE_RUN_PREDICATE} LIMIT 1`,
        [input.tenantId, input.spaceId, input.threadId],
      );
      if (active.rows.length)
        throw new RunStoreError("thread_active_run_conflict");
      const versions = await client.query<{
        tenant_id: string;
        workflow_id: string;
        workflow_version_id: string;
        content_digest: string;
        created_at: Date;
        definition_json: string | null;
      }>(
        `SELECT tenant_id,workflow_id,workflow_version_id,content_digest,created_at,
        CASE WHEN octet_length(definition_json)<=${MAX_WORKFLOW_DEFINITION_BYTES} THEN definition_json ELSE NULL END AS definition_json
        FROM ${this.#sql}.workflow_versions WHERE tenant_id=$1 AND workflow_version_id=$2 FOR SHARE`,
        [input.tenantId, input.workflowVersionId],
      );
      const row = versions.rows[0];
      if (!row) throw new RunStoreError("workflow_version_not_found");
      if (row.definition_json === null)
        throw new RunStoreError("workflow_run_authority_too_large");
      const workflowVersion: WorkflowVersionAsset = {
        schemaVersion: "crewon.workflow-version-asset.v0",
        tenantId: row.tenant_id,
        workflowId: row.workflow_id,
        workflowVersionId: row.workflow_version_id,
        contentDigest: row.content_digest,
        definitionJson: row.definition_json,
        createdAt: new Date(row.created_at).toISOString(),
      };
      const route = await this.#d.resolveRouteWithinTransaction({
        client,
        tenantId: input.tenantId,
        spaceId: input.spaceId,
        thread: structuredClone(thread),
        workflowVersion: structuredClone(workflowVersion),
      });
      const authority = structuredClone({ workflowVersion, route });
      validateWorkflowAdmissionAuthority(input, authority);
      const prepared = structuredClone(prepare(structuredClone(authority)));
      validateWorkflowAdmissionPreparation(input, authority, prepared);
      const authorityJson = canonicalJson(authority);
      if (
        Buffer.byteLength(authorityJson) > MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES
      )
        throw new RunStoreError("workflow_run_authority_too_large");
      // Preparation allocates the proposed Run only after Thread admission. Never
      // wait on its Run lock while holding Thread: ordinary writers lock Run first.
      const proposedRunId = prepared.commit.events[0]!.identity.runId;
      const proposed = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [`run:${input.tenantId}:${proposedRunId}`],
      );
      if (proposed.rows[0]?.acquired !== true)
        throw new RunStoreError("postgres_retryable");
      const run = await this.#d.commitRun(client, prepared.commit);
      if (run.disposition !== "committed")
        throw new RunStoreError("workflow_run_admission_receipt_invalid");
      const value = prepared.workflowInputValue;
      await client.query(
        `INSERT INTO ${this.#sql}.workflow_run_inputs (tenant_id,run_id,value_id,value_digest,value_json)
        VALUES ($1,$2,$3,$4,$5)`,
        [
          input.tenantId,
          run.state.runId,
          value.valueId,
          value.valueDigest,
          canonicalJson(value.value),
        ],
      );
      await client.query(
        `INSERT INTO ${this.#sql}.workflow_run_admissions (scope,idempotency_key,tenant_id,run_id,authority_json)
        VALUES ($1,$2,$3,$4,$5)`,
        [
          input.idempotency.scope,
          input.idempotency.key,
          input.tenantId,
          run.state.runId,
          authorityJson,
        ],
      );
      await client.query("COMMIT");
      return structuredClone({ authority, run });
    } catch (error) {
      await rollbackPostgres(client);
      throw error instanceof ApplicationError
        ? error
        : normalizePostgresError(error);
    } finally {
      client.release();
    }
  }
  async loadWorkflowRunInput(
    input: InputLocator,
  ): Promise<WorkflowRunInputAuthority | null> {
    this.#d.assertOpen();
    return this.#loadInput(this.#pool, input);
  }
  async #loadInput(
    connection: Pool | PoolClient,
    input: InputLocator,
  ): Promise<WorkflowRunInputAuthority | null> {
    for (const field of [
      input.tenantId,
      input.runId,
      input.valueId,
      input.valueDigest,
    ])
      if (typeof field !== "string" || !field || Buffer.byteLength(field) > 512)
        throw new RunStoreError("workflow_run_input_locator_invalid");
    const result = await connection.query<{
      value_id: string;
      value_digest: string;
      value_json: string | null;
    }>(
      `SELECT value_id,value_digest,CASE WHEN octet_length(value_json)<=32768 THEN value_json ELSE NULL END AS value_json
       FROM ${this.#sql}.workflow_run_inputs WHERE tenant_id=$1 AND run_id=$2`,
      [input.tenantId, input.runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (
      row.value_json === null ||
      row.value_id !== input.valueId ||
      row.value_digest !== input.valueDigest
    )
      throw new RunStoreError("workflow_run_input_authority_mismatch");
    const value: WorkflowRunInputAuthority = {
      schemaVersion: "crewon.workflow-execution-value.v0",
      valueId: row.value_id,
      valueDigest: row.value_digest,
      value: JSON.parse(row.value_json),
    };
    validateWorkflowInputAuthority(value);
    return value;
  }
  async #loadReceipt(
    client: PoolClient,
    input: CommitWorkflowRunStartInput,
  ): Promise<CommitWorkflowRunStartResult | null> {
    const result = await client.query<WorkflowAdmissionReceiptRow>(
      `SELECT r.tenant_id,r.run_id,
      CASE WHEN octet_length(r.fingerprint)<=131072 THEN r.fingerprint ELSE NULL END AS fingerprint,
      CASE WHEN octet_length(r.result_json::text)<=${MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES} THEN r.result_json::text ELSE NULL END AS result_json,
      CASE WHEN a.tenant_id=r.tenant_id AND a.run_id=r.run_id AND octet_length(a.authority_json)<=${MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES}
        THEN a.authority_json ELSE NULL END AS authority_json
      FROM ${this.#sql}.idempotency_receipts r LEFT JOIN ${this.#sql}.workflow_run_admissions a USING(scope,idempotency_key)
      WHERE r.scope=$1 AND r.idempotency_key=$2`,
      [input.idempotency.scope, input.idempotency.key],
    );
    if (!result.rows[0]) return null;
    const decoded = decodeWorkflowAdmissionReceipt(input, result.rows[0]);
    try {
      return completeWorkflowAdmissionReplay(
        input,
        decoded,
        await this.#loadInput(client, decoded.inputRef),
      );
    } catch (cause) {
      throw new RunStoreError("workflow_run_admission_receipt_invalid", {
        cause,
      });
    }
  }
}
type InputLocator = Readonly<{
  tenantId: string;
  runId: string;
  valueId: string;
  valueDigest: string;
}>;
