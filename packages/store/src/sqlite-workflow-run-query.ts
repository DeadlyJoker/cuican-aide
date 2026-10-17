import type { DatabaseSync } from "node:sqlite";
import {
  ApplicationError,
  RunStoreError,
  canonicalJson,
  type RunLocator,
  type WorkflowRunReadStore,
  type WorkflowRunListStore,
} from "@crewon/application";
import {
  captureWorkflowRunListQuery,
  formatWorkflowRunListCursor,
  parseWorkflowRunListResponse,
  parseRunView,
} from "@crewon/contracts";
import type { RunState } from "@crewon/domain";
import { normalizeSqliteError } from "./sqlite-errors.ts";
import { assertSqliteWorkflowRunAdmissionSchema } from "./sqlite-workflow-run-admission-schema.ts";
import { assertSqliteWorkflowCompositionSchema } from "./sqlite-workflow-composition-schema.ts";
import { assertSqliteWorkflowChildSchema } from "./sqlite-workflow-child-schema.ts";
import { readSqliteWorkflowCompositionContext } from "./sqlite-workflow-composition-context.ts";
import { readSqliteWorkflowExecution } from "./sqlite-workflow-execution-authority.ts";
import {
  readSqliteWorkflowNodes,
  sqliteWorkflowNodeAdmission,
} from "./sqlite-workflow-node-authority.ts";
import { readSqliteWorkflowChildren } from "./sqlite-workflow-child-dispatch.ts";
import { readSqliteWorkflowHumanGates } from "./sqlite-workflow-human-gate-authority.ts";
import { assertSqliteWorkflowExecutionShape } from "./workflow-execution-schema.ts";
import { workflowReadProjection } from "./workflow-read-projection.ts";
import { sqlitePublicRunSummaryColumns } from "./thread-transcript-run-snapshot.ts";
import {
  MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES,
  decodeWorkflowAdmissionReceipt,
  completeWorkflowAdmissionReplay,
  type WorkflowAdmissionReceiptRow,
} from "./workflow-run-admission-receipt.ts";

type ReadInput = Parameters<WorkflowRunReadStore["readWorkflowRunSnapshot"]>[0];
type ListInput = Parameters<WorkflowRunListStore["listWorkflowRuns"]>[0];
type Ops = { assertOpen(): void; loadRun(input: RunLocator): RunState | null };

/** Capture one short synchronous read transaction, then authorize the captured
 * identities. Never hold SQLite's transaction across an asynchronous callback.
 * Construction and reads do not migrate or advance execution.
 */
