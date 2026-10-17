import { listPostgresWorkflowRuns } from "./postgres-workflow-run-list.ts";
import type { Pool, PoolClient } from "pg";
import {
  parseWorkflowRunSnapshotResponse,
  type WorkflowRunSnapshotResponse,
} from "@crewon/contracts";
import {
  ApplicationError,
  canonicalJson,
  initialWorkflowExecution,
  RunStoreError,
  type RunLocator,
  type WorkflowRunReadStore,
  type WorkflowRunListStore,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { validatePostgresSchemaName } from "./postgres-queue-schema.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { readPostgresWorkflowCompositionContext } from "./postgres-workflow-composition-context.ts";
import { readPostgresWorkflowExecution } from "./postgres-workflow-execution-authority.ts";
import { readPostgresWorkflowSchedulerAuthority } from "./postgres-workflow-scheduler-authority.ts";
import { postgresWorkflowHumanGateSchemaPresent } from "./postgres-workflow-human-gate-schema.ts";
import {
  MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES,
  decodeWorkflowAdmissionReceipt,
  completeWorkflowAdmissionReplay,
  type WorkflowAdmissionReceiptRow,
} from "./workflow-run-admission-receipt.ts";

type ReadInput = Parameters<WorkflowRunReadStore["readWorkflowRunSnapshot"]>[0];
type Dependencies = {
  assertOpen(): void;
  loadRun(client: PoolClient, locator: RunLocator): Promise<RunState | null>;
};

/** Reads never migrate, claim work, take aggregate write locks or advance a Workflow. */
export class PostgresWorkflowRunQueryStore
  implements WorkflowRunReadStore, WorkflowRunListStore
{
  private readonly sql: string;
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly dependencies: Dependencies;
  constructor(pool: Pool, schema: string, dependencies: Dependencies) {
    this.pool = pool;
    this.schema = schema;
    this.dependencies = dependencies;
    validatePostgresSchemaName(schema);
    this.sql = `"${schema}"`;
  }

  async listWorkflowRuns(
    input: Parameters<WorkflowRunListStore["listWorkflowRuns"]>[0],
  ) {
    this.dependencies.assertOpen();
    return listPostgresWorkflowRuns(this.pool, this.schema, input);
  }

  async readWorkflowRunSnapshot(
    input: ReadInput,
  ): Promise<WorkflowRunSnapshotResponse> {
    this.dependencies.assertOpen();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const bounds = await client.query<{ bytes: number }>(
        `SELECT octet_length(state_json::text) AS bytes FROM ${this.sql}.run_snapshots WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3 LIMIT 2`,
        [input.tenantId, input.spaceId, input.runId],
      );
      if (!bounds.rows.length)
        throw new RunStoreError("workflow_run_not_found");
      if (bounds.rows.length !== 1 || bounds.rows[0]!.bytes > 65536) corrupt();
      const run = await this.dependencies.loadRun(client, input);
      if (
        !run ||
        run.spaceId !== input.spaceId ||
        run.purpose !== "workflow" ||
        !run.workflowVersionBinding
      )
        throw new RunStoreError("workflow_run_not_found");
      await input.authorize({ runId: run.runId, threadId: run.threadId });
      const context = await this.context(client, run);
      const execution = await this.execution(client, input);
      const hasGates = await postgresWorkflowHumanGateSchemaPresent(
        client,
        this.schema,
      );
      const authority =
        execution === null
          ? null
          : await readPostgresWorkflowSchedulerAuthority(
              client,
              this.sql,
              { ...input, binding: run.workflowVersionBinding },
              run,
              context,
              { loadChild: this.dependencies.loadRun },
              { humanGatesEnabled: hasGates, lock: "snapshot" },
            );
      if (authority === null) {
        const orphans = await client.query(
          `SELECT 1 FROM ${this.sql}.run_steps WHERE tenant_id=$1 AND run_id=$2 LIMIT 1`,
          [input.tenantId, input.runId],
        );
        if (
          orphans.rows.length ||
          ["completed", "failed", "canceled"].includes(run.status)
        )
          corrupt();
      }
      const children = [...(authority?.children.values() ?? [])];
      for (const child of children)
        await input.authorize({
          runId: child.run.runId,
          threadId: child.run.threadId,
        });
      const state =
        authority?.execution ??
        initialWorkflowExecution({
          tenantId: run.tenantId,
          runId: run.runId,
          workflow: context.workflow,
          now: run.createdAt,
        });
      const nodes = state.nodes.map((node) => {
        const definition = context.workflow.nodes.find(
          (value) => value.nodeId === node.nodeId,
        )!;
        const child =
          node.claimId === null
            ? null
            : (authority?.children.get(node.claimId)?.run ?? null);
        const gate = authority?.gates.get(node.nodeId)?.authority ?? null;
        const output = authority?.rows.get(node.nodeId)?.output_json;
        return {
          nodeId: node.nodeId,
          kind: node.kind,
          title: definition.title,
          agentVersionId: node.agentVersionId,
          status: node.status,
          inputDigest: node.inputDigest,
          resultDigest: node.resultDigest,
          failureCode: node.failureCode,
          child:
            child === null
              ? null
              : {
                  runId: child.runId,
                  threadId: child.threadId,
                  status: child.status,
                  revision: child.revision,
                },
          gate:
            gate === null
              ? null
              : {
                  gateRequestId: gate.gateRequestId,
                  approvalPolicyId: gate.approvalPolicyId,
                  inputDigest: gate.inputDigest,
                },
          output: output == null ? null : JSON.parse(output),
        };
      });
      const response = parseWorkflowRunSnapshotResponse(
        {
          schemaVersion: "crewon.workflow-run-snapshot.v0",
          run: publicRun(run),
          workflow: {
            name: context.workflow.name,
            description: context.workflow.description,
          },
          input: context.rootInput.value,
          execution:
            execution === null
              ? null
              : {
                  revision: execution.revision,
                  status: execution.status,
                  cancelRequested: execution.cancelRequested,
                  updatedAt: execution.updatedAt,
                },
          nodes,
        },
        input.runId,
      );
      // Authorization is current policy, not a grant inferred from persisted ownership.
      await input.authorize({ runId: run.runId, threadId: run.threadId });
      for (const child of children)
        await input.authorize({
          runId: child.run.runId,
          threadId: child.run.threadId,
        });
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await rollbackPostgres(client);
      // Preserve application authorization errors raised by the trusted callback.
      if (
        error instanceof ApplicationError &&
        error.category === "authorization"
      )
        throw error;
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  private async execution(client: PoolClient, input: ReadInput) {
    // Admission and execution are separate capabilities. A queued admission is
    // readable before the execution schema is installed; a partial schema is not.
    const names = [
      "workflow_executions",
      "workflow_execution_receipts",
      "workflow_composition_schema",
      "workflow_node_admissions",
      "workflow_node_passes",
      "workflow_node_children",
    ];
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])",
      [this.schema, names],
    );
    const executionTables = tables.rows.filter((row) =>
      names.slice(0, 2).includes(row.tablename),
    ).length;
    const compositionTables = tables.rows.length - executionTables;
    if (
      (executionTables !== 0 && executionTables !== 2) ||
      (compositionTables !== 0 && compositionTables !== 4) ||
      (compositionTables === 4 && executionTables !== 2)
    )
      corrupt();
    if (compositionTables === 4) {
      const version = await client.query<{
        singleton: boolean;
        version: number;
      }>(
        `SELECT singleton,version FROM ${this.sql}.workflow_composition_schema LIMIT 2`,
      );
      if (
        version.rows.length !== 1 ||
        version.rows[0]?.singleton !== true ||
        version.rows[0].version !== 1
      )
        corrupt();
    }
    if (executionTables === 0) return null;
    const execution = await readPostgresWorkflowExecution(
      client,
      this.sql,
      input,
      { lock: "snapshot" },
    );
    if (execution !== null && compositionTables !== 4) corrupt();
    return execution;
  }

  private async context(client: PoolClient, run: RunState) {
    const version = await client.query<{ singleton: boolean; version: number }>(
      `SELECT singleton,version FROM ${this.sql}.workflow_run_admission_schema LIMIT 2`,
    );
    if (
      version.rows.length !== 1 ||
      version.rows[0]?.singleton !== true ||
      version.rows[0].version !== 1
    )
      corrupt();
    const receipts = await client.query<
      WorkflowAdmissionReceiptRow & { scope: string; idempotency_key: string }
    >(
      `SELECT a.scope,a.idempotency_key,r.tenant_id,r.run_id,r.fingerprint,
       CASE WHEN octet_length(r.result_json::text)<=${MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES} THEN r.result_json::text ELSE NULL END AS result_json,
       CASE WHEN octet_length(a.authority_json)<=${MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES} THEN a.authority_json ELSE NULL END AS authority_json
       FROM ${this.sql}.workflow_run_admissions a JOIN ${this.sql}.idempotency_receipts r ON r.scope=a.scope AND r.idempotency_key=a.idempotency_key
       WHERE a.tenant_id=$1 AND a.run_id=$2 LIMIT 2`,
      [run.tenantId, run.runId],
    );
    const receipt = receipts.rows[0];
    if (
      receipts.rows.length !== 1 ||
      !receipt?.result_json ||
      !receipt.authority_json ||
      !receipt.fingerprint ||
      receipt.run_id !== run.runId
    )
      corrupt();
    const original: unknown = JSON.parse(receipt.result_json);
    const workItems = (original as { workItems?: { workItemId?: unknown }[] })
      ?.workItems;
    if (
      !Array.isArray(workItems) ||
      workItems.length !== 1 ||
      typeof workItems[0]?.workItemId !== "string" ||
      !workItems[0].workItemId.trim() ||
      Buffer.byteLength(workItems[0].workItemId) > 512
    )
      corrupt();
    const context = await readPostgresWorkflowCompositionContext(
      client,
      this.sql,
      {
        run,
        binding: run.workflowVersionBinding!,
        lease: { workItemId: workItems[0].workItemId },
      },
    );
    const command = {
      tenantId: run.tenantId,
      spaceId: run.spaceId,
      threadId: run.threadId,
      workflowVersionId: run.workflowVersionBinding!.workflowVersionId,
      workflowInput: context.rootInput.value,
      idempotency: {
        scope: receipt.scope,
        key: receipt.idempotency_key,
        requestFingerprint: receipt.fingerprint,
      },
      prepare: (): never => {
        throw new RunStoreError("workflow_read_must_not_prepare");
      },
    };
    const decoded = decodeWorkflowAdmissionReceipt(command, receipt);
    completeWorkflowAdmissionReplay(command, decoded, context.rootInput);
    if (
      canonicalJson(decoded.authority) !== canonicalJson(context.authority) ||
      canonicalJson(decoded.run.workItems[0]) !==
        canonicalJson(context.workItem)
    )
      corrupt();
    for (const key of [
      "createdByActorId",
      "toolPermissionMode",
      "createdAt",
      "collaborationMode",
      "goalBinding",
    ] as const)
      if (
        canonicalJson(decoded.run.state[key] ?? null) !==
        canonicalJson(run[key] ?? null)
      )
        corrupt();
    return context;
  }
}

function publicRun(run: RunState) {
  const {
    runId,
    threadId,
    status,
    revision,
    lastSequence,
    cancelRequested,
    collaborationMode,
    workflowVersionBinding,
    goalBinding,
    outputRef,
    failure,
    createdAt,
    updatedAt,
    terminalAt,
  } = run;
  return {
    runId,
    threadId,
    status,
    revision,
    lastSequence,
    cancelRequested,
    collaborationMode,
    purpose: "workflow",
    workflowVersionBinding,
    goalBinding,
    outputRef,
    failure,
    createdAt,
    updatedAt,
    terminalAt,
    waitingApproval:
      run.waitingApproval === null
        ? null
        : { approvalId: run.waitingApproval.approvalId },
  };
}
function corrupt(): never {
  throw new RunStoreError("workflow_read_authority_corrupt");
}
