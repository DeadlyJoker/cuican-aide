import {
  RunStoreError,
  type CommitWorkflowRunStartInput,
  type CommitWorkflowRunStartResult,
  type WorkflowRunAdmissionStore,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { PoolClient } from "pg";

import { PostgresAttemptStore } from "./postgres-attempt-store.ts";
import { settlePostgresWorkflowNode } from "./postgres-workflow-node-settlement.ts";
import {
  commitPostgresWorkflowRunStart,
  readPostgresWorkflowRunStartReplay,
} from "./postgres-workflow-run-admission.ts";
import {
  admitPostgresWorkflowNodeWork,
  schedulePostgresWorkflowNodes,
} from "./postgres-workflow-run-composition-transactions.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import type { PostgresThreadStoreOptions } from "./postgres-thread-store.ts";
import {
  decodeWorkflowExecutionState,
  validateWorkflowExecutionState,
} from "./workflow-execution-store.ts";
import { migratePostgresWorkflowExecutions } from "./workflow-execution-schema.ts";
import { migratePostgresWorkflowVersions } from "./workflow-version-schema.ts";

export type PostgresWorkflowRunCompositionStoreOptions =
  PostgresThreadStoreOptions & Readonly<{ digester: WorkflowContentDigester }>;

/** PostgreSQL production composition authority with row and advisory fences. */
export class PostgresWorkflowRunCompositionStore
  extends PostgresAttemptStore
  implements WorkflowRunCompositionStore, WorkflowRunAdmissionStore
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
      await migratePostgresWorkflowVersions(client, this.schema);
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`crewon:${this.schema}:workflow-composition`],
      );
      await migratePostgresWorkflowExecutions(client, this.schema);
      await client.query("COMMIT");
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async scheduleWorkflowNodes(
    input: Parameters<WorkflowRunCompositionStore["scheduleWorkflowNodes"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowNodes"]> {
    return this.#transaction(input, (client) =>
      schedulePostgresWorkflowNodes(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      ),
    );
  }

  async admitWorkflowNodeWork(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["admitWorkflowNodeWork"]> {
    return this.#transaction(input, (client) =>
      admitPostgresWorkflowNodeWork(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      ),
    );
  }

  async commitWorkflowRunStart(
    input: CommitWorkflowRunStartInput,
  ): Promise<CommitWorkflowRunStartResult> {
    this.assertOpen();
    const replay = await readPostgresWorkflowRunStartReplay(
      this.pool,
      this.schemaSql(),
      input,
      this.#digester,
    );
    if (replay !== null) return replay;
    const candidateRoute = await input.resolveCandidateRoute();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await commitPostgresWorkflowRunStart(
        client,
        this.schemaSql(),
        input,
        candidateRoute,
        this.#digester,
        (commit, beforeWrite) =>
          this.commitRunWithin(client, commit, {
            beforeWrite,
            workItemPayloadKind: "workflowScheduler",
          }),
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw error instanceof RunStoreError
        ? error
        : new RunStoreError("workflow_run_admission_store_failed", {
            cause: error instanceof Error ? error : undefined,
          });
    } finally {
      client.release();
    }
  }

  async settleWorkflowNode(
    input: Parameters<WorkflowRunCompositionStore["settleWorkflowNode"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowNode"]> {
    return this.#transaction(input, (client) =>
      settlePostgresWorkflowNode(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      ),
    );
  }

  async settleWorkflowHumanGate(
    _input: Parameters<
      WorkflowRunCompositionStore["settleWorkflowHumanGate"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowHumanGate"]> {
    throw new RunStoreError("workflow_composition_contract_incomplete");
  }

  async scheduleWorkflowReconciliation(
    _input: Parameters<
      WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]> {
    throw new RunStoreError("workflow_composition_contract_incomplete");
  }

  async recordWorkflowHumanGateDecision(
    _input: Parameters<
      WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
    >[0],
  ): ReturnType<
    WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
  > {
    throw new RunStoreError("workflow_composition_contract_incomplete");
  }

  async reconcileWorkflowNode(
    _input: Parameters<WorkflowRunCompositionStore["reconcileWorkflowNode"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["reconcileWorkflowNode"]> {
    throw new RunStoreError("workflow_composition_contract_incomplete");
  }

  async cancelWorkflowExecution(
    _input: Parameters<
      WorkflowRunCompositionStore["cancelWorkflowExecution"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["cancelWorkflowExecution"]> {
    throw new RunStoreError("workflow_composition_contract_incomplete");
  }

  async #transaction<T>(
    input: { tenantId: string; runId: string },
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`workflow:${input.tenantId}:${input.runId}`],
      );
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
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
