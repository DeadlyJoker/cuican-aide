import type { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  canonicalJson as stableJson,
  type CommitRunInput,
  type CommitRunResult,
  type CommitThreadInput,
  type CommitThreadResult,
  type CommitWorkflowRunStartInput,
  type CommitWorkflowRunStartResult,
  type RunRoute,
  type ThreadLocator,
  type ThreadScopedLocator,
  type WorkflowRunAdmissionStore,
  type WorkflowRunInputAuthority,
  type WorkflowVersionAsset,
} from "@crewon/application";
import {
  MAX_WORKFLOW_DEFINITION_BYTES,
  type ThreadState,
} from "@crewon/domain";
import {
  migrateSqliteWorkflowCancellation,
  assertSqliteWorkflowCancellationSchema,
} from "./sqlite-workflow-cancellation-schema.ts";
import {
  validateWorkflowAdmissionAuthority,
  validateWorkflowAdmissionInput,
  validateWorkflowAdmissionPreparation,
  validateWorkflowInputAuthority,
} from "./workflow-run-admission-validation.ts";

import {
  MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES as MAX_AUTHORITY_BYTES,
  decodeWorkflowAdmissionReceipt,
  completeWorkflowAdmissionReplay,
} from "./workflow-run-admission-receipt.ts";
import {
  prepareWorkflowRootInput,
  workflowRootInputReceipt,
} from "./workflow-root-input.ts";

/** Server-owned, synchronous admission. Never perform network I/O inside SQLite's write transaction. */
export type SqliteWorkflowRouteResolver = (
  input: Readonly<{
    database: DatabaseSync;
    tenantId: string;
    spaceId: string;
    thread: ThreadState;
    workflowVersion: WorkflowVersionAsset;
  }>,
) => RunRoute;

type Dependencies = Readonly<{
  assertOpen(): void;
  loadThread(locator: ThreadLocator): ThreadState | null;
  hasActiveRun(locator: ThreadScopedLocator): boolean;
  hasPendingProviderSwitch(tenantId: string): boolean;
  commitRunWithinTransaction(input: CommitRunInput): CommitRunResult;
  commitThreadWithinTransaction(input: CommitThreadInput): CommitThreadResult;
  resolveRouteWithinTransaction: SqliteWorkflowRouteResolver;
}>;

/**
 * Internal admission foundation; deliberately absent from production composition.
 * Atomic DAG node admission, execution routing and old-writer fencing are still required.
 */