export class SqliteWorkflowRunQueryStore
  implements WorkflowRunReadStore, WorkflowRunListStore
{
  readonly #db: DatabaseSync;
  readonly #ops: Ops;
  constructor(db: DatabaseSync, ops: Ops) {
    this.#db = db;
    this.#ops = ops;
  }
  async readWorkflowRunSnapshot(input: ReadInput) {
    this.#ops.assertOpen();
    const root = this.root(input);
    await input.authorize({ runId: root.runId, threadId: root.threadId });
    this.#ops.assertOpen();
    const captured = this.snapshot(() => {
      const run = this.root(input),
        context = this.context(run);
      const names = [
        "workflow_execution_schema",
        "workflow_executions",
        "workflow_execution_receipts",
        "workflow_composition_schema",
        "workflow_node_admissions",
        "workflow_node_passes",
      ];
      const present = this.tables(names),
        executionCount = names
          .slice(0, 3)
          .filter((name) => present.has(name)).length,
        compositionCount = names
          .slice(3)
          .filter((name) => present.has(name)).length;
      if (
        (executionCount !== 0 && executionCount !== 3) ||
        (compositionCount !== 0 && compositionCount !== 3) ||
        (compositionCount === 3 && executionCount !== 3)
      )
        corrupt();
      const hasChildren = assertSqliteWorkflowChildSchema(this.#db);
      if (hasChildren && compositionCount !== 3) corrupt();
      if (compositionCount === 3)
        assertSqliteWorkflowCompositionSchema(this.#db);
      if (executionCount === 3) {
        assertSqliteWorkflowExecutionShape(this.#db);
        const versions = this.#db
          .prepare(
            "SELECT singleton,version FROM workflow_execution_schema LIMIT 2",
          )
          .all();
        if (
          versions.length !== 1 ||
          versions[0]!.singleton !== 1 ||
          versions[0]!.version !== 1
        )
          corrupt();
      }
      const execution =
        executionCount === 3
          ? readSqliteWorkflowExecution(this.#db, input)
          : null;
      if (execution === null) {
        if (
          this.#db
            .prepare(
              "SELECT 1 FROM run_steps WHERE tenant_id=? AND run_id=? LIMIT 1",
            )
            .get(run.tenantId, run.runId) ||
          ["completed", "failed", "canceled"].includes(run.status)
        )
          corrupt();
        return {
          response: workflowReadProjection(
            run,
            context,
            null,
            new Map(),
            new Map(),
            new Map(),
          ),
          resources: [{ runId: run.runId, threadId: run.threadId }],
        };
      }
      if (
        compositionCount !== 3 ||
        !hasChildren ||
        run.goalBinding !== null ||
        run.goalAccounting !== null ||
        execution.workflowId !== run.workflowVersionBinding!.workflowId ||
        execution.workflowVersionId !==
          run.workflowVersionBinding!.workflowVersionId ||
        execution.contentDigest !== run.workflowVersionBinding!.contentDigest
      )
        corrupt();
      const rows = readSqliteWorkflowNodes(
        this.#db,
        execution,
        context.workflow,
      );
      for (const row of rows.values())
        sqliteWorkflowNodeAdmission(this.#db, execution, context.workflow, row);
      const childRows = readSqliteWorkflowChildren(
          this.#db,
          execution,
          run,
          this.#ops.loadRun,
        ),
        children = new Map<string, RunState>();
      for (const [claimId, row] of childRows)
        children.set(
          claimId,
          this.#ops.loadRun({
            tenantId: run.tenantId,
            runId: row.child_run_id,
          })!,
        );
      for (const node of execution.nodes)
        if (
          node.claimId !== null &&
          node.kind !== "humanGate" &&
          !children.has(node.claimId)
        )
          corrupt();
      const gates = readSqliteWorkflowHumanGates(
        this.#db,
        execution,
        run,
        context,
        {
          requirePublishedGates: execution.nodes.some(
            (node) => node.kind === "humanGate" && node.claimId !== null,
          ),
        },
      );
      const steps = this.#db
          .prepare(
            "SELECT step_id FROM run_steps WHERE tenant_id=? AND run_id=? LIMIT 65",
          )
          .all(run.tenantId, run.runId),
        ids = new Set([...rows.values()].map((row) => row.step_id));
      if (
        steps.length !== ids.size ||
        steps.some((step) => !ids.has(String(step.step_id)))
      )
        corrupt();
      return {
        response: workflowReadProjection(
          run,
          context,
          execution,
          rows,
          children,
          gates,
        ),
        resources: [
          { runId: run.runId, threadId: run.threadId },
          ...[...children.values()].map((child) => ({
            runId: child.runId,
            threadId: child.threadId,
          })),
        ],
      };
    });
    for (let pass = 0; pass < 2; pass++)
      for (const resource of captured.resources)
        await input.authorize(resource);
    this.#ops.assertOpen();
    return captured.response;
  }
  async listWorkflowRuns(input: ListInput) {
    this.#ops.assertOpen();
    const query = captureWorkflowRunListQuery(input.query);
    for (const value of [input.tenantId, input.spaceId])
      if (
        typeof value !== "string" ||
        !value.trim() ||
        Buffer.byteLength(value) > 512
      )
        throw new RunStoreError("workflow_read_request_invalid");
    await input.authorizeScope();
    this.#ops.assertOpen();
    const response = this.snapshot(() => {
      const present = this.tables([
        "workflow_run_admission_schema",
        "workflow_run_admissions",
        "workflow_run_inputs",
      ]);
      if (present.size === 0) return { data: [], nextCursor: null };
      if (present.size !== 3) corrupt();
      assertSqliteWorkflowRunAdmissionSchema(this.#db);
      const rows = this.#db
        .prepare(
          `WITH page AS MATERIALIZED (
        SELECT s.run_id,strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(s.state_json,'$.createdAt')) AS created_at
        FROM workflow_run_admissions a JOIN run_snapshots s ON s.tenant_id=a.tenant_id AND s.run_id=a.run_id
        LEFT JOIN run_thread_bindings b ON b.tenant_id=s.tenant_id AND b.run_id=s.run_id
        WHERE a.tenant_id=? AND s.space_id=? AND json_extract(s.state_json,'$.workflowVersionBinding.workflowVersionId')=?
        AND (? IS NULL OR b.thread_id=?)
        AND (? IS NULL OR (strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(s.state_json,'$.createdAt')),s.run_id COLLATE BINARY)<(strftime('%Y-%m-%dT%H:%M:%fZ',?),? COLLATE BINARY))
        ORDER BY created_at DESC,s.run_id COLLATE BINARY DESC LIMIT ?)
        SELECT ${sqlitePublicRunSummaryColumns()},b.thread_id FROM page p JOIN run_snapshots s ON s.tenant_id=? AND s.run_id=p.run_id
        LEFT JOIN run_thread_bindings b ON b.tenant_id=s.tenant_id AND b.run_id=s.run_id
        ORDER BY p.created_at DESC,s.run_id COLLATE BINARY DESC`,
        )
        .all(
          input.tenantId,
          input.spaceId,
          query.workflowVersionId,
          query.threadId,
          query.threadId,
          query.before?.createdAt ?? null,
          query.before?.createdAt ?? null,
          query.before?.runId ?? null,
          query.limit,
          input.tenantId,
        );
      const data = rows.map((row) => {
        if (
          row.identity_valid !== 1 ||
          !Number.isSafeInteger(row.stored_bytes) ||
          Number(row.stored_bytes) < 0 ||
          Number(row.stored_bytes) > 65536 ||
          typeof row.thread_id !== "string" ||
          typeof row.run_view !== "string"
        )
          corrupt();
        const run = parseRunView(
          JSON.parse(String(row.run_view)),
          String(row.thread_id),
        );
        if (
          run.runId !== row.run_id ||
          run.purpose !== "workflow" ||
          run.workflowVersionBinding?.workflowVersionId !==
            query.workflowVersionId
        )
          corrupt();
        return run;
      });
      const last = data.at(-1);
      return parseWorkflowRunListResponse(
        {
          data,
          nextCursor:
            last && data.length === query.limit
              ? formatWorkflowRunListCursor(query, {
                  createdAt: last.createdAt,
                  runId: last.runId,
                })
              : null,
        },
        query,
      );
    });
    for (let pass = 0; pass < 2; pass++)
      for (const run of response.data)
        await input.authorizeRun({ runId: run.runId, threadId: run.threadId });
    await input.authorizeScope();
    this.#ops.assertOpen();
    return response;
  }
  private root(input: ReadInput) {
    const bytes = this.#db
      .prepare(
        "SELECT length(CAST(state_json AS BLOB)) AS n FROM run_snapshots WHERE tenant_id=? AND space_id=? AND run_id=?",
      )
      .get(input.tenantId, input.spaceId, input.runId);
    if (!bytes) throw new RunStoreError("workflow_run_not_found");
    if (!Number.isSafeInteger(bytes.n) || Number(bytes.n) > 65536) corrupt();
    const run = this.#ops.loadRun(input);
    if (
      !run ||
      run.spaceId !== input.spaceId ||
      run.purpose !== "workflow" ||
      !run.workflowVersionBinding
    )
      throw new RunStoreError("workflow_run_not_found");
    return run;
  }
  private context(run: RunState) {
    assertSqliteWorkflowRunAdmissionSchema(this.#db);
    const rows = this.#db
      .prepare(
        `SELECT a.scope,a.idempotency_key,r.tenant_id,r.run_id,r.fingerprint,
      CASE WHEN length(CAST(r.result_json AS BLOB))<=${MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES} THEN r.result_json ELSE NULL END AS result_json,
      CASE WHEN length(CAST(a.authority_json AS BLOB))<=${MAX_WORKFLOW_ADMISSION_RECEIPT_BYTES} THEN a.authority_json ELSE NULL END AS authority_json
      FROM workflow_run_admissions a JOIN idempotency_receipts r ON r.scope=a.scope AND r.idempotency_key=a.idempotency_key
      WHERE a.tenant_id=? AND a.run_id=? LIMIT 2`,
      )
      .all(
        run.tenantId,
        run.runId,
      ) as unknown as (WorkflowAdmissionReceiptRow & {
      scope: string;
      idempotency_key: string;
    })[];
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row?.result_json ||
      !row.authority_json ||
      !row.fingerprint ||
      row.run_id !== run.runId
    )
      corrupt();
    const original = JSON.parse(row.result_json),
      work = original?.workItems;
    if (
      !Array.isArray(work) ||
      work.length !== 1 ||
      typeof work[0]?.workItemId !== "string" ||
      !work[0].workItemId.trim() ||
      Buffer.byteLength(work[0].workItemId) > 512
    )
      corrupt();
    const context = readSqliteWorkflowCompositionContext(this.#db, {
      run,
      binding: run.workflowVersionBinding!,
      lease: { workItemId: work[0].workItemId },
    });
    const command = {
      tenantId: run.tenantId,
      spaceId: run.spaceId,
      threadId: run.threadId,
      workflowVersionId: run.workflowVersionBinding!.workflowVersionId,
      workflowInput: context.rootInput.value,
      idempotency: {
        scope: row.scope,
        key: row.idempotency_key,
        requestFingerprint: row.fingerprint,
      },
      prepare: (): never => {
        throw new RunStoreError("workflow_read_must_not_prepare");
      },
    };
    const decoded = decodeWorkflowAdmissionReceipt(command, row);
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
  private tables(names: string[]) {
    return new Set(
      this.#db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${names.map(() => "?").join(",")})`,
        )
        .all(...names)
        .map((row) => String(row.name)),
    );
  }
  private snapshot<T>(read: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const result = read();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      if (error instanceof ApplicationError) throw error;
      throw normalizeSqliteError(error);
    }
  }
}
function corrupt(): never {
  throw new RunStoreError("workflow_read_authority_corrupt");
}
