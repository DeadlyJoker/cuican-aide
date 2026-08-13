import {
  canonicalJson,
  RunStoreError,
  type CommitWorkflowRunStartInput,
  type CommitWorkflowRunStartResult,
  type ModelDispatchEvidenceStore,
  type WorkflowNodeContinuationStore,
  type WorkflowRunAdmissionStore,
  type WorkflowRunCompositionStore,
  type WorkflowRuntimeStore,
  type WorkflowToolApprovalStore,
} from "@crewon/application";
import {
  createWorkflowNodeTerminalEvidence,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { PoolClient } from "pg";

import { PostgresExecutionStore } from "./postgres-execution-store.ts";
import {
  loadPostgresModelDispatchReceipt,
  migratePostgresModelDispatchEvidence,
  preparePostgresModelDispatch,
  transitionPostgresModelDispatch,
} from "./postgres-model-dispatch-evidence.ts";
import {
  recordPostgresWorkflowGateDecision,
  settlePostgresWorkflowGate,
} from "./postgres-workflow-gate-settlement.ts";
import { cancelPostgresWorkflowExecution } from "./postgres-workflow-cancellation.ts";
import { settlePostgresWorkflowNode } from "./postgres-workflow-node-settlement.ts";
import { settlePostgresWorkflowNodeModelTerminal } from "./postgres-workflow-model-settlement.ts";
import {
  commitPostgresWorkflowToolContinuation,
  loadPostgresWorkflowNodeContinuation,
  migratePostgresWorkflowNodeContinuations,
  writePostgresWorkflowNodeContinuation,
} from "./postgres-workflow-node-continuation.ts";
import {
  commitPostgresWorkflowRunStart,
  readPostgresWorkflowRunStartReplay,
} from "./postgres-workflow-run-admission.ts";
import { schedulePostgresWorkflowReconciliation } from "./postgres-workflow-reconciliation.ts";
import { reconcilePostgresWorkflowNode } from "./postgres-workflow-reconcile-node.ts";
import { settlePreparedPostgresWorkflowNodeTerminal } from "./postgres-workflow-terminal-candidate.ts";
import {
  admitPostgresWorkflowNodeWork,
  loadPostgresWorkflowExecution,
  schedulePostgresWorkflowNodes,
} from "./postgres-workflow-run-composition-transactions.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import type { PostgresThreadStoreOptions } from "./postgres-thread-store.ts";
import {
  decodeWorkflowExecutionState,
} from "./workflow-execution-state.ts";
import { parseBoundWorkflow } from "./workflow-run-composition-support.ts";
import { migratePostgresWorkflowExecutions } from "./workflow-execution-schema.ts";
import { migratePostgresWorkflowVersions } from "./workflow-version-schema.ts";
import {
  consumePostgresWorkflowToolApproval,
  migratePostgresWorkflowToolApprovals,
  publishPostgresWorkflowToolApproval,
} from "./postgres-workflow-tool-approval.ts";

export type PostgresWorkflowRunCompositionStoreOptions =
  PostgresThreadStoreOptions & Readonly<{ digester: WorkflowContentDigester }>;

/** PostgreSQL production composition authority with row and advisory fences. */
export class PostgresWorkflowRunCompositionStore
  extends PostgresExecutionStore
  implements
    WorkflowRuntimeStore,
    WorkflowRunCompositionStore,
    WorkflowRunAdmissionStore,
    ModelDispatchEvidenceStore,
    WorkflowToolApprovalStore
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
      await migratePostgresModelDispatchEvidence(client, this.schemaSql());
      await migratePostgresWorkflowNodeContinuations(client, this.schemaSql());
      await migratePostgresWorkflowToolApprovals(client, this.schemaSql());
      await client.query("COMMIT");
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadWorkflowExecution(input: { tenantId: string; runId: string }) {
    this.assertOpen();
    const result = await this.pool.query<{ state_json: unknown }>(
      `SELECT state_json FROM ${this.schemaSql()}.workflow_executions
       WHERE tenant_id=$1 AND run_id=$2`,
      [input.tenantId, input.runId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : decodeWorkflowExecutionState(row.state_json);
  }

  async publishWorkflowToolApproval(
    input: Parameters<WorkflowToolApprovalStore["publishWorkflowToolApproval"]>[0],
  ): ReturnType<WorkflowToolApprovalStore["publishWorkflowToolApproval"]> {
    return this.#transaction(input.authority, async (client) => {
      const run = await this.loadRunWithin(client, input.authority, true);
      if (run === null) throw new RunStoreError("run_not_found");
      const result = await publishPostgresWorkflowToolApproval(
        client,
        this.schemaSql(),
        input,
        run,
        this.#digester,
      );
      if (result.disposition === "published") {
        await this.completeWorkItemWithin(
          client,
          input.authority.tenantId,
          input.authority.runId,
          input.lease,
        );
      }
      return result;
    });
  }

  async consumeWorkflowToolApproval(
    input: Parameters<WorkflowToolApprovalStore["consumeWorkflowToolApproval"]>[0],
  ): ReturnType<WorkflowToolApprovalStore["consumeWorkflowToolApproval"]> {
    return this.#transaction(input.authority, async (client) => {
      await this.validateExecutionLeaseWithin(
        client,
        input.authority.tenantId,
        input.authority.runId,
        input.lease,
      );
      return consumePostgresWorkflowToolApproval(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      );
    });
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
    input: Parameters<
      WorkflowRunCompositionStore["settleWorkflowHumanGate"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowHumanGate"]> {
    return this.#transaction(input, (client) =>
      settlePostgresWorkflowGate(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      ),
    );
  }

  async scheduleWorkflowReconciliation(
    input: Parameters<
      WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]> {
    return this.#transaction(input, (client) =>
      schedulePostgresWorkflowReconciliation(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      ),
    );
  }

  async recordWorkflowHumanGateDecision(
    input: Parameters<
      WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
    >[0],
  ): ReturnType<
    WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
  > {
    return this.#transaction(input, (client) =>
      recordPostgresWorkflowGateDecision(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      ),
    );
  }

  async reconcileWorkflowNode(
    input: Parameters<WorkflowRunCompositionStore["reconcileWorkflowNode"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["reconcileWorkflowNode"]> {
    return this.#transaction(input, (client) =>
      reconcilePostgresWorkflowNode(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      ),
    );
  }

  async cancelWorkflowExecution(
    input: Parameters<
      WorkflowRunCompositionStore["cancelWorkflowExecution"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["cancelWorkflowExecution"]> {
    return this.#transaction(input, (client) =>
      cancelPostgresWorkflowExecution(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      ),
    );
  }

  async loadModelDispatchReceipt(
    locator: Parameters<
      ModelDispatchEvidenceStore["loadModelDispatchReceipt"]
    >[0],
  ): ReturnType<ModelDispatchEvidenceStore["loadModelDispatchReceipt"]> {
    this.assertOpen();
    return loadPostgresModelDispatchReceipt(
      this.pool,
      this.schemaSql(),
      locator,
    );
  }

  async prepareModelDispatch(
    input: Parameters<ModelDispatchEvidenceStore["prepareModelDispatch"]>[0],
  ): ReturnType<ModelDispatchEvidenceStore["prepareModelDispatch"]> {
    return this.#modelDispatchTransaction(input, (client) =>
      preparePostgresModelDispatch(client, this.schemaSql(), input),
    );
  }

  async markModelDispatchPossiblySent(
    input: Parameters<
      ModelDispatchEvidenceStore["markModelDispatchPossiblySent"]
    >[0],
  ): ReturnType<ModelDispatchEvidenceStore["markModelDispatchPossiblySent"]> {
    return this.#modelDispatchTransaction(input, (client) =>
      transitionPostgresModelDispatch(
        client,
        this.schemaSql(),
        input,
        "possiblySent",
      ),
    );
  }

  async observeModelDispatchResponse(
    input: Parameters<
      ModelDispatchEvidenceStore["observeModelDispatchResponse"]
    >[0],
  ): ReturnType<ModelDispatchEvidenceStore["observeModelDispatchResponse"]> {
    return this.#modelDispatchTransaction(input, (client) =>
      transitionPostgresModelDispatch(
        client,
        this.schemaSql(),
        input,
        "responseObserved",
      ),
    );
  }

  async terminateModelDispatch(
    input: Parameters<ModelDispatchEvidenceStore["terminateModelDispatch"]>[0],
  ): ReturnType<ModelDispatchEvidenceStore["terminateModelDispatch"]> {
    return this.#modelDispatchTransaction(input, (client) =>
      transitionPostgresModelDispatch(
        client,
        this.schemaSql(),
        input,
        "terminal",
      ),
    );
  }

  async settleWorkflowNodeModelTerminal(
    input: Parameters<
      WorkflowNodeContinuationStore["settleWorkflowNodeModelTerminal"]
    >[0],
  ): ReturnType<
    WorkflowNodeContinuationStore["settleWorkflowNodeModelTerminal"]
  > {
    return this.#transaction(input.authority, (client) =>
      settlePostgresWorkflowNodeModelTerminal(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      ),
    );
  }

  async settlePreparedWorkflowNodeTerminal(
    input: Parameters<
      WorkflowNodeContinuationStore["settlePreparedWorkflowNodeTerminal"]
    >[0],
  ): ReturnType<
    WorkflowNodeContinuationStore["settlePreparedWorkflowNodeTerminal"]
  > {
    return this.#transaction(input.authority, (client) =>
      settlePreparedPostgresWorkflowNodeTerminal(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      ),
    );
  }

  async loadWorkflowNodeContinuation(
    authority: Parameters<
      WorkflowNodeContinuationStore["loadWorkflowNodeContinuation"]
    >[0],
  ): ReturnType<WorkflowNodeContinuationStore["loadWorkflowNodeContinuation"]> {
    this.assertOpen();
    return this.#loadWorkflowNodeContinuation(authority);
  }

  async #loadWorkflowNodeContinuation(
    authority: Parameters<
      WorkflowNodeContinuationStore["loadWorkflowNodeContinuation"]
    >[0],
  ) {
    const client = await this.pool.connect();
    try {
      return await loadPostgresWorkflowNodeContinuation(
        client,
        this.schemaSql(),
        authority,
      );
    } finally {
      client.release();
    }
  }

  async commitWorkflowAssistantContinuation(
    input: Parameters<
      WorkflowNodeContinuationStore["commitWorkflowAssistantContinuation"]
    >[0],
  ): ReturnType<
    WorkflowNodeContinuationStore["commitWorkflowAssistantContinuation"]
  > {
    return this.#transaction(input.authority, async (client) => {
      await this.validateExecutionLeaseWithin(
        client,
        input.authority.tenantId,
        input.authority.runId,
        input.lease,
      );
      let terminalCandidate = null;
      if (input.terminalResult !== null) {
        if (input.next.activeDispatch?.status !== "responseObserved")
          throw new RunStoreError("workflow_terminal_candidate_dispatch_mismatch");
        const execution = await loadPostgresWorkflowExecution(
          client,
          this.schemaSql(),
          input.authority,
          false,
        );
        if (execution === null)
          throw new RunStoreError("workflow_execution_not_found");
        const version = await client.query<{ definition_json: string }>(
          `SELECT definition_json FROM ${this.schemaSql()}.workflow_versions
           WHERE tenant_id=$1 AND workflow_version_id=$2 AND content_digest=$3`,
          [input.authority.tenantId, execution.workflowVersionId,
            execution.contentDigest],
        );
        const workflow = parseBoundWorkflow(
          version.rows[0]?.definition_json ?? "",
          { workflowId: execution.workflowId,
            workflowVersionId: execution.workflowVersionId,
            contentDigest: execution.contentDigest },
          this.#digester,
        );
        let outcome;
        if (input.terminalResult.status === "completed") {
          let value: unknown;
          try { value = JSON.parse(input.terminalResult.output); }
          catch { throw new RunStoreError("workflow_terminal_candidate_invalid"); }
          outcome = { status: "completed" as const,
            value: value as import("@crewon/domain").WorkflowSchemaValue };
        } else if (input.terminalResult.status === "failed") {
          outcome = { ...input.terminalResult,
            certainty: "responseObserved" as const };
        } else {
          outcome = { status: "canceled" as const,
            certainty: "responseObserved" as const };
        }
        const evidence = createWorkflowNodeTerminalEvidence({ workflow,
          nodeId: input.authority.nodeId, outcome, digester: this.#digester });
        const dispatchTerminalOutcome = { kind: input.terminalResult.status,
          code: input.terminalResult.status === "failed"
            ? input.terminalResult.failureCode
            : input.terminalResult.status === "canceled"
              ? "workflow_node_canceled" : null,
          certainty: "responseObserved" as const };
        terminalCandidate = {
          schemaVersion: "crewon.workflow-node-terminal-candidate.v0" as const,
          candidateId: this.#digester.sha256(canonicalJson({
            authority: input.authority, segmentId: input.next.segmentId,
            evidence, dispatchTerminalOutcome })),
          segmentId: input.next.segmentId, evidence, dispatchTerminalOutcome,
        };
      }
      return writePostgresWorkflowNodeContinuation(
        client,
        this.schemaSql(),
        input.authority,
        input.expectedContinuationRevision,
        { ...input.next, terminalCandidate },
        input.committedAt,
      );
    });
  }

  async commitWorkflowToolContinuation(
    input: Parameters<
      WorkflowNodeContinuationStore["commitWorkflowToolContinuation"]
    >[0],
  ): ReturnType<
    WorkflowNodeContinuationStore["commitWorkflowToolContinuation"]
  > {
    return this.#transaction(input.authority, async (client) => {
      await this.validateExecutionLeaseWithin(
        client,
        input.authority.tenantId,
        input.authority.runId,
        input.lease,
      );
      return commitPostgresWorkflowToolContinuation(
        client,
        this.schemaSql(),
        input,
        this.#digester,
      );
    });
  }

  async #modelDispatchTransaction<T>(
    input: Readonly<{
      tenantId: string;
      runId: string;
      lease: Parameters<
        ModelDispatchEvidenceStore["prepareModelDispatch"]
      >[0]["lease"];
    }>,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.#transaction(input, async (client) => {
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        input.runId,
        input.lease,
      );
      const result = await operation(client);
      await this.validateExecutionLeaseWithin(
        client,
        input.tenantId,
        input.runId,
        input.lease,
      );
      return result;
    });
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