export class ExperimentalSqliteWorkflowRunAdmissionStore
  implements WorkflowRunAdmissionStore
{
  readonly #database: DatabaseSync;
  readonly #dependencies: Dependencies;

  constructor(database: DatabaseSync, dependencies: Dependencies) {
    dependencies.assertOpen();
    migrateSqliteWorkflowCancellation(database);
    this.#database = database;
    this.#dependencies = dependencies;
  }

  async commitWorkflowRunStart(
    command: CommitWorkflowRunStartInput,
  ): Promise<CommitWorkflowRunStartResult> {
    this.#dependencies.assertOpen();
    validateWorkflowAdmissionInput(command);
    const { prepare, ...fields } = command;
    const input = { ...structuredClone(fields), prepare };
    const db = this.#database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.#loadReceipt(input);
      if (replay !== null) {
        db.exec("COMMIT");
        return replay;
      }
      assertSqliteWorkflowCancellationSchema(db);
      if (this.#dependencies.hasPendingProviderSwitch(input.tenantId))
        throw new RunStoreError("model_provider_settings_switch_pending");
      const thread = this.#dependencies.loadThread(input);
      if (!thread || thread.spaceId !== input.spaceId)
        throw new RunStoreError("thread_not_found");
      if (thread.status !== "active")
        throw new RunStoreError("thread_not_active");
      if (this.#dependencies.hasActiveRun(input))
        throw new RunStoreError("thread_active_run_conflict");
      const row = db
        .prepare(
          `SELECT tenant_id,workflow_id,workflow_version_id,content_digest,created_at,
        CASE WHEN length(CAST(definition_json AS BLOB))<=${MAX_WORKFLOW_DEFINITION_BYTES} THEN definition_json ELSE NULL END AS definition_json
        FROM workflow_versions WHERE tenant_id=? AND workflow_version_id=?`,
        )
        .get(input.tenantId, input.workflowVersionId) as
        | {
            tenant_id: string;
            workflow_id: string;
            workflow_version_id: string;
            content_digest: string;
            created_at: string;
            definition_json: string | null;
          }
        | undefined;
      if (!row) throw new RunStoreError("workflow_version_not_found");
      if (row.definition_json === null)
        throw new RunStoreError("workflow_run_authority_too_large");
      const workflowVersion: WorkflowVersionAsset = {
        schemaVersion: "crewon.workflow-version-asset.v0",
        tenantId: row.tenant_id,
        workflowId: row.workflow_id,
        workflowVersionId: row.workflow_version_id,
        contentDigest: row.content_digest,
        createdAt: row.created_at,
        definitionJson: row.definition_json,
      };
      const route = this.#dependencies.resolveRouteWithinTransaction({
        database: db,
        tenantId: input.tenantId,
        spaceId: input.spaceId,
        thread: structuredClone(thread),
        workflowVersion: structuredClone(workflowVersion),
      });
      const authority = structuredClone({ workflowVersion, route });
      validateWorkflowAdmissionAuthority(input, authority);
      const prepared = structuredClone(prepare(structuredClone(authority)));
      validateWorkflowAdmissionPreparation(input, authority, prepared);
      const authorityJson = stableJson(authority);
      if (Buffer.byteLength(authorityJson) > MAX_AUTHORITY_BYTES)
        throw new RunStoreError("workflow_run_authority_too_large");
      const run = this.#dependencies.commitRunWithinTransaction(
        prepared.commit,
      );
      if (run.disposition !== "committed")
        throw new RunStoreError("workflow_run_admission_receipt_invalid");
      const head = db
        .prepare(
          `SELECT COALESCE(MAX(sequence),0) AS n FROM model_history_items WHERE tenant_id=? AND thread_id=?`,
        )
        .get(input.tenantId, input.threadId) as { n: number };
      const startedThread = this.#dependencies.commitThreadWithinTransaction(
        prepareWorkflowRootInput(input, run, thread, head.n),
      );
      db.prepare(
        `UPDATE idempotency_receipts SET result_json=? WHERE scope=? AND idempotency_key=?`,
      ).run(
        stableJson(workflowRootInputReceipt(run, startedThread)),
        input.idempotency.scope,
        input.idempotency.key,
      );
      const value = prepared.workflowInputValue;
      db.prepare(
        `INSERT INTO workflow_run_inputs (tenant_id,run_id,value_id,value_digest,value_json) VALUES (?,?,?,?,?)`,
      ).run(
        input.tenantId,
        run.state.runId,
        value.valueId,
        value.valueDigest,
        stableJson(value.value),
      );
      db.prepare(
        `INSERT INTO workflow_run_admissions (scope,idempotency_key,tenant_id,run_id,authority_json) VALUES (?,?,?,?,?)`,
      ).run(
        input.idempotency.scope,
        input.idempotency.key,
        input.tenantId,
        run.state.runId,
        authorityJson,
      );
      db.exec("COMMIT");
      return structuredClone({ authority, run });
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async loadWorkflowRunInput(
    input: Readonly<{
      tenantId: string;
      runId: string;
      valueId: string;
      valueDigest: string;
    }>,
  ): Promise<WorkflowRunInputAuthority | null> {
    this.#dependencies.assertOpen();
    return this.#loadInput(input);
  }

  #loadInput(
    input: Readonly<{
      tenantId: string;
      runId: string;
      valueId: string;
      valueDigest: string;
    }>,
  ): WorkflowRunInputAuthority | null {
    for (const value of Object.values(input))
      if (typeof value !== "string" || value.length === 0 || value.length > 512)
        throw new RunStoreError("workflow_run_input_locator_invalid");
    const row = this.#database
      .prepare(
        `SELECT value_id,value_digest,
      CASE WHEN length(CAST(value_json AS BLOB))<=32768 THEN value_json ELSE NULL END AS value_json
      FROM workflow_run_inputs WHERE tenant_id=? AND run_id=?`,
      )
      .get(input.tenantId, input.runId) as
      | {
          value_id: string;
          value_digest: string;
          value_json: string | null;
        }
      | undefined;
    if (!row) return null;
    if (
      row.value_json === null ||
      row.value_id !== input.valueId ||
      row.value_digest !== input.valueDigest
    )
      throw new RunStoreError("workflow_run_input_authority_mismatch");
    const result: WorkflowRunInputAuthority = {
      schemaVersion: "crewon.workflow-execution-value.v0",
      valueId: row.value_id,
      valueDigest: row.value_digest,
      value: JSON.parse(row.value_json),
    };
    validateWorkflowInputAuthority(result);
    return result;
  }

  #loadReceipt(
    input: CommitWorkflowRunStartInput,
  ): CommitWorkflowRunStartResult | null {
    const row = this.#database
      .prepare(
        `SELECT r.tenant_id,r.run_id,
      CASE WHEN length(CAST(r.fingerprint AS BLOB))<=131072 THEN r.fingerprint ELSE NULL END AS fingerprint,
      CASE WHEN length(CAST(r.result_json AS BLOB))<=${MAX_AUTHORITY_BYTES} THEN r.result_json ELSE NULL END AS result_json,
      CASE WHEN a.tenant_id=r.tenant_id AND a.run_id=r.run_id AND length(CAST(a.authority_json AS BLOB))<=${MAX_AUTHORITY_BYTES}
        THEN a.authority_json ELSE NULL END AS authority_json
      FROM idempotency_receipts AS r LEFT JOIN workflow_run_admissions AS a USING(scope,idempotency_key)
      WHERE r.scope=? AND r.idempotency_key=?`,
      )
      .get(input.idempotency.scope, input.idempotency.key) as
      | {
          tenant_id: string;
          run_id: string;
          fingerprint: string | null;
          result_json: string | null;
          authority_json: string | null;
        }
      | undefined;
    if (!row) return null;
    const decoded = decodeWorkflowAdmissionReceipt(input, row);
    try {
      return completeWorkflowAdmissionReplay(
        input,
        decoded,
        this.#loadInput(decoded.inputRef),
      );
    } catch (cause) {
      throw new RunStoreError("workflow_run_admission_receipt_invalid", {
        cause,
      });
    }
  }
}
