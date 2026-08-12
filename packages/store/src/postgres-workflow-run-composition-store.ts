import {
  RunStoreError,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { PoolClient } from "pg";

import {
  beginPostgresRunAttempt,
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import { PostgresAttemptStore } from "./postgres-attempt-store.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import type { PostgresThreadStoreOptions } from "./postgres-thread-store.ts";
import {
  decodeWorkflowExecutionState,
  validateWorkflowExecutionState,
} from "./workflow-execution-store.ts";
import { migratePostgresWorkflowExecutions } from "./workflow-execution-schema.ts";
import { migratePostgresWorkflowVersions } from "./workflow-version-schema.ts";
import {
  assertExecutionBinding,
  assertAdmissionReplayAuthority,
  attemptId,
  claimReadyNodes,
  compositionFingerprint,
  gateStep,
  initialExecution,
  parseBoundWorkflow,
  type WorkflowCompositionResult,
} from "./workflow-run-composition-support.ts";

export type PostgresWorkflowRunCompositionStoreOptions =
  PostgresThreadStoreOptions & Readonly<{ digester: WorkflowContentDigester }>;

/** PostgreSQL production composition authority with row and advisory fences. */
export class PostgresWorkflowRunCompositionStore
  extends PostgresAttemptStore
  implements WorkflowRunCompositionStore
{
  readonly #digester: WorkflowContentDigester;

  constructor(options: PostgresWorkflowRunCompositionStoreOptions) {
    super(options);
    this.#digester = options.digester;
  }

  static override async open(
    options: PostgresWorkflowRunCompositionStoreOptions,
  ): Promise<PostgresWorkflowRunCompositionStore> {
    const store = new PostgresWorkflowRunCompositionStore(options);
    try {
      await store.migrate();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  override async migrate(): Promise<void> {
    await super.migrate();
    const client = await this.pool.connect();
    try {
      await migratePostgresWorkflowVersions(client, this.schemaSql());
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`crewon:${this.schema}:workflow-composition`],
      );
      await migratePostgresWorkflowExecutions(client, this.schemaSql());
      await client.query("COMMIT");
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async admitWorkflowNodes(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodes"]>[0],
  ): Promise<WorkflowCompositionResult> {
    const fingerprint = compositionFingerprint({
      ...input,
      digester: this.#digester,
    });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`workflow:${input.tenantId}:${input.runId}`],
      );
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        input.runId,
        input.lease,
      );
      const run = await this.loadRunWithin(
        client,
        { tenantId: input.tenantId, runId: input.runId },
        true,
      );
      if (
        run === null ||
        run.purpose !== "workflow" ||
        run.status !== "running" ||
        run.workflowVersionBinding?.workflowId !== input.binding.workflowId ||
        run.workflowVersionBinding.workflowVersionId !==
          input.binding.workflowVersionId ||
        run.workflowVersionBinding.contentDigest !== input.binding.contentDigest
      )
        throw new RunStoreError("workflow_composition_run_authority_mismatch");
      const workflowResult = await client.query<{ definition_json: string }>(
        `SELECT definition_json FROM ${this.schemaSql()}.workflow_versions
         WHERE tenant_id=$1 AND workflow_version_id=$2`,
        [input.tenantId, input.binding.workflowVersionId],
      );
      const definitionJson = workflowResult.rows[0]?.definition_json;
      if (definitionJson === undefined)
        throw new RunStoreError("workflow_composition_version_not_found");
      const workflow = parseBoundWorkflow(
        definitionJson,
        input.binding,
        this.#digester,
      );
      const receiptResult = await client.query<{
        fingerprint: string;
        result_json: unknown | null;
      }>(
        `SELECT fingerprint,result_json
         FROM ${this.schemaSql()}.workflow_execution_receipts
         WHERE tenant_id=$1 AND run_id=$2 AND operation_id=$3`,
        [input.tenantId, input.runId, input.schedulerOperationId],
      );
      const receipt = receiptResult.rows[0];
      if (receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint || receipt.result_json === null)
          throw new RunStoreError("workflow_composition_idempotency_conflict");
        const result = receipt.result_json as WorkflowCompositionResult;
        validateWorkflowExecutionState(result.execution);
        assertExecutionBinding(
          result.execution,
          input.tenantId,
          input.runId,
          input.binding,
          workflow,
        );
        if (!Array.isArray(result.admissions))
          throw new RunStoreError("workflow_composition_receipt_corrupt");
        for (const admission of result.admissions) {
          const locator = {
            tenantId: input.tenantId,
            runId: input.runId,
            stepId: admission.claim.node.nodeId,
          };
          const step = await loadPostgresRunStep(
            client,
            this.schemaSql(),
            locator,
            true,
          );
          const attempt =
            admission.attempt === null
              ? null
              : await loadPostgresRunAttempt(
                  client,
                  this.schemaSql(),
                  { ...locator, attemptId: admission.attempt.attemptId },
                  true,
                );
          assertAdmissionReplayAuthority(admission, step, attempt);
        }
        await this.validateExecutionLeaseWithin(
          client,
          input.tenantId,
          input.runId,
          input.lease,
        );
        await client.query("COMMIT");
        return structuredClone({ ...result, disposition: "replayed" as const });
      }

      const nowResult = await client.query<{ now: Date | string }>(
        "SELECT clock_timestamp() AS now",
      );
      const now = new Date(nowResult.rows[0]!.now).toISOString();
      let execution = await loadExecution(
        client,
        this.schemaSql(),
        input.tenantId,
        input.runId,
      );
      if (execution === null) {
        execution = initialExecution({
          tenantId: input.tenantId,
          runId: input.runId,
          workflow,
          updatedAt: now,
        });
        await client.query(
          `INSERT INTO ${this.schemaSql()}.workflow_executions
           (tenant_id,run_id,revision,state_json,updated_at) VALUES ($1,$2,$3,$4,$5)`,
          [input.tenantId, input.runId, 1, execution, now],
        );
      }
      assertExecutionBinding(
        execution,
        input.tenantId,
        input.runId,
        input.binding,
        workflow,
      );
      const claimed = claimReadyNodes({
        execution,
        workflow,
        operationId: input.schedulerOperationId,
        leaseDurationMs: input.leaseDurationMs,
        now,
        digester: this.#digester,
      });
      const admissions = [];
      for (const claim of claimed.claims) {
        if (claim.node.kind === "humanGate") {
          const existing = await loadPostgresRunStep(
            client,
            this.schemaSql(),
            {
              tenantId: input.tenantId,
              runId: input.runId,
              stepId: claim.node.nodeId,
            },
            true,
          );
          if (existing !== null)
            throw new RunStoreError("workflow_composition_step_conflict");
          const step = gateStep({
            tenantId: input.tenantId,
            runId: input.runId,
            nodeId: claim.node.nodeId,
            now,
          });
          await client.query(
            `INSERT INTO ${this.schemaSql()}.run_steps
             (tenant_id,run_id,step_id,kind,status,revision,current_attempt_id,
              attempt_count,state_json,created_at,updated_at,terminal_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              step.tenantId,
              step.runId,
              step.stepId,
              step.kind,
              step.status,
              1,
              null,
              0,
              step,
              now,
              now,
              null,
            ],
          );
          admissions.push({ claim, step, attempt: null });
        } else {
          const started = await beginPostgresRunAttempt(
            client,
            this.schemaSql(),
            {
              tenantId: input.tenantId,
              runId: input.runId,
              lease: input.lease,
              stepId: claim.node.nodeId,
              kind:
                claim.node.kind === "verification" ? "verification" : "agent",
              attemptId: attemptId(
                input.schedulerOperationId,
                claim.node.nodeId,
                this.#digester,
              ),
              startedAt: now,
            },
          );
          admissions.push({
            claim,
            step: started.step,
            attempt: started.attempt,
          });
        }
      }
      execution = claimed.execution;
      validateWorkflowExecutionState(execution);
      await client.query(
        `UPDATE ${this.schemaSql()}.workflow_executions
         SET revision=$1,state_json=$2,updated_at=$3 WHERE tenant_id=$4 AND run_id=$5`,
        [execution.revision, execution, now, input.tenantId, input.runId],
      );
      const result = {
        disposition: "committed" as const,
        execution,
        admissions,
      } satisfies WorkflowCompositionResult;
      await client.query(
        `INSERT INTO ${this.schemaSql()}.workflow_execution_receipts
         (tenant_id,run_id,operation_id,fingerprint,state_json,result_json)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.tenantId,
          input.runId,
          input.schedulerOperationId,
          fingerprint,
          execution,
          result,
        ],
      );
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        input.runId,
        input.lease,
      );
      await client.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      await rollbackPostgres(client);
      throw error instanceof RunStoreError
        ? error
        : new RunStoreError("workflow_composition_store_failed", {
            cause: error instanceof Error ? error : undefined,
          });
    } finally {
      client.release();
    }
  }
}

async function loadExecution(
  client: PoolClient,
  schema: string,
  tenantId: string,
  runId: string,
) {
  const result = await client.query<{ state_json: unknown }>(
    `SELECT state_json FROM ${schema}.workflow_executions
     WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [tenantId, runId],
  );
  return result.rows[0] === undefined
    ? null
    : decodeWorkflowExecutionState(result.rows[0].state_json);
}
