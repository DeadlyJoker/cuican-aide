import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  type WorkflowAgentAttemptAuthority,
  type CommitWorkflowToolContinuationInput,
  type WorkflowNodeContinuationCheckpoint,
  type CommitWorkflowAssistantContinuationInput,
  type WorkflowNodeContinuationStore,
  type WorkflowCancellationResult,
  type WorkflowExecutionValue,
  type WorkflowRunCompositionStore,
  type WorkflowHumanGatePublicationStore,
  type WorkflowToolApprovalStore,
} from "@crewon/application";
import {
  composeWorkflowNodeInput,
  composeWorkflowOutput,
  reduceRunLifecycleEvent,
  replayRunLifecycle,
  validateWorkflowSchemaValue,
  validateWorkflowDispatchTerminalCorrelation,
  validateWorkflowNodeTerminalEvidence,
  workflowNodeInputSchema,
  MAX_WORKFLOW_VALUE_BYTES,
  type RunState,
  type WorkflowContentDigester,
  type WorkflowSchemaValue,
} from "@crewon/domain";

import {
  readLeaseClock,
  SystemLeaseClock,
  type LeaseClock,
} from "./lease-clock.ts";
import {
  beginSqliteRunAttempt,
  finishSqliteRunAttempt,
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import { configureAndMigrateSqlite, rollback } from "./sqlite-schema.ts";
import { stableJson } from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import {
  decodeWorkflowExecutionState,
  validateWorkflowExecutionState,
} from "./workflow-execution-state.ts";
import { migrateSqliteWorkflowExecutions } from "./workflow-execution-schema.ts";
import { migrateSqliteWorkflowVersions } from "./workflow-version-schema.ts";
import {
  loadSqliteModelDispatchReceipt,
  migrateSqliteModelDispatchEvidence,
  terminateSqliteModelDispatch,
  terminateSqliteModelDispatchForAttempt,
} from "./sqlite-model-dispatch-evidence.ts";
import {
  assertExecutionBinding,
  attemptId,
  gateStep,
  hasReadyWorkflowNodes,
  initialExecution,
  parseBoundWorkflow,
  reconciliationClaims,
  scheduleReadyNodes,
  settleWorkflowClaim,
  workflowAuthorityId,
} from "./workflow-run-composition-support.ts";
import { SqliteWorkflowNodeContinuationAuthority } from "./sqlite-workflow-node-continuation.ts";
import { takeOverSqliteWorkflowContinuation } from "./sqlite-workflow-continuation-takeover.ts";
import { takeOverSqliteWorkflowPendingTools } from "./sqlite-workflow-pending-tool-takeover.ts";
import { commitSqliteRetrievedWorkflowContinuationWithinTransaction } from "./sqlite-workflow-retrieved-continuation.ts";
import { SqliteWorkflowToolApprovalAuthority } from "./sqlite-workflow-tool-approval.ts";
import { settleSqliteWorkflowNodeWithinTransaction } from "./sqlite-workflow-node-settlement.ts";
import { settleSqliteWorkflowNodeModelTerminalWithinTransaction } from "./sqlite-workflow-model-settlement.ts";
import type { SqliteWorkflowNodeSettlementContext } from "./sqlite-workflow-node-settlement.ts";
import {
  ensureSqliteCancellationReconciliation,
  sqliteCancellationReconciliationWorkItemIds,
} from "./sqlite-workflow-cancellation.ts";
import {
  prepareWorkflowGatePublication,
  projectWorkflowGatePublication,
} from "./workflow-gate-publication.ts";

type Dependencies = Readonly<{
  digester: WorkflowContentDigester;
  clock?: LeaseClock;
}>;

const WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED =
  "workflow_model_dispatch_operator_required";

/** SQLite production composition authority. Every admission is one IMMEDIATE transaction. */
export class SqliteWorkflowRunCompositionStore
  implements
    WorkflowRunCompositionStore,
    WorkflowHumanGatePublicationStore,
    WorkflowToolApprovalStore
{
  async publishWorkflowHumanGate(
    input: Parameters<WorkflowHumanGatePublicationStore["publishWorkflowHumanGate"]>[0],
  ): ReturnType<WorkflowHumanGatePublicationStore["publishWorkflowHumanGate"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const outbox = this.#database.prepare(`SELECT message_json,status,
        lease_owner_id,lease_id,lease_epoch,lease_expires_at_ms FROM outbox
        WHERE message_id=?`).get(input.lease.messageId) as {
          message_json: string; status: string; lease_owner_id: string | null;
          lease_id: string | null; lease_epoch: number;
          lease_expires_at_ms: number | null;
        } | undefined;
      if (outbox === undefined || outbox.status !== "leased" ||
          outbox.lease_owner_id !== input.lease.ownerId ||
          outbox.lease_id !== input.lease.leaseId ||
          outbox.lease_epoch !== input.lease.leaseEpoch ||
          outbox.lease_expires_at_ms === null || outbox.lease_expires_at_ms <= nowMs ||
          stableJson(JSON.parse(outbox.message_json)) !== stableJson(input.message))
        throw new RunStoreError("workflow_gate_publication_lease_invalid");
      const row = this.#database.prepare(`SELECT state_json FROM workflow_gate_requests
        WHERE publication_outbox_message_id=?`).get(input.lease.messageId) as
          { state_json: string } | undefined;
      if (row === undefined) throw new RunStoreError("workflow_gate_publication_not_found");
      const prepared = prepareWorkflowGatePublication(
        input.message, JSON.parse(row.state_json), now,
      );
      const gate = this.#database.prepare(`UPDATE workflow_gate_requests
        SET status='published',state_json=?,updated_at=?
        WHERE publication_outbox_message_id=? AND status='publicationPending'`).run(
          stableJson(prepared.nextState), now, input.lease.messageId);
      const outboxUpdate = this.#database.prepare(`UPDATE outbox SET status='delivered',
        lease_owner_id=NULL,lease_id=NULL,lease_expires_at_ms=NULL,delivered_at_ms=?
        WHERE message_id=? AND status='leased' AND lease_owner_id=? AND lease_id=?
        AND lease_epoch=? AND lease_expires_at_ms>?`).run(
          nowMs, input.lease.messageId, input.lease.ownerId, input.lease.leaseId,
          input.lease.leaseEpoch, nowMs);
      if (gate.changes !== 1 || outboxUpdate.changes !== 1)
        throw new RunStoreError("workflow_gate_publication_conflict");
      this.#database.exec("COMMIT");
      return prepared.publication;
    } catch (error) {
      rollback(this.#database);
      if (error instanceof RunStoreError) throw normalizeCompositionError(error);
      throw normalizeCompositionError(new RunStoreError(
        "workflow_gate_publication_store_failed",
        { cause: error instanceof Error ? error : undefined },
      ));
    }
  }

  async listPublishedWorkflowHumanGates(input: { tenantId: string; runId: string }) {
    try {
      const rows = this.#database.prepare(`SELECT state_json FROM workflow_gate_requests
        WHERE tenant_id=? AND run_id=? AND status='published'
        ORDER BY created_at,node_id LIMIT 256`).all(input.tenantId, input.runId) as
          { state_json: string }[];
      return rows.map((row) => projectWorkflowGatePublication(JSON.parse(row.state_json)));
    } catch (error) {
      if (error instanceof RunStoreError) throw normalizeCompositionError(error);
      throw normalizeCompositionError(new RunStoreError(
        "workflow_gate_publication_store_failed",
        { cause: error instanceof Error ? error : undefined },
      ));
    }
  }

  async loadWorkflowExecution(input: { tenantId: string; runId: string }) {
    return this.#loadExecution(input.tenantId, input.runId);
  }

  readonly #database: DatabaseSync;
  readonly #digester: WorkflowContentDigester;
  readonly #clock: LeaseClock;
  readonly #ownsDatabase: boolean;
  readonly #continuations: SqliteWorkflowNodeContinuationAuthority;
  readonly #toolApprovals: SqliteWorkflowToolApprovalAuthority;

  constructor(database: DatabaseSync, dependencies: Dependencies);
  constructor(path: string, dependencies: Dependencies);
  constructor(
    databaseOrPath: DatabaseSync | string,
    dependencies: Dependencies,
  ) {
    this.#database =
      typeof databaseOrPath === "string"
        ? new DatabaseSync(databaseOrPath, {
            enableForeignKeyConstraints: true,
          })
        : databaseOrPath;
    this.#ownsDatabase = typeof databaseOrPath === "string";
    this.#digester = dependencies.digester;
    this.#clock = dependencies.clock ?? new SystemLeaseClock();
    this.#continuations = new SqliteWorkflowNodeContinuationAuthority(
      this.#database,
      this.#clock,
      this.#digester,
    );
    this.#toolApprovals = new SqliteWorkflowToolApprovalAuthority(
      this.#database, this.#clock, this.#digester,
    );
    configureAndMigrateSqlite(this.#database);
    migrateSqliteWorkflowVersions(this.#database);
    migrateSqliteWorkflowExecutions(this.#database);
    migrateSqliteModelDispatchEvidence(this.#database);
  }

  async close(): Promise<void> {
    if (this.#ownsDatabase) this.#database.close();
  }

  async publishWorkflowToolApproval(
    input: Parameters<WorkflowToolApprovalStore["publishWorkflowToolApproval"]>[0],
  ): ReturnType<WorkflowToolApprovalStore["publishWorkflowToolApproval"]> {
    return this.#toolApprovals.publish(input);
  }

  async consumeWorkflowToolApproval(
    input: Parameters<WorkflowToolApprovalStore["consumeWorkflowToolApproval"]>[0],
  ): ReturnType<WorkflowToolApprovalStore["consumeWorkflowToolApproval"]> {
    return this.#toolApprovals.consume(input);
  }

  async loadWorkflowNodeContinuation(
    authority: WorkflowAgentAttemptAuthority,
  ): Promise<WorkflowNodeContinuationCheckpoint | null> {
    return this.#continuations.load(authority);
  }

  async commitWorkflowAssistantContinuation(
    input: CommitWorkflowAssistantContinuationInput,
  ): Promise<WorkflowNodeContinuationCheckpoint> {
    return this.#continuations.commitAssistant(input);
  }

  async commitWorkflowToolContinuation(
    input: CommitWorkflowToolContinuationInput,
  ): ReturnType<
    import("@crewon/application").WorkflowNodeContinuationStore["commitWorkflowToolContinuation"]
  > {
    return this.#continuations.commitTool(input);
  }

  async settleWorkflowNodeModelTerminal(
    input: Parameters<WorkflowNodeContinuationStore["settleWorkflowNodeModelTerminal"]>[0],
  ): ReturnType<WorkflowNodeContinuationStore["settleWorkflowNodeModelTerminal"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("settleNode", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const result = settleSqliteWorkflowNodeModelTerminalWithinTransaction(
        this.#nodeSettlementContext(), input, fingerprint, now, nowMs,
      );
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      if (!(error instanceof RunStoreError)) throw error;
      throw normalizeCompositionError(error);
    }
  }

  async settlePreparedWorkflowNodeTerminal(input: Parameters<
    WorkflowNodeContinuationStore["settlePreparedWorkflowNodeTerminal"]>[0]) {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("settleNode", input);
    const receiptInput = { tenantId: input.authority.tenantId,
      runId: input.authority.runId, operationId: input.operationId };
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(receiptInput, "settleNode", fingerprint) as
        { candidateId?: unknown; evidence?: unknown } | null;
      if (replay !== null) {
        const dispatchRows = this.#database.prepare(`SELECT operation_id FROM model_dispatch_receipts
          WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?
          ORDER BY request_sequence DESC, revision DESC LIMIT 2`).all(
            input.authority.tenantId, input.authority.runId,
            input.authority.attempt.stepId, input.authority.attempt.attemptId) as
          { operation_id: string }[];
        const dispatch = dispatchRows.length === 1
          ? loadSqliteModelDispatchReceipt(this.#database, {
              tenantId: input.authority.tenantId, runId: input.authority.runId,
              ...input.authority.attempt, operationId: dispatchRows[0]!.operation_id })
          : null;
        if (dispatch?.status !== "terminal" || dispatch.terminalOutcome === null ||
            replay.evidence === undefined || replay.candidateId !== input.candidateId)
          throw new RunStoreError("workflow_terminal_candidate_corrupt");
        const result = settleSqliteWorkflowNodeModelTerminalWithinTransaction(
          this.#nodeSettlementContext(), { binding: input.binding,
            nodeId: input.authority.nodeId, operationId: input.operationId,
            evidence: replay.evidence as Parameters<
              WorkflowNodeContinuationStore["settleWorkflowNodeModelTerminal"]>[0]["evidence"],
            lease: input.lease,
            authority: input.authority, dispatch: {
              operationId: dispatch.operationId,
              requestSequence: dispatch.requestSequence,
              expectedRevision: dispatch.revision - 1,
              status: "responseObserved" },
            dispatchTerminalOutcome: dispatch.terminalOutcome },
          fingerprint, now, nowMs, "liveNode", input.candidateId);
        this.#database.exec("COMMIT");
        return result;
      }
      const checkpoint = await this.#continuations.load(input.authority);
      const candidate = checkpoint?.terminalCandidate;
      if (candidate === null || candidate === undefined ||
          candidate.candidateId !== input.candidateId)
        throw new RunStoreError("workflow_terminal_candidate_corrupt");
      const terminalInput = { binding: input.binding,
        nodeId: input.authority.nodeId, operationId: input.operationId,
        evidence: candidate.evidence, lease: input.lease,
        authority: input.authority, dispatch: checkpoint!.activeDispatch!,
        dispatchTerminalOutcome: candidate.dispatchTerminalOutcome };
      const result = settleSqliteWorkflowNodeModelTerminalWithinTransaction(
        this.#nodeSettlementContext(), terminalInput,
        fingerprint, now, nowMs, "liveNode", input.candidateId);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async settleWorkflowNode(
    input: Parameters<WorkflowRunCompositionStore["settleWorkflowNode"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowNode"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("settleNode", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const result = settleSqliteWorkflowNodeWithinTransaction(
        this.#nodeSettlementContext(), input, fingerprint, now, nowMs,
      );
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async settleWorkflowHumanGate(
    input: Parameters<
      WorkflowRunCompositionStore["settleWorkflowHumanGate"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowHumanGate"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("settleGate", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(input, "settleGate", fingerprint);
      if (replay !== null) {
        this.#validateTerminalReplay(input, replay);
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
        } as Awaited<
          ReturnType<WorkflowRunCompositionStore["settleWorkflowHumanGate"]>
        >);
      }
      this.#validateLease(input, nowMs);
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      const gate = this.#loadGate(input);
      if (
        gate.decisionReceiptId !== input.decisionReceiptId ||
        !["completed", "failed"].includes(String(gate.status)) ||
        gate.tenantId !== input.tenantId || gate.runId !== input.runId ||
        gate.nodeId !== input.nodeId ||
        stableJson(gate.binding) !== stableJson(input.binding) ||
        gate.gateRequestId !== input.gateRequestId ||
        gate.claimId !== input.claimId || gate.claimEpoch !== input.claimEpoch
      )
        throw new RunStoreError("workflow_gate_decision_mismatch");
      assertGateDecisionOutcome(gate.outcome as Parameters<
        WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
      >[0]["outcome"]);
      this.#assertGateResumePayload(input, gate);
      const execution = this.#loadExecution(input.tenantId, input.runId);
      const step = loadSqliteRunStep(this.#database, {
        ...input,
        stepId: input.nodeId,
      });
      if (
        execution === null ||
        step === null ||
        step.kind !== "gate" ||
        step.status !== "waitingApproval"
      )
        throw new RunStoreError("workflow_composition_gate_mismatch");
      const outcome = gate.outcome as
        | { status: "completed" }
        | { status: "failed"; failureCode: string };
      const terminalStep = {
        ...step,
        status: outcome.status,
        revision: step.revision + 1,
        updatedAt: now,
        terminalAt: now,
      };
      const stepUpdate = this.#database
        .prepare(
          `UPDATE run_steps SET status=?,revision=?,state_json=?,updated_at=?,terminal_at=?
         WHERE tenant_id=? AND run_id=? AND step_id=? AND revision=?`,
        )
        .run(
          terminalStep.status,
          terminalStep.revision,
          stableJson(terminalStep),
          now,
          now,
          input.tenantId,
          input.runId,
          input.nodeId,
          step.revision,
        );
      if (stepUpdate.changes !== 1)
        throw new RunStoreError("workflow_composition_gate_mismatch");
      const node = execution.nodes.find((candidate) => candidate.nodeId === input.nodeId);
      if (
        node === undefined || node.kind !== "humanGate" ||
        node.status !== "waitingHuman" || node.claimId !== input.claimId ||
        node.claimEpoch !== input.claimEpoch ||
        node.gateRequestId !== input.gateRequestId ||
        node.inputDigest !== gate.inputDigest
      ) throw new RunStoreError("workflow_composition_gate_mismatch");
      const workflow = this.#loadWorkflow(input);
      let gateValue: WorkflowSchemaValue | undefined;
      if (outcome.status === "completed") {
        const inputAuthority = this.#composeNodeInputValue({
          ...input, schedulerOperationId: node.claimOperationId!,
          admissionOperationId: input.operationId, attemptLeaseDurationMs: 1,
        }, workflow, now);
        gateValue = inputAuthority.value as WorkflowSchemaValue;
        this.#insertExecutionValue({ ...input,
          valueId: workflowAuthorityId("value", { tenantId: input.tenantId,
            runId: input.runId, nodeId: input.nodeId, claimId: input.claimId,
            claimEpoch: input.claimEpoch, resultDigest: inputAuthority.valueDigest }, this.#digester),
          role: "nodeOutput", nodeId: input.nodeId,
          valueDigest: inputAuthority.valueDigest,
          valueJson: canonicalJson(gateValue), now });
      }
      const next = settleWorkflowClaim({ execution, ...input,
        outcome: outcome.status === "completed"
          ? { status: "completed", value: gateValue! }
          : outcome,
        resultDigest: outcome.status === "completed" ? node.inputDigest! : undefined, now });
      for (const blocked of next.nodes) {
        if (
          blocked.status === "canceled" &&
          execution.nodes.find((candidate) => candidate.nodeId === blocked.nodeId)
            ?.status === "pending"
        ) {
          this.#cancelPendingNode(input, blocked, now, nowMs);
        }
      }
      this.#writeExecution(next, now);
      const runDisposition = this.#convergeTerminalRun(
        input, workflow, next, now, nowMs);
      let schedulerContinuationWorkItemId: string | null = null;
      if (
        next.status === "running" &&
        hasReadyWorkflowNodes(next, workflow)
      ) {
        schedulerContinuationWorkItemId = workflowAuthorityId(
          "scheduler",
          {
            tenantId: input.tenantId,
            runId: input.runId,
            binding: input.binding,
            gateRequestId: input.gateRequestId,
            decisionReceiptId: input.decisionReceiptId,
          },
          this.#digester,
        );
        this.#insertWorkflowWorkItem(
          schedulerContinuationWorkItemId,
          input,
          {
            schemaVersion: "crewon.workflow-scheduler-work-item.v1",
            trigger: "workflowScheduler",
            binding: input.binding,
            schedulerOperationId: schedulerContinuationWorkItemId,
            workflowInput: this.#rootInputRef(input),
          },
          now,
          nowMs,
        );
      }
      const result = {
        disposition: "settled" as const,
        execution: next,
        schedulerContinuationWorkItemId,
        handoff: {
          currentWorkItem: "completed" as const,
          nextWorkItemId: schedulerContinuationWorkItemId,
          kind: schedulerContinuationWorkItemId === null ? "none" as const : "scheduler" as const,
        },
        runDisposition,
      };
      this.#insertReceipt(input, "settleGate", fingerprint, result);
      this.#completeLease(input, nowMs);
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async scheduleWorkflowReconciliation(
    input: Parameters<
      WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]
    >[0],
  ): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("scheduleReconciliation", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(
        input,
        "scheduleReconciliation",
        fingerprint,
      );
      if (replay !== null) {
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
        } as Awaited<
          ReturnType<
            WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]
          >
        >);
      }
      this.#validateLease(input, nowMs);
      const currentPayload = this.#loadWorkItemPayload(input.lease.workItemId);
      if ((currentPayload as { trigger?: unknown }).trigger === "workflowReconcile")
        throw new RunStoreError("workflow_reconciliation_handoff_loop");
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      const reconciliationWorkItemId = workflowAuthorityId(
        "reconcile",
        {
          tenantId: input.tenantId,
          runId: input.runId,
          binding: input.binding,
          operationId: input.operationId,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
        },
        this.#digester,
      );
      this.#insertWorkflowWorkItem(
        reconciliationWorkItemId,
        input,
        {
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile",
          binding: input.binding,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
          reconciliationOperationId: input.operationId,
        },
        now,
        nowMs,
      );
      const result = {
        disposition: "scheduled" as const,
        reconciliationWorkItemId,
        handoff: { currentWorkItem: "completed" as const, nextWorkItemId: reconciliationWorkItemId, kind: "reconcile" as const },
      };
      this.#insertReceipt(input, "scheduleReconciliation", fingerprint, result);
      this.#completeLease(input, nowMs);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async cancelWorkflowExecution(
    input: Parameters<WorkflowRunCompositionStore["cancelWorkflowExecution"]>[0],
  ): Promise<WorkflowCancellationResult> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("cancelExecution", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(input, "cancelExecution", fingerprint);
      if (replay !== null) {
        this.#validateCancellationReplay(input, replay);
        this.#database.exec("COMMIT");
        return structuredClone({ ...(replay as object), disposition: "replay" } as
          WorkflowCancellationResult);
      }
      this.#validateLease(input, nowMs);
      const run = this.#loadRun(input.tenantId, input.runId);
      assertCanonicalRun(run, input.binding);
      if (!run!.cancelRequested)
        throw new RunStoreError("workflow_cancellation_not_requested");
      let execution = this.#loadExecution(input.tenantId, input.runId);
      if (execution === null) throw new RunStoreError("workflow_execution_not_found");
      const currentPayload = this.#loadWorkItemPayload(input.lease.workItemId) as {
        trigger?: unknown; binding?: unknown; nodeId?: unknown;
        claimId?: unknown; claimEpoch?: unknown };
      if (stableJson(currentPayload.binding) !== stableJson(input.binding))
        throw new RunStoreError("workflow_composition_work_item_mismatch");
      if (currentPayload.trigger === "workflowNode") {
        const result = this.#cancelOwnedWorkflowNode(
          input, execution, currentPayload, fingerprint, now, nowMs);
        this.#database.exec("COMMIT");
        return structuredClone(result);
      }
      if (currentPayload.trigger !== "workflowCancel")
        throw new RunStoreError("workflow_composition_work_item_mismatch");
      let requiresReconciliation = false;
      const canceledNodeIds: string[] = [];
      const canceledGateRequestNodeIds: string[] = [];
      const cancellationContext = {
        database: this.#database, digester: this.#digester,
        loadWorkflow: (value: Parameters<
          WorkflowRunCompositionStore["cancelWorkflowExecution"]>[0]) =>
            this.#loadWorkflow(value),
        insertWorkItem: (id: string, value: Parameters<
          WorkflowRunCompositionStore["cancelWorkflowExecution"]>[0],
        payload: Record<string, unknown>, timestamp: string, clock: number) =>
          this.#insertWorkflowWorkItem(id, value, payload, timestamp, clock),
      };
      const nodes = execution.nodes.map((node) => {
        if (node.status === "pending") {
          this.#cancelUnadmittedStep(input, node.nodeId, node.kind, now);
          this.#appendNodeTerminalEvent({ ...input, nodeId: node.nodeId,
            claimId: null, claimEpoch: null, stepId: node.nodeId, attemptId: null,
            operationId: `${input.operationId}:${node.nodeId}`,
            outcome: { status: "canceled" } }, null, now, nowMs);
          canceledNodeIds.push(node.nodeId);
          return { ...node, status: "canceled" as const };
        }
        if (node.status === "queued") {
          const works = this.#database.prepare(
            `SELECT work_item_id,status,work_item_json FROM work_items
             WHERE tenant_id=? AND run_id=?
             AND json_extract(work_item_json,'$.payload.trigger')='workflowNode'
             AND json_extract(work_item_json,'$.payload.nodeId')=? LIMIT 2`,
          ).all(input.tenantId, input.runId, node.nodeId) as
            { work_item_id: string; status: string; work_item_json: string }[];
          if (works.length !== 1) { requiresReconciliation = true; return node; }
          const work = works[0]!;
          const payload = (JSON.parse(work.work_item_json) as { payload: unknown }).payload;
          if (stableJson(payload) !== stableJson({
            schemaVersion: "crewon.workflow-node-work-item.v0", trigger: "workflowNode",
            binding: input.binding, nodeId: node.nodeId, claimId: node.claimId,
            claimEpoch: node.claimEpoch, schedulerOperationId: node.claimOperationId,
          })) throw new RunStoreError("workflow_composition_work_item_mismatch");
          const current = work?.work_item_id === input.lease.workItemId;
          if (work === undefined) throw new RunStoreError(
            "workflow_cancellation_reconciliation_required");
          if (work.status === "leased" && !current) return node;
          if (work.status !== "pending" && !(current && work.status === "leased"))
            throw new RunStoreError("workflow_cancellation_reconciliation_required");
          if (work.status === "pending") this.#database.prepare(
            `UPDATE work_items SET status='completed',completed_at_ms=?
             WHERE work_item_id=? AND status='pending'`,
          ).run(nowMs, work.work_item_id);
          this.#cancelUnadmittedStep(input, node.nodeId, node.kind, now);
          this.#appendNodeTerminalEvent({ ...input, nodeId: node.nodeId,
            claimId: node.claimId, claimEpoch: node.claimEpoch,
            stepId: node.nodeId, attemptId: null,
            operationId: `${input.operationId}:${node.nodeId}`,
            outcome: { status: "canceled" } }, null, now, nowMs);
          canceledNodeIds.push(node.nodeId);
          return { ...node, status: "canceled" as const };
        }
        if (node.status === "running") return node;
        if (node.status === "unknown") {
          ensureSqliteCancellationReconciliation(
            cancellationContext, input, node, now, nowMs);
        }
        if (node.status === "waitingHuman") {
          const changed = this.#database.prepare(
            `UPDATE workflow_gate_requests SET status='canceled',
             state_json=json_set(state_json,'$.status','canceled','$.updatedAt',?),updated_at=?
             WHERE tenant_id=? AND run_id=? AND node_id=?
             AND status IN ('publicationPending','published')`,
          ).run(now, now, input.tenantId, input.runId, node.nodeId);
          if (changed.changes === 1) {
            this.#database.prepare(`UPDATE outbox SET status='delivered',
              lease_owner_id=NULL,lease_id=NULL,lease_expires_at_ms=NULL,delivered_at_ms=?
              WHERE message_id=(SELECT publication_outbox_message_id FROM workflow_gate_requests
                WHERE tenant_id=? AND run_id=? AND node_id=?)
              AND status IN ('pending','leased')`).run(
                nowMs, input.tenantId, input.runId, node.nodeId);
            const step = loadSqliteRunStep(this.#database, {
              tenantId: input.tenantId, runId: input.runId, stepId: node.nodeId,
            });
            if (step === null || step.kind !== "gate" || step.status !== "waitingApproval")
              throw new RunStoreError("workflow_composition_gate_mismatch");
            const terminal = { ...step, status: "canceled" as const,
              revision: step.revision + 1, updatedAt: now, terminalAt: now };
            const updated = this.#database.prepare(
              `UPDATE run_steps SET status='canceled',revision=?,state_json=?,updated_at=?,terminal_at=?
               WHERE tenant_id=? AND run_id=? AND step_id=? AND revision=?`,
            ).run(terminal.revision, stableJson(terminal), now, now,
              input.tenantId, input.runId, node.nodeId, step.revision);
            if (updated.changes !== 1) throw new RunStoreError("revision_conflict");
            this.#appendNodeTerminalEvent({ ...input, nodeId: node.nodeId,
              claimId: node.claimId, claimEpoch: node.claimEpoch,
              stepId: node.nodeId, attemptId: null,
              operationId: `${input.operationId}:${node.nodeId}`,
              outcome: { status: "canceled" } }, null, now, nowMs);
            canceledNodeIds.push(node.nodeId);
            canceledGateRequestNodeIds.push(node.nodeId);
            return { ...node, status: "canceled" as const };
          }
          requiresReconciliation = true;
        }
        return node;
      });
      const active = nodes.some((node) =>
        ["queued", "running", "unknown", "waitingHuman"].includes(node.status));
      if (requiresReconciliation)
        throw new RunStoreError("workflow_cancellation_reconciliation_required");
      const next = { ...execution, revision: execution.revision + 1,
        cancelRequested: true, nodes,
        status: active ? "running" as const : "canceled" as const, updatedAt: now };
      this.#writeExecution(next, now);
      canceledNodeIds.sort();
      canceledGateRequestNodeIds.sort();
      const reconciliationWorkItemIds = sqliteCancellationReconciliationWorkItemIds(
        cancellationContext, input, next);
      if (active) {
        this.#database.exec("COMMIT");
        return structuredClone({ disposition: "retryRequired" as const,
          canceledNodeIds, canceledGateRequestNodeIds, reconciliationWorkItemIds,
          execution: next,
          handoff: { currentWorkItem: "retained" as const, nextWorkItemId: null,
            kind: "none" as const }, runDisposition: "nonTerminal" as const });
      }
      const runDisposition = this.#convergeTerminalRun(
        input, this.#loadWorkflow(input), next, now, nowMs);
      this.#completePendingCancellationWake(input, nowMs);
      const result = { disposition: reconciliationWorkItemIds.length === 0
          ? "canceled" as const : "reconciliationScheduled" as const,
        canceledNodeIds, canceledGateRequestNodeIds, reconciliationWorkItemIds,
        execution: next, handoff: { currentWorkItem: "completed" as const,
          nextWorkItemId: reconciliationWorkItemIds[0] ?? null,
          kind: reconciliationWorkItemIds.length === 0 ? "none" as const : "reconcile" as const },
        runDisposition };
      this.#insertReceipt(input, "cancelExecution", fingerprint, result);
      this.#completeLease(input, nowMs);
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async reconcileWorkflowNode(
    input: Parameters<WorkflowRunCompositionStore["reconcileWorkflowNode"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["reconcileWorkflowNode"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("reconcileNode", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const receiptInput = { ...input,
        operationId: `reconcile:${input.reconciliationOperationId}` };
      const replay = this.#receipt(
        receiptInput, "reconcileNode", fingerprint);
      if (replay !== null) {
        const envelope = replay as Record<string, unknown>;
        if (envelope.cancellationWinner === true)
          await this.#validateCanceledReconciliationReplay(input, replay);
        if (envelope.disposition === "operatorRequired")
          this.#validateOperatorRequiredReconciliationReplay(input, replay);
        const { cancellationWinner: _marker, ...publicReplay } = envelope;
        this.#database.exec("COMMIT");
        return structuredClone({ ...publicReplay, disposition: "replay" } as
          Awaited<ReturnType<WorkflowRunCompositionStore["reconcileWorkflowNode"]>>);
      }
      this.#validateLease(input, nowMs);
      const run = this.#loadRun(input.tenantId, input.runId);
      assertCanonicalRun(run, input.binding);
      const expectedPayload = {
        schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile", binding: input.binding,
        nodeId: input.nodeId, claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        reconciliationOperationId: input.reconciliationOperationId,
      };
      if (stableJson(this.#loadWorkItemPayload(input.lease.workItemId)) !==
          stableJson(expectedPayload))
        throw new RunStoreError("workflow_composition_work_item_mismatch");
      const execution = this.#loadExecution(input.tenantId, input.runId);
      const node = executionNode(input, execution);
      if ((node.status !== "unknown" && node.status !== "running") ||
          node.claimId !== input.claimId ||
          node.claimEpoch !== input.claimEpoch)
        throw new RunStoreError("workflow_composition_claim_mismatch");
      const step = loadSqliteRunStep(this.#database, {
        tenantId: input.tenantId, runId: input.runId, stepId: input.nodeId,
      });
      const attempt = step?.currentAttemptId === null || step === null ? null
        : loadSqliteRunAttempt(this.#database, { tenantId: input.tenantId,
            runId: input.runId, stepId: input.nodeId,
            attemptId: step.currentAttemptId });
      if (step === null || attempt === null || attempt.status !== "running")
        throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
      const authority = { tenantId: input.tenantId, runId: input.runId,
        workItemId: attempt.workItemId, leaseEpoch: attempt.leaseEpoch,
        nodeId: input.nodeId,
        nodeKind: node.kind === "verification" ? "verification" as const : "agent" as const,
        claimId: input.claimId, claimEpoch: input.claimEpoch,
        agentVersionId: node.agentVersionId!, attempt: {
          stepId: input.nodeId, attemptId: attempt.attemptId } };
      const checkpoint = await this.#continuations.loadForReconciliation(authority);
      const dispatchAuthority = this.#database.prepare(
        `SELECT operation_id FROM model_dispatch_receipts
         WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?
         AND status!='terminal'
         ORDER BY request_sequence DESC, revision DESC LIMIT 2`,
      ).all(input.tenantId, input.runId, input.nodeId, attempt.attemptId) as
        { operation_id: string }[];
      if (dispatchAuthority.length > 1)
        throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
      const dispatch = dispatchAuthority[0] === undefined ? null
        : loadSqliteModelDispatchReceipt(this.#database, {
            tenantId: input.tenantId, runId: input.runId, stepId: input.nodeId,
            attemptId: attempt.attemptId,
            operationId: dispatchAuthority[0].operation_id,
          });
      const latestDispatchAuthority = this.#database.prepare(
        `SELECT operation_id FROM model_dispatch_receipts
         WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?
         ORDER BY request_sequence DESC, revision DESC LIMIT 1`,
      ).get(input.tenantId, input.runId, input.nodeId, attempt.attemptId) as
        { operation_id: string } | undefined;
      const latestDispatch = latestDispatchAuthority === undefined ? null
        : loadSqliteModelDispatchReceipt(this.#database, {
            tenantId: input.tenantId, runId: input.runId, stepId: input.nodeId,
            attemptId: attempt.attemptId,
            operationId: latestDispatchAuthority.operation_id,
          });
      if (dispatch !== null && (dispatch.workItemId !== attempt.workItemId ||
          dispatch.leaseEpoch !== attempt.leaseEpoch))
        throw new RunStoreError("workflow_reconciliation_evidence_missing");
      const evidenceStatus = dispatch === null || dispatch.status === "prepared"
        ? "notDispatched" as const : dispatch.status;
      if (checkpoint !== null && checkpoint.terminalCandidate === null &&
          checkpoint.activeDispatch === null &&
          dispatch === null && attempt.workItemId === input.lease.workItemId &&
          latestDispatch?.status !== "terminal")
        throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
      const durableResume = checkpoint !== null &&
        checkpoint.terminalCandidate === null &&
        ((dispatch?.status === "responseObserved" &&
            checkpoint.activeDispatch !== null) ||
          (dispatch?.status === "prepared" &&
            checkpoint.activeDispatch === null &&
            attempt.workItemId === input.lease.workItemId) ||
          (dispatch === null && latestDispatch?.status === "terminal" &&
            checkpoint.activeDispatch === null &&
            attempt.workItemId === input.lease.workItemId));
      if (durableResume) {
        const workflow = this.#loadWorkflow(input);
        const definition = workflow.nodes.find(
          (candidate) => candidate.nodeId === input.nodeId);
        const inputValue = this.#loadExecutionValue(
          input.tenantId, input.runId, "nodeInput", input.nodeId);
        const providerCheckpoint = attempt.providerCheckpoint;
        const checkpointDigest = attempt.checkpointDigest;
        const leaseRow = this.#database.prepare(
          `SELECT lease_expires_at_ms FROM work_items WHERE work_item_id=?`,
        ).get(input.lease.workItemId) as
          { lease_expires_at_ms: number | null } | undefined;
        const expectedAgentVersionId = definition?.kind === "agent"
          ? definition.agentVersionId
          : definition?.kind === "verification"
            ? definition.verifierAgentVersionId : null;
        if (providerCheckpoint === null || checkpointDigest === null ||
            this.#digester.sha256(canonicalJson(providerCheckpoint)) !== checkpointDigest ||
            (dispatch !== null &&
              ((dispatch.status === "responseObserved" &&
                  dispatch.responseCheckpointDigest !== checkpointDigest) ||
                dispatch.operation !== "dispatch" ||
                dispatch.provider.agentVersionId !== node.agentVersionId ||
                dispatch.provider.adapterName !== providerCheckpoint.adapterName ||
                dispatch.provider.adapterVersion !== providerCheckpoint.adapterVersion ||
                dispatch.provider.modelId !== providerCheckpoint.modelId)) ||
            definition === undefined || definition.kind === "humanGate" ||
            node.agentVersionId !== expectedAgentVersionId ||
            inputValue === null || inputValue.valueDigest !== node.inputDigest ||
            leaseRow?.lease_expires_at_ms === null ||
            leaseRow?.lease_expires_at_ms === undefined ||
            leaseRow.lease_expires_at_ms <= nowMs)
          throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
        const resumed = takeOverSqliteWorkflowContinuation(this.#database, {
          priorAuthority: authority,
          reconciliationLease: input.lease,
          checkpoint,
          execution: execution!,
          nodeInputDigest: inputValue.valueDigest,
          dispatch: dispatch?.status === "responseObserved"
            ? { ...dispatch, status: "responseObserved" as const }
            : dispatch?.status === "prepared"
              ? { ...dispatch, status: "prepared" as const }
            : { ...latestDispatch!, status: "terminal" as const },
          reconciliationLeaseExpiresAt:
            new Date(leaseRow.lease_expires_at_ms).toISOString(),
          resumedAt: now,
        });
        const pendingTools = takeOverSqliteWorkflowPendingTools(this.#database, {
          priorAuthority: authority,
          reconciliationLease: input.lease,
          checkpoint,
          adoptedAt: now,
          digester: this.#digester,
        });
        const result = {
          disposition: "resumeRequired" as const,
          evidenceStatus: "responseObserved" as const,
          resume: {
            claim: { node: definition, claimId: input.claimId,
              claimEpoch: input.claimEpoch, gateRequestId: null,
              inputDigest: node.inputDigest! },
            step, attempt: resumed.attempt,
            reconciliationLease: input.lease,
            continuation: resumed.continuation,
            pendingTools,
          },
          execution: resumed.execution, handoff: {
            currentWorkItem: "retained" as const,
            nextWorkItemId: null, kind: "none" as const },
          runDisposition: "nonTerminal" as const,
        };
        this.#database.exec("COMMIT");
        return structuredClone(result);
      }
      const resumedRetrieval = node.status === "running" &&
        dispatch?.status === "responseObserved" && checkpoint !== null &&
        checkpoint.activeDispatch === null && checkpoint.terminalCandidate === null &&
        attempt.workItemId === input.lease.workItemId &&
        attempt.leaseEpoch === input.lease.leaseEpoch;
      if (node.status === "running" && !resumedRetrieval)
        throw new RunStoreError("workflow_composition_claim_mismatch");
      if (dispatch?.status === "responseObserved") {
        const candidate = checkpoint?.terminalCandidate ?? null;
        const workflow = this.#loadWorkflow(input);
        if (candidate === null) {
          const providerCheckpoint = attempt.providerCheckpoint;
          const checkpointDigest = attempt.checkpointDigest;
          const inputValue = this.#loadExecutionValue(
            input.tenantId, input.runId, "nodeInput", input.nodeId);
          const definition = workflow.nodes.find(
            (candidate) => candidate.nodeId === input.nodeId);
          if (providerCheckpoint === null || checkpointDigest === null ||
              this.#digester.sha256(canonicalJson(providerCheckpoint)) !== checkpointDigest ||
              dispatch.responseCheckpointDigest !== checkpointDigest ||
              dispatch.operation !== "dispatch" ||
              dispatch.provider.agentVersionId !== node.agentVersionId ||
              dispatch.provider.adapterName !== providerCheckpoint.adapterName ||
              dispatch.provider.adapterVersion !== providerCheckpoint.adapterVersion ||
              dispatch.provider.modelId !== providerCheckpoint.modelId ||
              inputValue === null || inputValue.valueDigest !== node.inputDigest ||
              definition === undefined || definition.kind === "humanGate")
            throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
          this.#database.exec("COMMIT");
          return structuredClone({ disposition: "retrieveRequired" as const,
            evidenceStatus: "responseObserved" as const, execution: execution!,
            recovery: { claim: { node: definition, claimId: input.claimId,
              claimEpoch: input.claimEpoch, gateRequestId: null,
              inputDigest: node.inputDigest! }, step, attempt: {
                ...attempt, checkpointDigest, providerCheckpoint },
              inputValue: { schemaVersion: "crewon.workflow-execution-value.v0" as const,
                ...inputValue,
                value: structuredClone(inputValue.value) as
                  WorkflowExecutionValue["value"] },
              dispatch: { ...dispatch, status: "responseObserved" as const },
              priorContinuation: checkpoint },
            handoff: { currentWorkItem: "retained" as const,
              nextWorkItemId: null, kind: "none" as const },
            runDisposition: "nonTerminal" as const });
        }
        const dispatchOutcome = candidate.dispatchTerminalOutcome;
        const evidence = candidate.evidence;
        if (run!.cancelRequested && candidate !== null) {
          const terminal = terminateSqliteModelDispatchForAttempt(this.#database, {
            tenantId: input.tenantId, runId: input.runId,
            attempt: { stepId: input.nodeId, attemptId: attempt.attemptId },
            attemptWorkItemId: attempt.workItemId, attemptLeaseEpoch: attempt.leaseEpoch,
            operationId: dispatch.operationId, requestSequence: dispatch.requestSequence,
            expectedRevision: dispatch.revision, transitionedAt: now, outcome: dispatchOutcome,
          });
          if (terminal.status !== "terminal")
            throw new RunStoreError("workflow_cancellation_dispatch_conflict");
          const settlementInput = { tenantId: input.tenantId, runId: input.runId,
            lease: input.lease, binding: input.binding, nodeId: input.nodeId,
            claimId: input.claimId, claimEpoch: input.claimEpoch, stepId: input.nodeId,
            attemptId: attempt.attemptId,
            operationId: `reconcile-cancel:${input.reconciliationOperationId}`,
            outcome: { status: "canceled" as const } };
          const settled = settleSqliteWorkflowNodeWithinTransaction(
            { ...this.#nodeSettlementContext(), receipt: () => null,
              insertReceipt: () => undefined,
              convergeTerminalRun: () => "nonTerminal" }, settlementInput,
            this.#fingerprint("reconcileCancel", { input, candidateId: candidate.candidateId }),
            now, nowMs, { attemptAuthority: { workItemId: attempt.workItemId,
              leaseEpoch: attempt.leaseEpoch },
              attemptCheckpointDigest: terminal.responseCheckpointDigest,
              suppressContinuation: true });
          const result = { disposition: "settled" as const, evidenceStatus,
            execution: settled.execution, handoff: settled.handoff,
            runDisposition: settled.runDisposition };
          this.#insertReceipt(receiptInput, "reconcileNode", fingerprint,
            { ...result, cancellationWinner: true });
          this.#database.exec("COMMIT");
          return structuredClone(result);
        }
        const settled = settleSqliteWorkflowNodeModelTerminalWithinTransaction(
          this.#nodeSettlementContext(), { binding: input.binding,
            nodeId: input.nodeId, operationId: `node-model-terminal:${input.claimId}`,
            evidence, lease: input.lease, authority,
            dispatch: { operationId: dispatch.operationId,
              requestSequence: dispatch.requestSequence,
              expectedRevision: dispatch.revision, status: dispatch.status },
            dispatchTerminalOutcome: dispatchOutcome },
          this.#fingerprint("settleNode", { input, evidence, dispatchOutcome }),
          now, nowMs, "reconciliation");
        const result = { disposition: "settled" as const, evidenceStatus,
          execution: this.#loadExecution(input.tenantId, input.runId)!,
          handoff: settled.handoff, runDisposition: settled.runDisposition };
        this.#insertReceipt(
          receiptInput, "reconcileNode", fingerprint, result);
        this.#database.exec("COMMIT");
        return structuredClone(result);
      }
      if (evidenceStatus === "notDispatched") {
        if (run!.cancelRequested) {
          const terminal = dispatch === null ? null
            : terminateSqliteModelDispatchForAttempt(this.#database, {
                tenantId: input.tenantId, runId: input.runId,
                attempt: { stepId: input.nodeId, attemptId: attempt.attemptId },
                attemptWorkItemId: attempt.workItemId,
                attemptLeaseEpoch: attempt.leaseEpoch,
                operationId: dispatch.operationId,
                requestSequence: dispatch.requestSequence,
                expectedRevision: dispatch.revision,
                transitionedAt: now,
                outcome: { kind: "canceled", code: "user_requested", certainty: "notSent" },
              });
          const settlementInput = { tenantId: input.tenantId, runId: input.runId,
            lease: input.lease, binding: input.binding, nodeId: input.nodeId,
            claimId: input.claimId, claimEpoch: input.claimEpoch, stepId: input.nodeId,
            attemptId: attempt.attemptId,
            operationId: `reconcile-cancel:${input.reconciliationOperationId}`,
            outcome: { status: "canceled" as const } };
          const settled = settleSqliteWorkflowNodeWithinTransaction(
            { ...this.#nodeSettlementContext(), receipt: () => null,
              insertReceipt: () => undefined,
              convergeTerminalRun: () => "nonTerminal" }, settlementInput,
            this.#fingerprint("reconcileCancel", { input, evidenceStatus }),
            now, nowMs, { attemptAuthority: { workItemId: attempt.workItemId,
              leaseEpoch: attempt.leaseEpoch },
              attemptCheckpointDigest: terminal?.responseCheckpointDigest ?? null,
              suppressContinuation: true });
          const result = { disposition: "settled" as const, evidenceStatus,
            execution: settled.execution, handoff: settled.handoff,
            runDisposition: "nonTerminal" as const };
          this.#insertReceipt(receiptInput, "reconcileNode", fingerprint,
            { ...result, cancellationWinner: true });
          this.#database.exec("COMMIT");
          return structuredClone(result);
        }
        finishSqliteRunAttempt(this.#database, { tenantId: input.tenantId,
          runId: input.runId, workItemId: attempt.workItemId,
          leaseEpoch: attempt.leaseEpoch, attempt: { stepId: input.nodeId,
            attemptId: attempt.attemptId, status: "failed", finishedAt: now,
            checkpointDigest: null, failure: {
              code: "workflow_model_not_dispatched", retryable: true } } });
        const claimEpoch = input.claimEpoch + 1;
        const claimAuthority = { tenantId: input.tenantId, runId: input.runId,
          binding: input.binding, nodeId: input.nodeId, claimEpoch,
          reconciliationOperationId: input.reconciliationOperationId };
        const claimId = workflowAuthorityId(
          "claim", claimAuthority, this.#digester);
        const workAuthority = { ...claimAuthority, claimId,
          schedulerOperationId: input.reconciliationOperationId };
        const workItemId = workflowAuthorityId(
          "node", workAuthority, this.#digester);
        const next = { ...execution!, revision: execution!.revision + 1,
          nodes: execution!.nodes.map((candidate) => candidate.nodeId === input.nodeId
            ? { ...candidate, status: "queued" as const, claimId,
                claimOperationId: input.reconciliationOperationId,
                claimEpoch, leaseExpiresAt: null, gateRequestId: null,
                resultDigest: null, failureCode: null }
            : candidate), updatedAt: now };
        this.#writeExecution(next, now);
        this.#insertWorkflowWorkItem(workItemId, input, {
          schemaVersion: "crewon.workflow-node-work-item.v0",
          trigger: "workflowNode", binding: input.binding,
          nodeId: input.nodeId, claimId, claimEpoch,
          schedulerOperationId: input.reconciliationOperationId,
        }, now, nowMs);
        const result = { disposition: "retryScheduled" as const,
          evidenceStatus, execution: next, handoff: {
            currentWorkItem: "completed" as const,
            nextWorkItemId: workItemId, kind: "node" as const },
          runDisposition: "nonTerminal" as const };
        this.#insertReceipt(receiptInput, "reconcileNode", fingerprint, result);
        this.#completeLease(input, nowMs);
        this.#database.exec("COMMIT");
        return structuredClone(result);
      }
      if (evidenceStatus === "possiblySent") {
        if (run!.cancelRequested) {
          const terminal = terminateSqliteModelDispatchForAttempt(
            this.#database,
            {
              tenantId: input.tenantId,
              runId: input.runId,
              attempt: {
                stepId: input.nodeId,
                attemptId: attempt.attemptId,
              },
              attemptWorkItemId: attempt.workItemId,
              attemptLeaseEpoch: attempt.leaseEpoch,
              operationId: dispatch!.operationId,
              requestSequence: dispatch!.requestSequence,
              expectedRevision: dispatch!.revision,
              transitionedAt: now,
              outcome: {
                kind: "canceled",
                code: "user_requested",
                certainty: "abandonedPossiblySent",
              },
            },
          );
          const settlementInput = {
            tenantId: input.tenantId,
            runId: input.runId,
            lease: input.lease,
            binding: input.binding,
            nodeId: input.nodeId,
            claimId: input.claimId,
            claimEpoch: input.claimEpoch,
            stepId: input.nodeId,
            attemptId: attempt.attemptId,
            operationId: `reconcile-cancel:${input.reconciliationOperationId}`,
            outcome: { status: "canceled" as const },
          };
          const settled = settleSqliteWorkflowNodeWithinTransaction(
            {
              ...this.#nodeSettlementContext(),
              receipt: () => null,
              insertReceipt: () => undefined,
              convergeTerminalRun: () => "nonTerminal",
            },
            settlementInput,
            this.#fingerprint("reconcileCancel", { input, evidenceStatus }),
            now,
            nowMs,
            {
              attemptAuthority: {
                workItemId: attempt.workItemId,
                leaseEpoch: attempt.leaseEpoch,
              },
              attemptCheckpointDigest: terminal.responseCheckpointDigest,
              suppressContinuation: true,
            },
          );
          const result = {
            disposition: "settled" as const,
            evidenceStatus,
            execution: settled.execution,
            handoff: settled.handoff,
            runDisposition: "nonTerminal" as const,
          };
          this.#insertReceipt(receiptInput, "reconcileNode", fingerprint, {
            ...result,
            cancellationWinner: true,
          });
          this.#database.exec("COMMIT");
          return structuredClone(result);
        }
        const terminal = terminateSqliteModelDispatchForAttempt(this.#database, {
          tenantId: input.tenantId, runId: input.runId,
          attempt: { stepId: input.nodeId, attemptId: attempt.attemptId },
          attemptWorkItemId: attempt.workItemId,
          attemptLeaseEpoch: attempt.leaseEpoch,
          operationId: dispatch!.operationId,
          requestSequence: dispatch!.requestSequence,
          expectedRevision: dispatch!.revision,
          transitionedAt: now,
          outcome: { kind: "failed",
            code: WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED,
            certainty: "operatorRequired" },
        });
        const settlementInput = { tenantId: input.tenantId, runId: input.runId,
          lease: input.lease, binding: input.binding, nodeId: input.nodeId,
          claimId: input.claimId, claimEpoch: input.claimEpoch,
          stepId: input.nodeId, attemptId: attempt.attemptId,
          operationId: `reconcile-operator:${input.reconciliationOperationId}`,
          outcome: { status: "failed" as const,
            failureCode: WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED } };
        const settled = settleSqliteWorkflowNodeWithinTransaction(
          { ...this.#nodeSettlementContext(), receipt: () => null,
            insertReceipt: () => undefined }, settlementInput,
          this.#fingerprint("reconcileOperatorRequired", { input, evidenceStatus }),
          now, nowMs, { attemptAuthority: { workItemId: attempt.workItemId,
            leaseEpoch: attempt.leaseEpoch },
            attemptCheckpointDigest: terminal.responseCheckpointDigest });
        if (settled.handoff.currentWorkItem !== "completed")
          throw new RunStoreError("workflow_reconciliation_handoff_corrupt");
        const result = { disposition: "operatorRequired" as const,
          evidenceStatus, execution: settled.execution,
          handoff: { ...settled.handoff, currentWorkItem: "completed" as const },
          runDisposition: settled.runDisposition };
        this.#insertReceipt(receiptInput, "reconcileNode", fingerprint, result);
        this.#database.exec("COMMIT");
        return structuredClone(result);
      }
      const result = { disposition: "evidenceInsufficient" as const,
        evidenceStatus, execution: execution!, handoff: {
          currentWorkItem: evidenceStatus === "responseObserved"
            ? "completed" as const : "retained" as const,
          nextWorkItemId: null,
          kind: "none" as const }, runDisposition: "nonTerminal" as const };
      if (evidenceStatus === "responseObserved") {
        this.#insertReceipt(receiptInput, "reconcileNode", fingerprint, result);
        this.#completeLease(input, nowMs);
      }
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async settleRetrievedWorkflowNode(
    input: Parameters<WorkflowRunCompositionStore["settleRetrievedWorkflowNode"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["settleRetrievedWorkflowNode"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const reconcileInput = {
      tenantId: input.tenantId, runId: input.runId, lease: input.lease,
      binding: input.binding, nodeId: input.nodeId, claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      reconciliationOperationId: input.reconciliationOperationId,
    };
    const fingerprint = this.#fingerprint("reconcileNode", reconcileInput);
    const receiptInput = { ...reconcileInput,
      operationId: `reconcile:${input.reconciliationOperationId}` };
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(receiptInput, "reconcileNode", fingerprint) as
        Awaited<ReturnType<WorkflowRunCompositionStore["settleRetrievedWorkflowNode"]>> | null;
      if (replay !== null) {
        if (stableJson(replay.evidence) !== stableJson(input.evidence) ||
            stableJson(replay.dispatchTerminalOutcome) !==
              stableJson(input.dispatchTerminalOutcome))
          throw new RunStoreError("workflow_reconciliation_receipt_corrupt");
        this.#database.exec("COMMIT");
        return structuredClone({ ...replay, disposition: "replay" });
      }
      const expectedPayload = {
        schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile", binding: input.binding,
        nodeId: input.nodeId, claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        reconciliationOperationId: input.reconciliationOperationId,
      };
      if (stableJson(this.#loadWorkItemPayload(input.lease.workItemId)) !==
          stableJson(expectedPayload))
        throw new RunStoreError("workflow_composition_work_item_mismatch");
      const execution = this.#loadExecution(input.tenantId, input.runId);
      const node = executionNode(input, execution);
      const resumedAuthority = node.status === "running" &&
        input.attempt.workItemId === input.lease.workItemId &&
        input.attempt.leaseEpoch === input.lease.leaseEpoch;
      if ((node.status !== "unknown" && !resumedAuthority) ||
          node.claimId !== input.claimId || node.claimEpoch !== input.claimEpoch ||
          node.agentVersionId !== input.agentVersionId)
        throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
      const authority = {
        tenantId: input.tenantId, runId: input.runId,
        workItemId: input.attempt.workItemId,
        leaseEpoch: input.attempt.leaseEpoch,
        nodeId: input.nodeId,
        nodeKind: node.kind === "verification" ? "verification" as const : "agent" as const,
        claimId: input.claimId, claimEpoch: input.claimEpoch,
        agentVersionId: input.agentVersionId,
        attempt: { stepId: input.attempt.stepId,
          attemptId: input.attempt.attemptId },
      };
      const settled = settleSqliteWorkflowNodeModelTerminalWithinTransaction(
        { ...this.#nodeSettlementContext(), receipt: () => null,
          insertReceipt: () => undefined },
        { binding: input.binding, nodeId: input.nodeId,
          operationId: `node-model-terminal:${input.claimId}`,
          evidence: input.evidence, lease: input.lease, authority,
          dispatch: input.dispatch,
          dispatchTerminalOutcome: input.dispatchTerminalOutcome },
        this.#fingerprint("settleRetrievedNode", input),
        now, nowMs, "reconciliation");
      const result = {
        disposition: "settled" as const,
        evidenceStatus: "responseObserved" as const,
        evidence: structuredClone(input.evidence),
        dispatchTerminalOutcome: structuredClone(input.dispatchTerminalOutcome),
        execution: this.#loadExecution(input.tenantId, input.runId)!,
        handoff: settled.handoff,
        runDisposition: settled.runDisposition,
      };
      this.#insertReceipt(receiptInput, "reconcileNode", fingerprint, result);
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async commitRetrievedWorkflowNodeContinuation(
    input: Parameters<WorkflowRunCompositionStore["commitRetrievedWorkflowNodeContinuation"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["commitRetrievedWorkflowNodeContinuation"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateLease(input, nowMs);
      assertCanonicalRun(this.#loadRun(input.tenantId, input.runId), input.binding);
      const expectedPayload = {
        schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile", binding: input.binding,
        nodeId: input.nodeId, claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        reconciliationOperationId: input.reconciliationOperationId,
      };
      if (stableJson(this.#loadWorkItemPayload(input.lease.workItemId)) !==
          stableJson(expectedPayload))
        throw new RunStoreError("workflow_composition_work_item_mismatch");
      const execution = this.#loadExecution(input.tenantId, input.runId);
      const node = executionNode(input, execution);
      const workflow = this.#loadWorkflow(input);
      const definition = workflow.nodes.find(
        (candidate) => candidate.nodeId === input.nodeId);
      const expectedAgentVersionId = definition?.kind === "agent"
        ? definition.agentVersionId
        : definition?.kind === "verification"
          ? definition.verifierAgentVersionId : null;
      const step = loadSqliteRunStep(this.#database, {
        tenantId: input.tenantId, runId: input.runId,
        stepId: input.attempt.stepId });
      const attempt = loadSqliteRunAttempt(this.#database, {
        tenantId: input.tenantId, runId: input.runId,
        stepId: input.attempt.stepId, attemptId: input.attempt.attemptId });
      const dispatch = loadSqliteModelDispatchReceipt(this.#database, {
        tenantId: input.tenantId, runId: input.runId,
        stepId: input.attempt.stepId, attemptId: input.attempt.attemptId,
        operationId: input.dispatch.operationId });
      const inputValue = this.#loadExecutionValue(
        input.tenantId, input.runId, "nodeInput", input.nodeId);
      const leaseRow = this.#database.prepare(
        "SELECT lease_expires_at_ms FROM work_items WHERE work_item_id=?",
      ).get(input.lease.workItemId) as
        { lease_expires_at_ms: number | null } | undefined;
      if (execution === null || definition === undefined ||
          definition.kind === "humanGate" ||
          expectedAgentVersionId !== input.agentVersionId ||
          node.agentVersionId !== input.agentVersionId ||
          node.claimId !== input.claimId || node.claimEpoch !== input.claimEpoch ||
          (node.status !== "unknown" && node.status !== "running") ||
          step === null || step.currentAttemptId !== input.attempt.attemptId ||
          attempt === null || attempt.status !== "running" ||
          attempt.workItemId !== input.attempt.workItemId ||
          attempt.leaseEpoch !== input.attempt.leaseEpoch ||
          dispatch === null || dispatch.status !== "responseObserved" ||
          dispatch.operation !== "dispatch" ||
          dispatch.requestSequence !== input.dispatch.requestSequence ||
          dispatch.revision !== input.dispatch.expectedRevision ||
          dispatch.workItemId !== input.attempt.workItemId ||
          dispatch.leaseEpoch !== input.attempt.leaseEpoch ||
          inputValue === null || inputValue.valueDigest !== node.inputDigest ||
          leaseRow?.lease_expires_at_ms === null ||
          leaseRow?.lease_expires_at_ms === undefined ||
          leaseRow.lease_expires_at_ms <= nowMs)
        throw new RunStoreError("workflow_retrieved_continuation_corrupt");
      const authority = {
        tenantId: input.tenantId, runId: input.runId,
        workItemId: input.attempt.workItemId,
        leaseEpoch: input.attempt.leaseEpoch, nodeId: input.nodeId,
        nodeKind: node.kind === "verification"
          ? "verification" as const : "agent" as const,
        claimId: input.claimId, claimEpoch: input.claimEpoch,
        agentVersionId: input.agentVersionId,
        attempt: { stepId: input.attempt.stepId,
          attemptId: input.attempt.attemptId },
      };
      const resumed = commitSqliteRetrievedWorkflowContinuationWithinTransaction(
        this.#database, {
          authority, reconciliationLease: input.lease,
          priorContinuation: input.priorContinuation, payload: input.payload,
          dispatch: { ...dispatch, status: "responseObserved" }, step,
          currentAttempt: { ...attempt, status: "running" }, execution,
          nodeInputDigest: inputValue.valueDigest,
          reconciliationLeaseExpiresAt:
            new Date(leaseRow.lease_expires_at_ms).toISOString(),
          committedAt: now, digester: this.#digester,
        });
      const result = {
        disposition: "resumeRequired" as const,
        evidenceStatus: "responseObserved" as const,
        resume: {
          claim: { node: definition, claimId: input.claimId,
            claimEpoch: input.claimEpoch, gateRequestId: null,
            inputDigest: node.inputDigest! },
          step: resumed.step, attempt: resumed.attempt,
          reconciliationLease: input.lease,
          continuation: resumed.continuation,
          pendingTools: resumed.pendingTools,
        },
        execution: resumed.execution,
        handoff: { currentWorkItem: "retained" as const,
          nextWorkItemId: null, kind: "none" as const },
        runDisposition: "nonTerminal" as const,
      };
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async scheduleWorkflowNodes(
    input: Parameters<WorkflowRunCompositionStore["scheduleWorkflowNodes"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowNodes"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("scheduleNodes", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(input, "scheduleNodes", fingerprint);
      if (replay !== null) {
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
          nodeWorkItems: [] as const,
          gatePublications: [] as const,
          reconciliationClaims: [] as const,
        } as unknown as Awaited<
          ReturnType<WorkflowRunCompositionStore["scheduleWorkflowNodes"]>
        >);
      }
      this.#validateLease(input, nowMs);
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      const workflow = this.#loadWorkflow(input);
      let execution = this.#loadExecution(input.tenantId, input.runId);
      if (execution === null) {
        execution = initialExecution({
          tenantId: input.tenantId,
          runId: input.runId,
          workflow,
          updatedAt: now,
        });
        this.#database
          .prepare(
            `INSERT INTO workflow_executions(tenant_id,run_id,revision,state_json,updated_at)
           VALUES (?,?,?,?,?)`,
          )
          .run(input.tenantId, input.runId, 1, stableJson(execution), now);
      }
      assertExecutionBinding(
        execution,
        input.tenantId,
        input.runId,
        input.binding,
        workflow,
      );
      const recovery = reconciliationClaims(execution, workflow);
      const scheduled = recovery.length === 0
        ? scheduleReadyNodes({ execution, workflow,
            operationId: input.schedulerOperationId, now, digester: this.#digester,
            inputDigest: (nodeId) => this.#nodeInputDigest(input, workflow, nodeId) })
        : { execution, claims: [] };
      execution = scheduled.execution;
      const nodeWorkItems = [];
      const gatePublications = [];
      for (const claim of scheduled.claims) {
        const authority = {
          tenantId: input.tenantId,
          runId: input.runId,
          binding: input.binding,
          nodeId: claim.node.nodeId,
          claimId: claim.claimId,
          claimEpoch: claim.claimEpoch,
          schedulerOperationId: input.schedulerOperationId,
        };
        if (claim.node.kind === "humanGate") {
          const gateRequestId = claim.gateRequestId!;
          const publicationOutboxMessageId = workflowAuthorityId(
            "gate-outbox",
            authority,
            this.#digester,
          );
          const approvalResumeWorkItemId = workflowAuthorityId(
            "gate-resume",
            authority,
            this.#digester,
          );
          const gate = {
            ...authority,
            gateRequestId,
            approvalPolicyId: claim.node.approvalPolicyId,
            inputDigest: claim.inputDigest,
            publicationOutboxMessageId,
            approvalResumeWorkItemId,
            status: "publicationPending",
            createdAt: now,
            updatedAt: now,
          };
          const step = gateStep({
            tenantId: input.tenantId,
            runId: input.runId,
            nodeId: claim.node.nodeId,
            now,
          });
          this.#database
            .prepare(
              `INSERT INTO run_steps
             (tenant_id,run_id,step_id,kind,status,revision,current_attempt_id,attempt_count,state_json,created_at,updated_at,terminal_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              step.tenantId,
              step.runId,
              step.stepId,
              step.kind,
              step.status,
              step.revision,
              null,
              0,
              stableJson(step),
              now,
              now,
              null,
            );
          this.#database
            .prepare(
              `INSERT INTO workflow_gate_requests
             (tenant_id,run_id,node_id,gate_request_id,claim_id,claim_epoch,step_id,
              approval_policy_id,input_digest,publication_outbox_message_id,
              approval_resume_work_item_id,status,state_json,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,'publicationPending',?,?,?)`,
            )
            .run(
              input.tenantId,
              input.runId,
              claim.node.nodeId,
              gateRequestId,
              claim.claimId,
              claim.claimEpoch,
              claim.node.nodeId,
              claim.node.approvalPolicyId,
              claim.inputDigest,
              publicationOutboxMessageId,
              approvalResumeWorkItemId,
              stableJson(gate),
              now,
              now,
            );
          const message = {
            messageId: publicationOutboxMessageId,
            tenantId: input.tenantId,
            runId: input.runId,
            topic: "workflow.gate.requested",
            payload: gate,
            createdAt: now,
          };
          this.#database
            .prepare(
              `INSERT INTO outbox(message_id,tenant_id,run_id,topic,message_json,created_at,status,available_at_ms,lease_epoch,attempt_count)
             VALUES (?,?,?,?,?,?,'pending',?,0,0)`,
            )
            .run(
              publicationOutboxMessageId,
              input.tenantId,
              input.runId,
              message.topic,
              stableJson(message),
              now,
              nowMs,
            );
          gatePublications.push({
            nodeId: claim.node.nodeId,
            claimId: claim.claimId,
            claimEpoch: claim.claimEpoch,
            gateRequestId,
            publicationOutboxMessageId,
            approvalResumeWorkItemId,
          });
        } else {
          const workItemId = workflowAuthorityId(
            "node",
            authority,
            this.#digester,
          );
          this.#insertWorkflowWorkItem(
            workItemId,
            input,
            {
              schemaVersion: "crewon.workflow-node-work-item.v0",
              trigger: "workflowNode",
              binding: input.binding,
              nodeId: claim.node.nodeId,
              claimId: claim.claimId,
              claimEpoch: claim.claimEpoch,
              schedulerOperationId: input.schedulerOperationId,
            },
            now,
            nowMs,
          );
          nodeWorkItems.push({
            nodeId: claim.node.nodeId,
            claimId: claim.claimId,
            claimEpoch: claim.claimEpoch,
            workItemId,
          });
        }
      }
      this.#writeExecution(execution, now);
      const reconciliationWorkItemIds = recovery.map((claim) => {
        const reconciliationOperationId = workflowAuthorityId("reconcile", {
          tenantId: input.tenantId, runId: input.runId, binding: input.binding,
          schedulerOperationId: input.schedulerOperationId,
          nodeId: claim.node.nodeId, claimId: claim.claimId,
          claimEpoch: claim.claimEpoch,
        }, this.#digester);
        const reconciliationWorkItemId = workflowAuthorityId("reconcile", {
          tenantId: input.tenantId, runId: input.runId, binding: input.binding,
          operationId: reconciliationOperationId, nodeId: claim.node.nodeId,
          claimId: claim.claimId, claimEpoch: claim.claimEpoch,
        }, this.#digester);
        this.#insertWorkflowWorkItem(reconciliationWorkItemId, input, {
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile", binding: input.binding,
          nodeId: claim.node.nodeId, claimId: claim.claimId,
          claimEpoch: claim.claimEpoch,
          reconciliationOperationId,
        }, now, nowMs);
        return reconciliationWorkItemId;
      });
      const reconciliationWorkItemId = reconciliationWorkItemIds[0] ?? null;
      const result =
        recovery.length > 0
          ? {
              disposition: "reconcileRequired" as const,
              execution,
              nodeWorkItems: [] as const,
              gatePublications: [] as const,
              reconciliationClaims: recovery,
              handoff: { currentWorkItem: "completed" as const, nextWorkItemId: reconciliationWorkItemId, kind: "reconcile" as const },
              runDisposition: "nonTerminal" as const,
            }
          : {
              disposition: "scheduled" as const,
              execution,
              nodeWorkItems,
              gatePublications,
              reconciliationClaims: [] as const,
              handoff: { currentWorkItem: "completed" as const, nextWorkItemId: null, kind: "none" as const },
              runDisposition: "nonTerminal" as const,
            };
      this.#insertReceipt(input, "scheduleNodes", fingerprint, result);
      this.#completeLease(input, nowMs);
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async admitWorkflowNodeWork(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["admitWorkflowNodeWork"]> {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("admitNode", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(
        { ...input, operationId: input.admissionOperationId },
        "admitNode",
        fingerprint,
      );
      if (replay !== null) {
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
          admission: null,
        } as Awaited<
          ReturnType<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>
        >);
      }
      this.#validateLease(input, nowMs);
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      const workflow = this.#loadWorkflow(input);
      const execution = this.#loadExecution(input.tenantId, input.runId);
      if (execution === null)
        throw new RunStoreError("workflow_execution_not_found");
      const node = execution.nodes.find(
        (candidate) => candidate.nodeId === input.nodeId,
      );
      const definition = workflow.nodes.find(
        (candidate) => candidate.nodeId === input.nodeId,
      );
      if (
        node === undefined ||
        definition === undefined ||
        definition.kind === "humanGate" ||
        node.claimId !== input.claimId ||
        node.claimEpoch !== input.claimEpoch ||
        node.claimOperationId !== input.schedulerOperationId
      )
        throw new RunStoreError("workflow_composition_claim_mismatch");
      this.#assertNodeWorkPayload(input);
      if (node.status === "running") {
        const step = loadSqliteRunStep(this.#database, {
          tenantId: input.tenantId,
          runId: input.runId,
          stepId: input.nodeId,
        });
        const attempt = step?.currentAttemptId === null || step === null ? null
          : loadSqliteRunAttempt(this.#database, { tenantId: input.tenantId,
              runId: input.runId, stepId: input.nodeId,
              attemptId: step.currentAttemptId });
        if (attempt?.status !== "running" ||
            attempt.workItemId !== input.lease.workItemId ||
            attempt.leaseEpoch >= input.lease.leaseEpoch)
          throw new RunStoreError("workflow_composition_claim_mismatch");
        const reconciliationClaim = { node: definition, claimId: input.claimId,
          claimEpoch: input.claimEpoch, gateRequestId: null,
          inputDigest: node.inputDigest! };
        const reconciliationOperationId = workflowAuthorityId("reconcile", {
          tenantId: input.tenantId, runId: input.runId, binding: input.binding,
          schedulerOperationId: input.schedulerOperationId, nodeId: input.nodeId,
          claimId: input.claimId, claimEpoch: input.claimEpoch,
        }, this.#digester);
        const reconciliationWorkItemId = workflowAuthorityId("reconcile", {
          tenantId: input.tenantId, runId: input.runId, binding: input.binding,
          operationId: reconciliationOperationId, nodeId: input.nodeId,
          claimId: input.claimId, claimEpoch: input.claimEpoch,
        }, this.#digester);
        const next = { ...execution, revision: execution.revision + 1,
          nodes: execution.nodes.map((candidate) => candidate.nodeId === input.nodeId
            ? { ...candidate, status: "unknown" as const, leaseExpiresAt: null }
            : candidate), updatedAt: now };
        this.#writeExecution(next, now);
        this.#insertWorkflowWorkItem(reconciliationWorkItemId, input, {
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile", binding: input.binding,
          nodeId: input.nodeId, claimId: input.claimId,
          claimEpoch: input.claimEpoch, reconciliationOperationId,
        }, now, nowMs);
        const result = { disposition: "reconcileRequired" as const,
          execution: next, admission: null, reconciliationClaim,
          handoff: { currentWorkItem: "completed" as const,
            nextWorkItemId: reconciliationWorkItemId,
            kind: "reconcile" as const } };
        this.#insertReceipt(
          { ...input, operationId: input.admissionOperationId },
          "admitNode", fingerprint, result);
        this.#completeLease(input, nowMs);
        this.#database.exec("COMMIT");
        return structuredClone(result);
      }
      if (node.status !== "queued")
        throw new RunStoreError("workflow_composition_claim_mismatch");
      const attemptIdValue = workflowAuthorityId(
        "attempt",
        {
          tenantId: input.tenantId,
          runId: input.runId,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
        },
        this.#digester,
      );
      const started = beginSqliteRunAttempt(this.#database, {
        tenantId: input.tenantId,
        runId: input.runId,
        lease: input.lease,
        stepId: input.nodeId,
        kind: definition.kind === "verification" ? "verification" : "agent",
        attemptId: attemptIdValue,
        startedAt: now,
      });
      const expiresAt = new Date(
        nowMs + input.attemptLeaseDurationMs,
      ).toISOString();
      const next = {
        ...execution,
        revision: execution.revision + 1,
        nodes: execution.nodes.map((candidate) =>
          candidate.nodeId === input.nodeId
            ? {
                ...candidate,
                status: "running" as const,
                leaseExpiresAt: expiresAt,
              }
            : candidate,
        ),
        updatedAt: now,
      };
      this.#writeExecution(next, now);
      const claim = {
        node: definition,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        gateRequestId: null,
        inputDigest: node.inputDigest!,
      };
      const inputValue = this.#composeNodeInputValue(input, workflow, now);
      const result = {
        disposition: "fresh" as const,
        execution: next,
        admission: { claim, step: started.step, attempt: started.attempt, inputValue },
        handoff: { currentWorkItem: "retained" as const, nextWorkItemId: null, kind: "none" as const },
      };
      this.#insertReceipt(
        { ...input, operationId: input.admissionOperationId },
        "admitNode",
        fingerprint,
        result,
      );
      this.#database.exec("COMMIT");
      return structuredClone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  async recordWorkflowHumanGateDecision(
    input: Parameters<
      WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
    >[0],
  ): ReturnType<
    WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
  > {
    const nowMs = readLeaseClock(this.#clock);
    const now = new Date(nowMs).toISOString();
    const fingerprint = this.#fingerprint("recordGateDecision", input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replay = this.#receipt(
        { ...input, operationId: input.decisionReceiptId },
        "recordGateDecision",
        fingerprint,
      );
      if (replay !== null) {
        this.#validateGateDecisionReplay(input, replay);
        this.#database.exec("COMMIT");
        return structuredClone({
          ...(replay as object),
          disposition: "replay",
        } as Awaited<
          ReturnType<
            WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
          >
        >);
      }
      assertCanonicalRun(
        this.#loadRun(input.tenantId, input.runId),
        input.binding,
      );
      assertGateDecisionOutcome(input.outcome);
      const gate = this.#loadGate(input);
      if (
        gate.status !== "published" ||
        gate.tenantId !== input.tenantId ||
        gate.runId !== input.runId ||
        gate.nodeId !== input.nodeId ||
        stableJson(gate.binding) !== stableJson(input.binding) ||
        gate.gateRequestId !== input.gateRequestId ||
        gate.claimId !== input.claimId ||
        gate.claimEpoch !== input.claimEpoch
      )
        throw new RunStoreError("workflow_gate_decision_mismatch");
      const state = {
        ...gate,
        status: input.outcome.status,
        decisionReceiptId: input.decisionReceiptId,
        outcome: input.outcome,
        updatedAt: now,
      };
      const approvalResumeWorkItemId = gate.approvalResumeWorkItemId;
      if (typeof approvalResumeWorkItemId !== "string")
        throw new RunStoreError("workflow_gate_store_corrupt");
      const updated = this.#database
        .prepare(
          `UPDATE workflow_gate_requests SET status=?,state_json=?,updated_at=?
         WHERE tenant_id=? AND run_id=? AND node_id=? AND status='published'`,
        )
        .run(
          input.outcome.status,
          stableJson(state),
          now,
          input.tenantId,
          input.runId,
          input.nodeId,
        );
      if (updated.changes !== 1)
        throw new RunStoreError("workflow_gate_decision_mismatch");
      this.#insertWorkflowWorkItem(
        approvalResumeWorkItemId,
        input,
        {
          schemaVersion: "crewon.workflow-gate-resume-work-item.v0",
          trigger: "workflowGateResume",
          binding: input.binding,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
          gateRequestId: input.gateRequestId,
          decisionReceiptId: input.decisionReceiptId,
        },
        now,
        nowMs,
      );
      const result = {
        disposition: "recorded" as const,
        approvalResumeWorkItemId,
      };
      this.#insertReceipt(
        { ...input, operationId: input.decisionReceiptId },
        "recordGateDecision",
        fingerprint,
        result,
      );
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw normalizeCompositionError(error);
    }
  }

  #validateGateDecisionReplay(
    input: Parameters<WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]>[0],
    replay: unknown,
  ): void {
    const result = replay as Record<string, unknown>;
    if (result === null || typeof result !== "object" ||
        result.disposition !== "recorded" ||
        typeof result.approvalResumeWorkItemId !== "string" ||
        Object.keys(result).sort().join(",") !== "approvalResumeWorkItemId,disposition")
      throw new RunStoreError("workflow_gate_receipt_corrupt");
    const gate = this.#loadGate(input);
    const workItemId = result.approvalResumeWorkItemId;
    const row = this.#database.prepare(
      `SELECT tenant_id,run_id,kind,status,work_item_json FROM work_items
       WHERE work_item_id=?`,
    ).get(workItemId) as Record<string, unknown> | undefined;
    let item: Record<string, unknown> | null;
    try {
      item = row === undefined ? null
        : JSON.parse(String(row.work_item_json)) as Record<string, unknown>;
    } catch {
      throw new RunStoreError("workflow_gate_receipt_corrupt");
    }
    const payload = { schemaVersion: "crewon.workflow-gate-resume-work-item.v0",
      trigger: "workflowGateResume", binding: input.binding,
      nodeId: input.nodeId, claimId: input.claimId, claimEpoch: input.claimEpoch,
      gateRequestId: input.gateRequestId, decisionReceiptId: input.decisionReceiptId };
    if (gate.tenantId !== input.tenantId || gate.runId !== input.runId ||
        gate.nodeId !== input.nodeId ||
        stableJson(gate.binding) !== stableJson(input.binding) ||
        gate.claimId !== input.claimId || gate.claimEpoch !== input.claimEpoch ||
        gate.gateRequestId !== input.gateRequestId ||
        gate.decisionReceiptId !== input.decisionReceiptId ||
        gate.status !== input.outcome.status ||
        stableJson(gate.outcome) !== stableJson(input.outcome) ||
        gate.approvalResumeWorkItemId !== workItemId ||
        row?.tenant_id !== input.tenantId || row.run_id !== input.runId ||
        row.kind !== "run.execute" ||
        !["pending", "leased", "completed"].includes(String(row.status)) ||
        item?.workItemId !== workItemId || item.tenantId !== input.tenantId ||
        item.runId !== input.runId || item.kind !== "run.execute" ||
        stableJson(item.payload) !== stableJson(payload))
      throw new RunStoreError("workflow_gate_receipt_corrupt");
  }

  #validateLease(
    input: Readonly<{
      tenantId: string;
      runId: string;
      lease: import("@crewon/application").WorkItemLeaseInput;
    }>,
    nowMs: number,
  ): void {
    const row = this.#database
      .prepare(
        `SELECT tenant_id,run_id,status,lease_owner_id,lease_id,lease_epoch,lease_expires_at_ms
         FROM work_items WHERE work_item_id=?`,
      )
      .get(input.lease.workItemId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new RunStoreError("queue_item_not_found");
    if (row.tenant_id !== input.tenantId || row.run_id !== input.runId)
      throw new RunStoreError("work_item_scope_mismatch");
    if (
      row.status !== "leased" ||
      row.lease_owner_id !== input.lease.ownerId ||
      row.lease_id !== input.lease.leaseId ||
      row.lease_epoch !== input.lease.leaseEpoch
    )
      throw new RunStoreError("stale_lease");
    if (
      typeof row.lease_expires_at_ms !== "number" ||
      row.lease_expires_at_ms <= nowMs
    )
      throw new RunStoreError("lease_expired");
  }

  #nodeSettlementContext(): SqliteWorkflowNodeSettlementContext {
    return {
      database: this.#database,
      digester: this.#digester,
      receipt: (value, kind, hash) => this.#receipt(value, kind, hash),
      validateTerminalReplay: (value, replay) =>
        this.#validateTerminalReplay(value, replay),
      validateNodeTerminalReplay: (value) =>
        this.#validateNodeTerminalReplay(value),
      validateLease: (value, clock) => this.#validateLease(value, clock),
      assertCanonicalRun,
      loadRun: (tenantId, runId) => this.#loadRun(tenantId, runId),
      loadExecution: (tenantId, runId) => this.#loadExecution(tenantId, runId),
      loadWorkflow: (value) => this.#loadWorkflow(value),
      insertExecutionValue: (value) => this.#insertExecutionValue(value),
      appendNodeTerminalEvent: (value, digest, timestamp, clock) => {
        if (value.outcome.status === "unknown")
          throw new RunStoreError("workflow_composition_unknown_not_terminal");
        this.#appendNodeTerminalEvent({ ...value, outcome: value.outcome },
          digest, timestamp, clock);
      },
      cancelPendingNode: (value, node, timestamp, clock) =>
        this.#cancelPendingNode(value, node, timestamp, clock),
      writeExecution: (value, timestamp) => this.#writeExecution(value, timestamp),
      convergeTerminalRun: (value, workflow, execution, timestamp, clock) =>
        this.#convergeTerminalRun(value, workflow, execution, timestamp, clock),
      insertWorkflowWorkItem: (id, value, payload, timestamp, clock) =>
        this.#insertWorkflowWorkItem(id, value, payload, timestamp, clock),
      rootInputRef: (value) => this.#rootInputRef(value),
      insertReceipt: (value, kind, hash, receipt) =>
        this.#insertReceipt(value, kind, hash, receipt),
      completeLease: (value, clock) => this.#completeLease(value, clock),
    };
  }

  #cancelUnadmittedStep(
    input: Readonly<{ tenantId: string; runId: string }>,
    nodeId: string,
    nodeKind: "agent" | "verification" | "humanGate",
    now: string,
  ): void {
    if (loadSqliteRunStep(this.#database, { tenantId: input.tenantId,
      runId: input.runId, stepId: nodeId }) !== null)
      throw new RunStoreError("workflow_cancellation_step_conflict");
    const step = { schemaVersion: "crewon.run-step.v0", stepId: nodeId,
      tenantId: input.tenantId, runId: input.runId,
      kind: nodeKind === "humanGate" ? "gate" : nodeKind,
      status: "canceled", revision: 1, currentAttemptId: null,
      attemptCount: 0, createdAt: now, updatedAt: now, terminalAt: now };
    this.#database.prepare(`INSERT INTO run_steps
      (tenant_id,run_id,step_id,kind,status,revision,current_attempt_id,attempt_count,
       state_json,created_at,updated_at,terminal_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.tenantId, input.runId, nodeId, step.kind, step.status, step.revision,
       null, 0, stableJson(step), now, now, now);
  }

  #cancelPendingNode(
    input: Readonly<{
      tenantId: string;
      runId: string;
      binding: import("@crewon/domain").FrozenWorkflowVersionBinding;
      operationId: string;
    }>,
    node: import("@crewon/application").WorkflowExecutionState["nodes"][number],
    now: string,
    nowMs: number,
  ): void {
    this.#cancelUnadmittedStep(input, node.nodeId, node.kind, now);
    this.#appendNodeTerminalEvent(
      {
        ...input,
        nodeId: node.nodeId,
        claimId: null,
        claimEpoch: null,
        stepId: node.nodeId,
        attemptId: null,
        operationId: `${input.operationId}:${node.nodeId}:blocked`,
        outcome: { status: "canceled" },
      },
      null,
      now,
      nowMs,
    );
  }

  #cancelOwnedWorkflowNode(
    input: Parameters<WorkflowRunCompositionStore["cancelWorkflowExecution"]>[0],
    execution: import("@crewon/application").WorkflowExecutionState,
    payload: { nodeId?: unknown; claimId?: unknown; claimEpoch?: unknown },
    fingerprint: string,
    now: string,
    nowMs: number,
  ): WorkflowCancellationResult {
    const node = execution.nodes.find((candidate) => candidate.nodeId === payload.nodeId);
    if (node === undefined || node.claimId !== payload.claimId ||
        node.claimEpoch !== payload.claimEpoch || stableJson(payload) !== stableJson({
          schemaVersion: "crewon.workflow-node-work-item.v0",
          trigger: "workflowNode", binding: input.binding, nodeId: node.nodeId,
          claimId: node.claimId, claimEpoch: node.claimEpoch,
          schedulerOperationId: node.claimOperationId,
        }))
      throw new RunStoreError("workflow_composition_work_item_mismatch");
    if (node.status === "queued") {
      this.#cancelUnadmittedStep(input, node.nodeId, node.kind, now);
      this.#appendNodeTerminalEvent({ ...input, nodeId: node.nodeId,
        claimId: node.claimId, claimEpoch: node.claimEpoch, stepId: node.nodeId,
        attemptId: null, operationId: `${input.operationId}:${node.nodeId}`,
        outcome: { status: "canceled" } }, null, now, nowMs);
      const canceledNodeIds = [node.nodeId];
      const nodes = execution.nodes.map((candidate) => candidate.nodeId === node.nodeId
        ? { ...candidate, status: "canceled" as const } : candidate);
      const status = nodes.some((candidate) =>
        ["queued", "running", "unknown"].includes(candidate.status))
        ? "running" as const
        : nodes.some((candidate) => candidate.status === "waitingHuman")
          ? "waitingHuman" as const : "canceled" as const;
      const next = { ...execution, revision: execution.revision + 1, nodes, status,
        updatedAt: now };
      this.#writeExecution(next, now);
      canceledNodeIds.sort();
      const result = { disposition: "cancellationPending" as const,
        canceledNodeIds, canceledGateRequestNodeIds: [],
        reconciliationWorkItemIds: [], execution: next,
        handoff: { currentWorkItem: "completed" as const, nextWorkItemId: null,
          kind: "none" as const }, runDisposition: "nonTerminal" as const };
      this.#insertReceipt(input, "cancelExecution", fingerprint, result);
      this.#completeLease(input, nowMs);
      return result;
    }
    if (node.status !== "running")
      throw new RunStoreError("workflow_cancellation_reconciliation_required");
    const step = loadSqliteRunStep(this.#database, { tenantId: input.tenantId,
      runId: input.runId, stepId: node.nodeId });
    const attempt = step?.currentAttemptId === null || step === null ? null
      : loadSqliteRunAttempt(this.#database, { tenantId: input.tenantId,
          runId: input.runId, stepId: node.nodeId, attemptId: step.currentAttemptId });
    if (step === null || attempt === null || attempt.status !== "running" ||
        attempt.workItemId !== input.lease.workItemId ||
        attempt.leaseEpoch > input.lease.leaseEpoch || node.claimId === null)
      throw new RunStoreError("workflow_cancellation_reconciliation_required");
    const dispatchRows = this.#database.prepare(
      `SELECT operation_id FROM model_dispatch_receipts WHERE tenant_id=? AND run_id=?
       AND step_id=? AND attempt_id=? AND status!='terminal'
       ORDER BY request_sequence DESC LIMIT 2`,
    ).all(input.tenantId, input.runId, node.nodeId, attempt.attemptId) as
      { operation_id: string }[];
    if (dispatchRows.length > 1)
      throw new RunStoreError("workflow_cancellation_reconciliation_required");
    const dispatch = dispatchRows[0] === undefined ? null
      : loadSqliteModelDispatchReceipt(this.#database, { tenantId: input.tenantId,
          runId: input.runId, stepId: node.nodeId, attemptId: attempt.attemptId,
          operationId: dispatchRows[0].operation_id });
    if (dispatch !== null && (dispatch.workItemId !== attempt.workItemId ||
        dispatch.leaseEpoch !== attempt.leaseEpoch))
      throw new RunStoreError("workflow_cancellation_reconciliation_required");
    if (dispatch?.status === "prepared") {
      const terminal = terminateSqliteModelDispatchForAttempt(this.#database, {
        tenantId: input.tenantId, runId: input.runId,
        attempt: { stepId: node.nodeId, attemptId: attempt.attemptId },
        attemptWorkItemId: attempt.workItemId, attemptLeaseEpoch: attempt.leaseEpoch,
        operationId: dispatch.operationId, requestSequence: dispatch.requestSequence,
        expectedRevision: dispatch.revision, transitionedAt: now,
        outcome: { kind: "canceled", code: "user_requested", certainty: "notSent" },
      });
      if (terminal.status !== "terminal")
        throw new RunStoreError("workflow_cancellation_dispatch_conflict");
    }
    const uncertain = dispatch?.status === "possiblySent" ||
      dispatch?.status === "responseObserved";
    const settlementInput = { ...input, nodeId: node.nodeId, claimId: node.claimId,
      claimEpoch: node.claimEpoch, stepId: node.nodeId, attemptId: attempt.attemptId,
      operationId: `${input.operationId}:${node.nodeId}`,
      outcome: uncertain ? { status: "unknown" as const } : { status: "canceled" as const } };
    const settled = settleSqliteWorkflowNodeWithinTransaction(
      { ...this.#nodeSettlementContext(), receipt: () => null,
        insertReceipt: () => undefined, completeLease: () => undefined },
      settlementInput, this.#fingerprint("cancelNode", settlementInput), now, nowMs,
      { deferOuterSettlement: true,
        attemptAuthority: { workItemId: attempt.workItemId,
          leaseEpoch: attempt.leaseEpoch } });
    let reconciliationWorkItemId: string | null = null;
    if (uncertain) {
      reconciliationWorkItemId = workflowAuthorityId("reconcile", {
        tenantId: input.tenantId, runId: input.runId, binding: input.binding,
        operationId: settlementInput.operationId, nodeId: node.nodeId,
        claimId: node.claimId, claimEpoch: node.claimEpoch }, this.#digester);
      this.#insertWorkflowWorkItem(reconciliationWorkItemId, input, {
        schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile", binding: input.binding, nodeId: node.nodeId,
        claimId: node.claimId, claimEpoch: node.claimEpoch,
        reconciliationOperationId: settlementInput.operationId }, now, nowMs);
    }
    const result = { disposition: uncertain
        ? "reconciliationScheduled" as const : "cancellationPending" as const,
      canceledNodeIds: uncertain ? [] : [node.nodeId], canceledGateRequestNodeIds: [],
      reconciliationWorkItemIds: reconciliationWorkItemId === null
        ? [] : [reconciliationWorkItemId],
      execution: settled.execution, handoff: { currentWorkItem: "completed" as const,
        nextWorkItemId: reconciliationWorkItemId,
        kind: uncertain ? "reconcile" as const : "none" as const },
      runDisposition: "nonTerminal" as const };
    this.#insertReceipt(input, "cancelExecution", fingerprint, result);
    this.#completeLease(input, nowMs);
    return result;
  }

  #completePendingCancellationWake(
    input: Parameters<WorkflowRunCompositionStore["cancelWorkflowExecution"]>[0],
    nowMs: number,
  ): void {
    const rows = this.#database.prepare(`SELECT work_item_id,status,lease_owner_id,lease_id,
      lease_epoch,work_item_json FROM work_items WHERE tenant_id=? AND run_id=?
      AND json_extract(work_item_json,'$.payload.trigger')='workflowCancel' LIMIT 2`)
      .all(input.tenantId, input.runId) as { work_item_id: string; status: string;
        lease_owner_id: string | null; lease_id: string | null; lease_epoch: number;
        work_item_json: string }[];
    if (rows.length > 1) throw new RunStoreError("workflow_cancellation_wakeup_corrupt");
    if (rows.length === 0) throw new RunStoreError("workflow_cancellation_wakeup_corrupt");
    const row = rows[0]!;
    const item = JSON.parse(row.work_item_json) as { payload: {
      schemaVersion: string; trigger: string; binding: unknown; cancellationOperationId: string } };
    const event = this.#database.prepare(
      "SELECT event_json FROM run_events WHERE tenant_id=? AND run_id=? AND event_id=?",
    ).get(input.tenantId, input.runId, item.payload.cancellationOperationId) as
      { event_json: string } | undefined;
    const cancellationEvent = event === undefined ? null : JSON.parse(event.event_json) as {
      schemaVersion?: unknown; identity?: { runId?: unknown }; eventId?: unknown;
      type?: unknown; data?: { actorId?: unknown } };
    if (item.payload.schemaVersion !== "crewon.workflow-cancel-work-item.v0" ||
        stableJson(item.payload.binding) !== stableJson(input.binding) ||
        cancellationEvent?.schemaVersion !== "crewon.run-event.v0" ||
        cancellationEvent.identity?.runId !== input.runId ||
        cancellationEvent.eventId !== item.payload.cancellationOperationId ||
        cancellationEvent.type !== "run.cancel.requested" ||
        typeof cancellationEvent.data?.actorId !== "string")
      throw new RunStoreError("workflow_cancellation_wakeup_corrupt");
    if (row.work_item_id === input.lease.workItemId) {
      if (row.status !== "leased" || row.lease_owner_id !== input.lease.ownerId ||
          row.lease_id !== input.lease.leaseId || row.lease_epoch !== input.lease.leaseEpoch)
        throw new RunStoreError("workflow_cancellation_wakeup_corrupt");
      return;
    }
    if (row.status === "completed") return;
    if (row.status !== "pending")
      throw new RunStoreError("workflow_cancellation_wakeup_leased");
    this.#database.prepare(`UPDATE work_items SET status='completed',completed_at_ms=?
      WHERE work_item_id=? AND status='pending'`).run(nowMs, rows[0]!.work_item_id);
  }

  #validateCancellationReplay(
    input: Parameters<WorkflowRunCompositionStore["cancelWorkflowExecution"]>[0],
    replay: unknown,
  ): void {
    try {
      const result = replay as Awaited<ReturnType<
        WorkflowRunCompositionStore["cancelWorkflowExecution"]>>;
      const execution = this.#loadExecution(input.tenantId, input.runId);
      const run = this.#loadRun(input.tenantId, input.runId);
      const eventRows = this.#database.prepare(
        `SELECT event_json FROM run_events WHERE tenant_id=? AND run_id=? ORDER BY sequence`,
      ).all(input.tenantId, input.runId) as { event_json: string }[];
      const events = eventRows.map((row) => JSON.parse(row.event_json)) as
        import("@crewon/domain").RunLifecycleEvent[];
      const nodeEvents = events.filter((event) => event.type === "workflow.node.terminal");
      const resultKeys = ["canceledGateRequestNodeIds", "canceledNodeIds", "disposition",
        "execution", "handoff", "reconciliationWorkItemIds", "runDisposition"];
      const terminal = result.runDisposition === "terminalConverged";
      const pending = result.disposition === "cancellationPending";
      const reconciliation = result.disposition === "reconciliationScheduled";
      if ((!pending && !reconciliation && result.disposition !== "canceled") ||
          (terminal && result.disposition !== "canceled" && !reconciliation) ||
          (!terminal && result.disposition === "canceled") ||
          result.runDisposition !== (terminal ? "terminalConverged" : "nonTerminal") ||
          stableJson(Object.keys(result).sort()) !== stableJson(resultKeys) ||
          result.handoff.currentWorkItem !== "completed" ||
          (pending && (result.handoff.nextWorkItemId !== null ||
            result.handoff.kind !== "none")) ||
          (reconciliation && (result.handoff.nextWorkItemId === null ||
            result.handoff.kind !== "reconcile")) ||
          (result.disposition === "canceled" &&
            (result.handoff.nextWorkItemId !== null || result.handoff.kind !== "none")) ||
          execution === null || run === null ||
          !this.#isCancellationReplayExecutionCompatible(result.execution, execution) ||
          (terminal ? execution.status !== "canceled"
            : !["running", "waitingHuman", "canceled"].includes(execution.status)) ||
          !Array.isArray(result.canceledNodeIds) ||
          !Array.isArray(result.canceledGateRequestNodeIds) ||
          !Array.isArray(result.reconciliationWorkItemIds) ||
          new Set(result.canceledNodeIds).size !== result.canceledNodeIds.length ||
          new Set(result.canceledGateRequestNodeIds).size !==
            result.canceledGateRequestNodeIds.length ||
          new Set(result.reconciliationWorkItemIds).size !==
            result.reconciliationWorkItemIds.length ||
          stableJson([...result.canceledNodeIds].sort()) !==
            stableJson(result.canceledNodeIds) ||
          stableJson([...result.canceledGateRequestNodeIds].sort()) !==
            stableJson(result.canceledGateRequestNodeIds) ||
          stableJson([...result.reconciliationWorkItemIds].sort()) !==
            stableJson(result.reconciliationWorkItemIds) ||
          result.canceledGateRequestNodeIds.some((nodeId) =>
            !result.canceledNodeIds.includes(nodeId)) ||
          result.canceledNodeIds.length > execution.nodes.length ||
          result.canceledGateRequestNodeIds.length > execution.nodes.length ||
          result.reconciliationWorkItemIds.length > execution.nodes.length ||
          (terminal ? run.status !== "canceled" : !["running", "canceled"].includes(run.status)) ||
          stableJson(replayRunLifecycle(events)) !== stableJson(run) ||
          nodeEvents.filter((event) => event.type === "workflow.node.terminal" &&
            result.canceledNodeIds.includes(event.data.nodeId)).length !==
              result.canceledNodeIds.length)
        throw new Error("cancel result mismatch");
      for (const nodeId of result.canceledNodeIds) {
        const node = execution.nodes.find((value) => value.nodeId === nodeId);
        const step = loadSqliteRunStep(this.#database, { tenantId: input.tenantId,
          runId: input.runId, stepId: nodeId });
        const event = nodeEvents.find((value) => value.type === "workflow.node.terminal" &&
          value.data.nodeId === nodeId);
        if (node?.status !== "canceled" || step?.status !== "canceled")
          throw new Error("cancel step mismatch");
        const attempt = step.currentAttemptId === null ? null
          : loadSqliteRunAttempt(this.#database, { tenantId: input.tenantId,
              runId: input.runId, stepId: nodeId, attemptId: step.currentAttemptId });
        if ((step.attemptCount === 0 && (step.currentAttemptId !== null || attempt !== null)) ||
            (step.attemptCount > 0 && attempt?.status !== "canceled"))
          throw new Error("cancel attempt mismatch");
        if (event?.type !== "workflow.node.terminal" || event.data.status !== "canceled" ||
            event.data.attemptId !== (attempt?.attemptId ?? null) ||
            event.data.claimId !== (node.claimId ?? null) ||
            event.data.claimEpoch !== (node.claimId === null ? null : node.claimEpoch))
          throw new Error("cancel event mismatch");
        if (attempt !== null) {
          const attemptWork = this.#database.prepare(
            "SELECT status,work_item_json FROM work_items WHERE work_item_id=?",
          ).get(attempt.workItemId) as { status: string; work_item_json: string } | undefined;
          const attemptPayload = attemptWork === undefined ? null
            : (JSON.parse(attemptWork.work_item_json) as { payload?: unknown }).payload;
          if (attemptWork?.status !== "completed" || stableJson(attemptPayload) !== stableJson({
            schemaVersion: "crewon.workflow-node-work-item.v0", trigger: "workflowNode",
            binding: input.binding, nodeId, claimId: node.claimId,
            claimEpoch: node.claimEpoch, schedulerOperationId: node.claimOperationId,
          })) throw new Error("cancel attempt work mismatch");
          const dispatchRows = this.#database.prepare(`SELECT operation_id FROM
            model_dispatch_receipts WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?
            ORDER BY request_sequence`).all(input.tenantId, input.runId, nodeId, attempt.attemptId) as
              { operation_id: string }[];
          for (const row of dispatchRows) {
            const dispatch = loadSqliteModelDispatchReceipt(this.#database, {
              tenantId: input.tenantId, runId: input.runId, stepId: nodeId,
              attemptId: attempt.attemptId, operationId: row.operation_id,
            });
            if (dispatch?.status !== "terminal" ||
                dispatch.workItemId !== attempt.workItemId ||
                dispatch.leaseEpoch !== attempt.leaseEpoch)
              throw new Error("cancel dispatch mismatch");
          }
        }
        const outbox = this.#database.prepare(`SELECT message_json FROM outbox
          WHERE tenant_id=? AND run_id=? AND json_extract(message_json,'$.payload.eventId')=?`)
          .all(input.tenantId, input.runId, event.eventId);
        if (outbox.length !== 1) throw new Error("cancel outbox mismatch");
      }
      if (reconciliation) {
        if (result.reconciliationWorkItemIds.length === 0 ||
            result.handoff.nextWorkItemId !== result.reconciliationWorkItemIds[0])
          throw new Error("cancel reconcile handoff mismatch");
        for (const workItemId of result.reconciliationWorkItemIds) {
          const row = this.#database.prepare(`SELECT status,work_item_json FROM work_items
            WHERE tenant_id=? AND run_id=? AND work_item_id=?`).get(
              input.tenantId, input.runId, workItemId) as
                { status: string; work_item_json: string } | undefined;
          const payload = row === undefined ? null
            : (JSON.parse(row.work_item_json) as { payload?: Record<string, unknown> }).payload;
          const receiptNodeIndex = result.execution.nodes.findIndex((node) =>
            node.nodeId === payload?.nodeId);
          const receiptNode = result.execution.nodes[receiptNodeIndex];
          const currentNode = execution.nodes[receiptNodeIndex];
          const operationId = payload?.reconciliationOperationId;
          if (row === undefined || !["pending", "leased", "completed"].includes(row.status) ||
              typeof operationId !== "string" || receiptNodeIndex < 0 ||
              receiptNode === undefined || currentNode === undefined ||
              receiptNode.claimId !== payload?.claimId ||
              receiptNode.claimEpoch !== payload?.claimEpoch ||
              !["unknown", "canceled"].includes(receiptNode.status) ||
              !["unknown", "canceled"].includes(currentNode.status) ||
              stableJson(payload?.binding) !== stableJson(input.binding) ||
              workItemId !== workflowAuthorityId("reconcile", {
                tenantId: input.tenantId, runId: input.runId, binding: input.binding,
                operationId, nodeId: receiptNode.nodeId, claimId: receiptNode.claimId,
                claimEpoch: receiptNode.claimEpoch,
              }, this.#digester)) throw new Error("cancel reconcile work mismatch");
        }
      } else if (result.reconciliationWorkItemIds.length !== 0) {
        throw new Error("cancel reconcile proof mismatch");
      }
      const currentWork = this.#database.prepare(
        "SELECT status FROM work_items WHERE work_item_id=?").get(input.lease.workItemId) as
        { status: string } | undefined;
      if (currentWork?.status !== "completed") throw new Error("cancel work mismatch");
      const wakeups = this.#database.prepare(`SELECT status,work_item_json FROM work_items
        WHERE tenant_id=? AND run_id=?
        AND json_extract(work_item_json,'$.payload.trigger')='workflowCancel' LIMIT 2`)
        .all(input.tenantId, input.runId) as { status: string; work_item_json: string }[];
      if (wakeups.length !== 1 ||
          !["pending", "leased", "completed"].includes(wakeups[0]!.status))
        throw new Error("cancel wake mismatch");
      for (const nodeId of result.canceledGateRequestNodeIds) {
        const gate = this.#database.prepare(`SELECT status FROM workflow_gate_requests
          WHERE tenant_id=? AND run_id=? AND node_id=?`).get(
            input.tenantId, input.runId, nodeId) as { status: string } | undefined;
        if (gate?.status !== "canceled") throw new Error("cancel gate mismatch");
      }
    } catch (error) {
      throw new RunStoreError("workflow_cancellation_replay_corrupt", {
        cause: error instanceof Error ? error : undefined });
    }
  }

  #isCancellationReplayExecutionCompatible(
    receipt: import("@crewon/application").WorkflowExecutionState,
    current: import("@crewon/application").WorkflowExecutionState,
  ): boolean {
    if (current.revision < receipt.revision || receipt.nodes.length !== current.nodes.length ||
        receipt.workflowId !== current.workflowId ||
        receipt.workflowVersionId !== current.workflowVersionId ||
        receipt.contentDigest !== current.contentDigest) return false;
    let reachedUnsettledUnknown = false;
    return receipt.nodes.every((node, index) => {
      const candidate = current.nodes[index];
      if (candidate === undefined || candidate.nodeId !== node.nodeId ||
          candidate.claimId !== node.claimId || candidate.claimEpoch !== node.claimEpoch)
        return false;
      if (node.status === "canceled") return candidate.status === "canceled";
      if (node.status === "unknown") {
        if (candidate.status === "unknown") {
          reachedUnsettledUnknown = true;
          return true;
        }
        return candidate.status === "canceled" && !reachedUnsettledUnknown;
      }
      return candidate.status === node.status || candidate.status === "canceled";
    });
  }

  async #validateCanceledReconciliationReplay(
    input: Parameters<WorkflowRunCompositionStore["reconcileWorkflowNode"]>[0],
    replay: unknown,
  ): Promise<void> {
    try {
      const result = replay as { disposition?: unknown; evidenceStatus?: unknown;
        handoff?: unknown; runDisposition?: unknown; cancellationWinner?: unknown };
      if (result.disposition !== "settled" ||
          !["notDispatched", "possiblySent", "responseObserved"].includes(
            String(result.evidenceStatus),
          ) ||
          result.cancellationWinner !== true ||
          stableJson(Object.keys(result).sort()) !== stableJson([
            "cancellationWinner", "disposition", "evidenceStatus", "execution", "handoff",
            "runDisposition" ]))
        throw new Error("cancel reconcile result mismatch");
      const execution = this.#loadExecution(input.tenantId, input.runId);
      const node = execution?.nodes.find((candidate) => candidate.nodeId === input.nodeId);
      const step = loadSqliteRunStep(this.#database, { tenantId: input.tenantId,
        runId: input.runId, stepId: input.nodeId });
      const attempt = step?.currentAttemptId === null || step === null ? null
        : loadSqliteRunAttempt(this.#database, { tenantId: input.tenantId, runId: input.runId,
            stepId: input.nodeId, attemptId: step.currentAttemptId });
      if (node?.status !== "canceled" || node.claimId !== input.claimId ||
          node.claimEpoch !== input.claimEpoch || node.agentVersionId === null ||
          step?.status !== "canceled" || attempt?.status !== "canceled")
        throw new Error("cancel reconcile authority mismatch");
      const dispatchRows = this.#database.prepare(`SELECT operation_id FROM model_dispatch_receipts
        WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?
        ORDER BY request_sequence`).all(
          input.tenantId, input.runId, input.nodeId, attempt.attemptId) as
            { operation_id: string }[];
      const dispatches = dispatchRows.map((row) => loadSqliteModelDispatchReceipt(
        this.#database, { tenantId: input.tenantId, runId: input.runId,
          stepId: input.nodeId, attemptId: attempt.attemptId,
          operationId: row.operation_id }));
      if (dispatches.some((dispatch) => dispatch?.status !== "terminal" ||
          dispatch.workItemId !== attempt.workItemId ||
          dispatch.leaseEpoch !== attempt.leaseEpoch) ||
          (result.evidenceStatus === "responseObserved" &&
            !dispatches.some((dispatch) => dispatch?.terminalOutcome?.certainty ===
              "responseObserved")) ||
          (result.evidenceStatus === "possiblySent" &&
            !dispatches.some((dispatch) => dispatch?.terminalOutcome?.certainty ===
              "abandonedPossiblySent")))
        throw new Error("cancel reconcile dispatch mismatch");
      if (result.evidenceStatus === "responseObserved") {
        const responseDispatch = dispatches.at(-1)!;
        const authority = {
        tenantId: input.tenantId, runId: input.runId, workItemId: attempt.workItemId,
        leaseEpoch: attempt.leaseEpoch, nodeId: input.nodeId,
        nodeKind: node.kind === "verification" ? "verification" as const : "agent" as const,
        claimId: input.claimId, claimEpoch: input.claimEpoch,
        agentVersionId: node.agentVersionId, attempt: { stepId: input.nodeId,
          attemptId: attempt.attemptId } };
        const continuationRow = this.#database.prepare(`SELECT checkpoint_json FROM
          workflow_node_continuations WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`
        ).get(input.tenantId, input.runId, input.nodeId, attempt.attemptId) as
          { checkpoint_json: string } | undefined;
        const checkpoint = continuationRow === undefined ? null
          : validateWorkflowNodeContinuationCheckpoint(JSON.parse(continuationRow.checkpoint_json));
        const terminalCandidate = checkpoint?.terminalCandidate ?? null;
        const workflow = this.#loadWorkflow(input);
        if (checkpoint === null || stableJson(checkpoint.authority) !== stableJson(authority) ||
            terminalCandidate === null ||
            stableJson(terminalCandidate.dispatchTerminalOutcome) !==
              stableJson(responseDispatch.terminalOutcome))
          throw new Error("cancel reconcile candidate mismatch");
        const evidence = validateWorkflowNodeTerminalEvidence({ workflow, nodeId: input.nodeId,
          evidence: terminalCandidate.evidence, digester: this.#digester });
        validateWorkflowDispatchTerminalCorrelation({
          dispatch: terminalCandidate.dispatchTerminalOutcome, evidence });
        if (terminalCandidate.candidateId !== this.#digester.sha256(canonicalJson({ authority,
          segmentId: checkpoint.segmentId, evidence,
          dispatchTerminalOutcome: terminalCandidate.dispatchTerminalOutcome })))
          throw new Error("cancel reconcile candidate digest mismatch");
      }
      const work = this.#database.prepare(
        "SELECT status FROM work_items WHERE work_item_id=?").get(input.lease.workItemId) as
          { status: string } | undefined;
      if (work?.status !== "completed") throw new Error("cancel reconcile work mismatch");
    } catch (error) {
      throw new RunStoreError("workflow_reconciliation_replay_corrupt", {
        cause: error instanceof Error ? error : undefined });
    }
  }

  #validateOperatorRequiredReconciliationReplay(
    input: Parameters<WorkflowRunCompositionStore["reconcileWorkflowNode"]>[0],
    replay: unknown,
  ): void {
    try {
      const result = replay as Record<string, unknown>;
      if (stableJson(Object.keys(result).sort()) !== stableJson([
        "disposition", "evidenceStatus", "execution", "handoff", "runDisposition",
      ]) || result.disposition !== "operatorRequired" ||
          result.evidenceStatus !== "possiblySent") throw new Error("receipt mismatch");
      const receiptExecution = result.execution as
        import("@crewon/application").WorkflowExecutionState;
      validateWorkflowExecutionState(receiptExecution);
      const receiptNode = receiptExecution.nodes.find((node) => node.nodeId === input.nodeId);
      const execution = this.#loadExecution(input.tenantId, input.runId);
      const node = execution?.nodes.find((candidate) => candidate.nodeId === input.nodeId);
      const step = loadSqliteRunStep(this.#database, { tenantId: input.tenantId,
        runId: input.runId, stepId: input.nodeId });
      const attempt = step?.currentAttemptId === null || step === null ? null
        : loadSqliteRunAttempt(this.#database, { tenantId: input.tenantId,
            runId: input.runId, stepId: input.nodeId, attemptId: step.currentAttemptId });
      const handoff = result.handoff as Record<string, unknown>;
      const work = this.#database.prepare(`SELECT status,lease_owner_id,lease_id,lease_epoch,
        lease_expires_at_ms,work_item_json FROM work_items WHERE work_item_id=?`)
        .get(input.lease.workItemId) as { status: string; lease_owner_id: string | null;
          lease_id: string | null; lease_epoch: number; lease_expires_at_ms: number | null;
          work_item_json: string } | undefined;
      const workPayload = work === undefined ? null
        : (JSON.parse(work.work_item_json) as { payload?: unknown }).payload;
      if (receiptNode?.status !== "failed" ||
          receiptNode.failureCode !== WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED ||
          receiptExecution.schemaVersion !== "crewon.workflow-execution.v0" ||
          receiptExecution.tenantId !== input.tenantId || receiptExecution.runId !== input.runId ||
          receiptExecution.workflowId !== input.binding.workflowId ||
          receiptExecution.workflowVersionId !== input.binding.workflowVersionId ||
          receiptExecution.contentDigest !== input.binding.contentDigest ||
          receiptNode.claimId !== input.claimId || receiptNode.claimEpoch !== input.claimEpoch ||
          node?.status !== "failed" || node.failureCode !== WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED ||
          node.claimId !== input.claimId || node.claimEpoch !== input.claimEpoch ||
          step?.status !== "failed" || step.currentAttemptId !== attempt?.attemptId ||
          attempt?.status !== "failed" ||
          attempt.failure?.code !== WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED ||
          attempt.failure.retryable !== false || handoff.currentWorkItem !== "completed" ||
          work?.status !== "completed" || work.lease_owner_id !== null || work.lease_id !== null ||
          work.lease_expires_at_ms !== null || work.lease_epoch !== input.lease.leaseEpoch ||
          stableJson(workPayload) !== stableJson({
            schemaVersion: "crewon.workflow-reconcile-work-item.v0",
            trigger: "workflowReconcile", binding: input.binding, nodeId: input.nodeId,
            claimId: input.claimId, claimEpoch: input.claimEpoch,
            reconciliationOperationId: input.reconciliationOperationId }))
        throw new Error("terminal authority mismatch");
      const dispatchRows = this.#database.prepare(`SELECT operation_id FROM model_dispatch_receipts
        WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?
        ORDER BY request_sequence,revision`).all(
          input.tenantId, input.runId, input.nodeId, attempt.attemptId) as
            { operation_id: string }[];
      const dispatches = dispatchRows.map((row) =>
        loadSqliteModelDispatchReceipt(this.#database, { tenantId: input.tenantId,
            runId: input.runId, stepId: input.nodeId, attemptId: attempt.attemptId,
            operationId: row.operation_id }));
      const operatorDispatches = dispatches.filter((dispatch) =>
        dispatch?.status === "terminal" &&
        stableJson(dispatch.terminalOutcome) === stableJson({ kind: "failed",
          code: WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED,
          certainty: "operatorRequired" }));
      const highestDispatch = dispatches.at(-1);
      if (dispatches.length === 0 || dispatches.some((dispatch) => dispatch === null ||
          dispatch.status !== "terminal" || dispatch.workItemId !== attempt.workItemId ||
          dispatch.leaseEpoch !== attempt.leaseEpoch) || operatorDispatches.length !== 1 ||
          highestDispatch !== operatorDispatches[0]) throw new Error("dispatch mismatch");
      const terminalReplayInput = { tenantId: input.tenantId, runId: input.runId,
        lease: input.lease, binding: input.binding, nodeId: input.nodeId,
        claimId: input.claimId, claimEpoch: input.claimEpoch, stepId: input.nodeId,
        attemptId: attempt.attemptId,
        operationId: `reconcile-operator:${input.reconciliationOperationId}`,
        outcome: { status: "failed" as const,
          failureCode: WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED } };
      this.#validateNodeTerminalReplay(terminalReplayInput);
      if (result.runDisposition === "terminalConverged") {
        if (receiptExecution.status !== "failed" || execution?.status !== "failed")
          throw new Error("terminal run mismatch");
        this.#validateTerminalReplay(terminalReplayInput, replay);
      } else if (result.runDisposition === "nonTerminal") {
        const next = handoff.nextWorkItemId;
        if (receiptExecution.status !== "running" ||
            (handoff.kind !== "none" && handoff.kind !== "scheduler") ||
            (handoff.kind === "none" ? next !== null : typeof next !== "string"))
          throw new Error("nonterminal handoff mismatch");
        if (handoff.kind === "scheduler") {
          if (typeof next !== "string") throw new Error("scheduler handoff mismatch");
          const nextWork = this.#database.prepare(`SELECT tenant_id,run_id,work_item_json
            FROM work_items WHERE work_item_id=?`).get(next) as
              { tenant_id: string; run_id: string; work_item_json: string } | undefined;
          const nextPayload = nextWork === undefined ? null
            : (JSON.parse(nextWork.work_item_json) as { payload?: Record<string, unknown> }).payload;
          if (nextWork?.tenant_id !== input.tenantId || nextWork.run_id !== input.runId ||
              nextPayload?.trigger !== "workflowScheduler" ||
              stableJson(nextPayload.binding) !== stableJson(input.binding))
            throw new Error("scheduler handoff mismatch");
        }
      } else throw new Error("run disposition mismatch");
    } catch (error) {
      throw new RunStoreError("workflow_reconciliation_replay_corrupt", {
        cause: error instanceof Error ? error : undefined });
    }
  }

  #loadRun(tenantId: string, runId: string): RunState | null {
    const row = this.#database
      .prepare(
        "SELECT state_json FROM run_snapshots WHERE tenant_id=? AND run_id=?",
      )
      .get(tenantId, runId) as { state_json: string } | undefined;
    return row === undefined
      ? null
      : normalizeStoredRunState(
          JSON.parse(row.state_json) as RunState,
          "stored_run_invalid",
        );
  }

  #loadWorkflow(input: {
    tenantId: string;
    binding: import("@crewon/domain").FrozenWorkflowVersionBinding;
  }) {
    const row = this.#database
      .prepare(
        "SELECT definition_json FROM workflow_versions WHERE tenant_id=? AND workflow_version_id=?",
      )
      .get(input.tenantId, input.binding.workflowVersionId) as
      | { definition_json: string }
      | undefined;
    if (row === undefined)
      throw new RunStoreError("workflow_composition_version_not_found");
    return parseBoundWorkflow(
      row.definition_json,
      input.binding,
      this.#digester,
    );
  }

  #fingerprint(kind: string, input: unknown): string {
    return this.#digester.sha256(stableJson({ kind, input }));
  }

  #receipt(
    input: {
      tenantId: string;
      runId: string;
      operationId?: string;
      schedulerOperationId?: string;
    },
    kind: string,
    fingerprint: string,
  ): unknown | null {
    const operationId = input.operationId ?? input.schedulerOperationId!;
    const row = this.#database
      .prepare(
        `SELECT kind,fingerprint,result_json FROM workflow_composition_receipts
       WHERE tenant_id=? AND run_id=? AND operation_id=?`,
      )
      .get(input.tenantId, input.runId, operationId) as
      | { kind: string; fingerprint: string; result_json: string }
      | undefined;
    if (row === undefined) return null;
    if (row.kind !== kind || row.fingerprint !== fingerprint)
      throw new RunStoreError("workflow_composition_idempotency_conflict");
    return JSON.parse(row.result_json);
  }

  #insertReceipt(
    input: {
      tenantId: string;
      runId: string;
      operationId?: string;
      schedulerOperationId?: string;
    },
    kind: string,
    fingerprint: string,
    result: unknown,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO workflow_composition_receipts
       (tenant_id,run_id,operation_id,kind,fingerprint,result_json) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        input.tenantId,
        input.runId,
        input.operationId ?? input.schedulerOperationId!,
        kind,
        fingerprint,
        stableJson(result),
      );
  }

  #writeExecution(
    execution: import("@crewon/application").WorkflowExecutionState,
    now: string,
  ): void {
    validateWorkflowExecutionState(execution);
    const result = this.#database
      .prepare(
        `UPDATE workflow_executions SET revision=?,state_json=?,updated_at=? WHERE tenant_id=? AND run_id=?`,
      )
      .run(
        execution.revision,
        stableJson(execution),
        now,
        execution.tenantId,
        execution.runId,
      );
    if (result.changes !== 1)
      throw new RunStoreError("workflow_execution_not_found");
  }

  #insertWorkflowWorkItem(
    workItemId: string,
    input: { tenantId: string; runId: string },
    payload: Record<string, unknown>,
    now: string,
    nowMs: number,
  ): void {
    const item = {
      workItemId,
      tenantId: input.tenantId,
      runId: input.runId,
      kind: "run.execute",
      payload,
      createdAt: now,
    };
    this.#database
      .prepare(
        `INSERT INTO work_items(work_item_id,tenant_id,run_id,kind,work_item_json,created_at,status,available_at_ms,lease_epoch,attempt_count)
       VALUES (?,?,?,?,?,?,'pending',?,0,0)`,
      )
      .run(
        workItemId,
        input.tenantId,
        input.runId,
        "run.execute",
        stableJson(item),
        now,
        nowMs,
      );
  }

  #completeLease(
    input: { lease: import("@crewon/application").WorkItemLeaseInput },
    nowMs: number,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE work_items SET status='completed',lease_owner_id=NULL,lease_id=NULL,lease_expires_at_ms=NULL,completed_at_ms=?
       WHERE work_item_id=? AND status='leased' AND lease_owner_id=? AND lease_id=? AND lease_epoch=? AND lease_expires_at_ms>?`,
      )
      .run(
        nowMs,
        input.lease.workItemId,
        input.lease.ownerId,
        input.lease.leaseId,
        input.lease.leaseEpoch,
        nowMs,
      );
    if (result.changes !== 1) throw new RunStoreError("stale_lease");
  }

  #assertNodeWorkPayload(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>[0],
  ): void {
    const row = this.#database
      .prepare("SELECT work_item_json FROM work_items WHERE work_item_id=?")
      .get(input.lease.workItemId) as { work_item_json: string } | undefined;
    if (row === undefined) throw new RunStoreError("queue_item_not_found");
    const item = JSON.parse(row.work_item_json) as { payload?: unknown };
    const expected = {
      schemaVersion: "crewon.workflow-node-work-item.v0",
      trigger: "workflowNode",
      binding: input.binding,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      schedulerOperationId: input.schedulerOperationId,
    };
    if (stableJson(item.payload) !== stableJson(expected))
      throw new RunStoreError("workflow_composition_work_item_mismatch");
  }

  #assertSchedulerWorkPayload(
    input: Parameters<WorkflowRunCompositionStore["scheduleWorkflowNodes"]>[0],
  ): void {
    const payload = this.#loadWorkItemPayload(input.lease.workItemId);
    const expected = { schemaVersion: "crewon.workflow-scheduler-work-item.v1",
      trigger: "workflowScheduler", binding: input.binding,
      schedulerOperationId: input.schedulerOperationId,
      workflowInput: input.workflowInput };
    const root = this.#rootInputRef(input);
    if (stableJson(payload) !== stableJson(expected) ||
        stableJson(root) !== stableJson(input.workflowInput))
      throw new RunStoreError("workflow_composition_work_item_mismatch");
  }

  #loadWorkItemPayload(workItemId: string): unknown {
    const row = this.#database.prepare(
      "SELECT work_item_json FROM work_items WHERE work_item_id=?",
    ).get(workItemId) as { work_item_json: string } | undefined;
    if (row === undefined) throw new RunStoreError("queue_item_not_found");
    const item = JSON.parse(row.work_item_json) as { payload?: unknown };
    if (item.payload === undefined) throw new RunStoreError("workflow_composition_work_item_mismatch");
    return item.payload;
  }

  #loadGate(input: {
    tenantId: string;
    runId: string;
    nodeId: string;
    gateRequestId: string;
  }): Record<string, unknown> {
    const row = this.#database
      .prepare(
        `SELECT state_json FROM workflow_gate_requests
       WHERE tenant_id=? AND run_id=? AND node_id=? AND gate_request_id=?`,
      )
      .get(input.tenantId, input.runId, input.nodeId, input.gateRequestId) as
      | { state_json: string }
      | undefined;
    if (row === undefined) throw new RunStoreError("workflow_gate_not_found");
    return JSON.parse(row.state_json) as Record<string, unknown>;
  }

  #assertGateResumePayload(
    input: Parameters<
      WorkflowRunCompositionStore["settleWorkflowHumanGate"]
    >[0],
    gate: Record<string, unknown>,
  ): void {
    const row = this.#database
      .prepare("SELECT work_item_json FROM work_items WHERE work_item_id=?")
      .get(input.lease.workItemId) as { work_item_json: string } | undefined;
    const item =
      row === undefined
        ? null
        : (JSON.parse(row.work_item_json) as { payload?: unknown });
    const expected = {
      schemaVersion: "crewon.workflow-gate-resume-work-item.v0",
      trigger: "workflowGateResume",
      binding: input.binding,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      gateRequestId: input.gateRequestId,
      decisionReceiptId: input.decisionReceiptId,
    };
    if (
      input.lease.workItemId !== gate.approvalResumeWorkItemId ||
      stableJson(item?.payload) !== stableJson(expected)
    )
      throw new RunStoreError("workflow_composition_work_item_mismatch");
  }

  #loadExecution(tenantId: string, runId: string) {
    const row = this.#database
      .prepare(
        "SELECT state_json FROM workflow_executions WHERE tenant_id=? AND run_id=?",
      )
      .get(tenantId, runId) as { state_json: string } | undefined;
    return row === undefined
      ? null
      : decodeWorkflowExecutionState(row.state_json);
  }

  #composeNodeInputValue(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>[0],
    workflow: import("@crewon/domain").CompiledWorkflowVersion,
    now?: string,
  ): import("@crewon/application").WorkflowExecutionValue {
    const root = this.#loadExecutionValue(input.tenantId, input.runId, "rootInput", null);
    const node = workflow.nodes.find((candidate) => candidate.nodeId === input.nodeId);
    if (root === null || node === undefined)
      throw new RunStoreError("workflow_execution_value_not_found");
    const dependencyOutputs = node.dependsOn.map((nodeId) => {
      const output = this.#loadExecutionValue(input.tenantId, input.runId, "nodeOutput", nodeId);
      if (output === null) throw new RunStoreError("workflow_execution_value_not_found");
      return { nodeId, value: output.value };
    });
    const value = validateWorkflowSchemaValue(
      composeWorkflowNodeInput({ workflow, nodeId: input.nodeId,
        rootInput: root.value, dependencyOutputs }),
      workflowNodeInputSchema(workflow, input.nodeId),
    );
    const valueJson = canonicalJson(value);
    const valueDigest = this.#digester.sha256(valueJson);
    if (valueDigest !== executionNode(input, this.#loadExecution(input.tenantId, input.runId)).inputDigest)
      throw new RunStoreError("workflow_execution_value_digest_mismatch");
    const existing = this.#loadExecutionValue(
      input.tenantId, input.runId, "nodeInput", input.nodeId);
    if (existing !== null) {
      if (existing.valueDigest !== valueDigest ||
          canonicalJson(existing.value) !== valueJson)
        throw new RunStoreError("workflow_execution_value_conflict");
      return { schemaVersion: "crewon.workflow-execution-value.v0",
        valueId: existing.valueId, valueDigest: existing.valueDigest,
        value: structuredClone(existing.value) as WorkflowExecutionValue["value"] };
    }
    const authority = { schemaVersion: "crewon.workflow-execution-value.v0" as const,
      valueId: workflowAuthorityId("value", { tenantId: input.tenantId,
        runId: input.runId, nodeId: input.nodeId, claimId: input.claimId,
        claimEpoch: input.claimEpoch, valueDigest }, this.#digester),
      value: structuredClone(value) as WorkflowExecutionValue["value"], valueDigest };
    if (now !== undefined) this.#insertExecutionValue({ ...input,
      valueId: authority.valueId, role: "nodeInput", nodeId: input.nodeId,
      valueDigest, valueJson, now });
    return authority;
  }

  #nodeInputDigest(
    input: { tenantId: string; runId: string },
    workflow: import("@crewon/domain").CompiledWorkflowVersion,
    nodeId: string,
  ): string {
    const root = this.#loadExecutionValue(input.tenantId, input.runId, "rootInput", null);
    const node = workflow.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (root === null || node === undefined)
      throw new RunStoreError("workflow_execution_value_not_found");
    const dependencyOutputs = node.dependsOn.map((dependencyNodeId) => {
      const output = this.#loadExecutionValue(input.tenantId, input.runId,
        "nodeOutput", dependencyNodeId);
      if (output === null) throw new RunStoreError("workflow_execution_value_not_found");
      return { nodeId: dependencyNodeId, value: output.value };
    });
    return this.#digester.sha256(canonicalJson(composeWorkflowNodeInput({
      workflow, nodeId, rootInput: root.value, dependencyOutputs,
    })));
  }

  #loadExecutionValue(tenantId: string, runId: string, role: string, nodeId: string | null) {
    const row = this.#database.prepare(
      `SELECT value_id,value_digest,value_json FROM workflow_execution_values
       WHERE tenant_id=? AND run_id=? AND role=? AND node_id IS ?`,
    ).get(tenantId, runId, role, nodeId) as
      | { value_id: string; value_digest: string; value_json: string }
      | undefined;
    if (row === undefined) return null;
    const value = JSON.parse(row.value_json) as WorkflowSchemaValue;
    const valueJson = canonicalJson(value);
    if (new TextEncoder().encode(valueJson).byteLength > MAX_WORKFLOW_VALUE_BYTES ||
        valueJson !== row.value_json || this.#digester.sha256(valueJson) !== row.value_digest)
      throw new RunStoreError("workflow_execution_value_corrupt");
    return { valueId: row.value_id, valueDigest: row.value_digest, value };
  }

  #insertExecutionValue(input: { tenantId: string; runId: string; valueId: string;
    role: string; nodeId: string | null; valueDigest: string; valueJson: string; now: string }): void {
    const canonical = canonicalJson(JSON.parse(input.valueJson));
    if (canonical !== input.valueJson ||
        new TextEncoder().encode(canonical).byteLength > MAX_WORKFLOW_VALUE_BYTES ||
        this.#digester.sha256(canonical) !== input.valueDigest)
      throw new RunStoreError("workflow_execution_value_invalid");
    const existing = this.#database.prepare(
      `SELECT role,node_id,value_digest,value_json FROM workflow_execution_values
       WHERE tenant_id=? AND run_id=? AND value_id=?`,
    ).get(input.tenantId, input.runId, input.valueId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (existing.role !== input.role || existing.node_id !== input.nodeId ||
          existing.value_digest !== input.valueDigest || existing.value_json !== input.valueJson)
        throw new RunStoreError("workflow_execution_value_conflict");
      return;
    }
    this.#database.prepare(
      `INSERT INTO workflow_execution_values
       (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(input.tenantId, input.runId, input.valueId, input.role, input.nodeId,
      input.valueDigest, input.valueJson, input.now);
  }

  #rootInputRef(input: { tenantId: string; runId: string }) {
    const root = this.#loadExecutionValue(input.tenantId, input.runId, "rootInput", null);
    if (root === null) throw new RunStoreError("workflow_execution_value_not_found");
    return { valueId: root.valueId, valueDigest: root.valueDigest };
  }

  #convergeTerminalRun(
    input: { tenantId: string; runId: string; operationId: string },
    workflow: import("@crewon/domain").CompiledWorkflowVersion,
    execution: import("@crewon/application").WorkflowExecutionState,
    now: string,
    nowMs: number,
  ): import("@crewon/application").WorkflowRunDisposition {
    if (!["completed", "failed", "canceled"].includes(execution.status))
      return "nonTerminal";
    const current = this.#loadRun(input.tenantId, input.runId);
    if (current === null || current.goalBinding !== null)
      throw new RunStoreError("workflow_composition_run_authority_mismatch");
    let outputRef: string | null = null;
    if (execution.status === "completed") {
      const outputValues = workflow.outputNodeIds.map((nodeId) => {
        const authority = this.#loadExecutionValue(input.tenantId, input.runId,
          "nodeOutput", nodeId);
        if (authority === null) throw new RunStoreError("workflow_execution_value_not_found");
        return { nodeId, value: authority.value };
      });
      const value = validateWorkflowSchemaValue(
        composeWorkflowOutput({ workflow, outputValues }), workflow.outputSchema);
      const valueJson = canonicalJson(value);
      const valueDigest = this.#digester.sha256(valueJson);
      outputRef = workflowAuthorityId("value", { tenantId: input.tenantId,
        runId: input.runId, role: "workflowOutput", valueDigest }, this.#digester);
      this.#insertExecutionValue({ ...input, valueId: outputRef,
        role: "workflowOutput", nodeId: null, valueDigest, valueJson, now });
    }
    const eventId = workflowAuthorityId("run-event", input, this.#digester);
    const event = {
      schemaVersion: "crewon.run-event.v0" as const,
      identity: { runId: input.runId }, eventId,
      sequence: current.lastSequence + 1, occurredAt: now,
      ...(execution.status === "completed"
        ? { type: "run.completed" as const, data: { outputRef } }
        : execution.status === "failed"
          ? { type: "run.failed" as const,
              data: { code: execution.nodes.some((node) =>
                node.failureCode === WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED)
                  ? WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED
                  : "workflow_node_failed", retryable: false } }
          : { type: "run.canceled" as const,
              data: { reasonCode: "workflow_canceled" } }),
    };
    const next = reduceRunLifecycleEvent(current, event);
    const updated = this.#database.prepare(
      `UPDATE run_snapshots SET revision=?,last_sequence=?,state_json=?,updated_at=?
       WHERE tenant_id=? AND run_id=? AND revision=?`,
    ).run(next.revision, next.lastSequence, stableJson(next), now,
      input.tenantId, input.runId, current.revision);
    if (updated.changes !== 1) throw new RunStoreError("revision_conflict");
    this.#database.prepare(
      `INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json)
       VALUES (?,?,?,?,?)`,
    ).run(input.tenantId, input.runId, event.sequence, eventId, stableJson(event));
    const messageId = workflowAuthorityId("run-outbox", input, this.#digester);
    const message = { messageId, tenantId: input.tenantId, runId: input.runId,
      topic: "run.updated", payload: { eventId, eventType: event.type,
        throughSequence: event.sequence }, createdAt: now };
    this.#database.prepare(
      `INSERT INTO outbox(message_id,tenant_id,run_id,topic,message_json,created_at,
       status,available_at_ms,lease_epoch,attempt_count)
       VALUES (?,?,?,?,?,?,'pending',?,0,0)`,
    ).run(messageId, input.tenantId, input.runId, message.topic,
      stableJson(message), now, nowMs);
    return "terminalConverged";
  }

  #appendNodeTerminalEvent(
    input: Readonly<{ tenantId: string; runId: string;
      binding: import("@crewon/domain").FrozenWorkflowVersionBinding;
      nodeId: string; claimId: string | null; claimEpoch: number | null;
      stepId: string; attemptId: string | null; operationId: string;
      outcome: { status: "completed"; value?: unknown } |
        { status: "failed"; failureCode: string } | { status: "canceled" } }>,
    resultDigest: string | null,
    now: string,
    nowMs: number,
  ): void {
    const current = this.#loadRun(input.tenantId, input.runId);
    assertCanonicalRun(current, input.binding);
    const eventId = workflowAuthorityId("run-event", {
      ...input, lifecycle: "workflow.node.terminal",
    }, this.#digester);
    const event = {
      schemaVersion: "crewon.run-event.v0" as const,
      identity: { runId: input.runId }, eventId,
      sequence: current!.lastSequence + 1, occurredAt: now,
      type: "workflow.node.terminal" as const,
      data: { binding: input.binding, nodeId: input.nodeId,
        claimId: input.claimId, claimEpoch: input.claimEpoch,
        stepId: input.stepId, attemptId: input.attemptId,
        status: input.outcome.status,
        resultDigest,
        failureCode: input.outcome.status === "failed"
          ? input.outcome.failureCode : null },
    };
    const next = reduceRunLifecycleEvent(current, event);
    const updated = this.#database.prepare(
      `UPDATE run_snapshots SET revision=?,last_sequence=?,state_json=?,updated_at=?
       WHERE tenant_id=? AND run_id=? AND revision=?`,
    ).run(next.revision, next.lastSequence, stableJson(next), now,
      input.tenantId, input.runId, current!.revision);
    if (updated.changes !== 1) throw new RunStoreError("revision_conflict");
    this.#database.prepare(
      `INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json)
       VALUES (?,?,?,?,?)`,
    ).run(input.tenantId, input.runId, event.sequence, eventId, stableJson(event));
    const messageId = workflowAuthorityId("run-outbox", {
      ...input, lifecycle: "workflow.node.terminal",
    }, this.#digester);
    const message = { messageId, tenantId: input.tenantId, runId: input.runId,
      topic: "run.updated", payload: { eventId, eventType: event.type,
        throughSequence: event.sequence }, createdAt: now };
    this.#database.prepare(
      `INSERT INTO outbox(message_id,tenant_id,run_id,topic,message_json,created_at,
       status,available_at_ms,lease_epoch,attempt_count)
       VALUES (?,?,?,?,?,?,'pending',?,0,0)`,
    ).run(messageId, input.tenantId, input.runId, message.topic,
      stableJson(message), now, nowMs);
  }

  #validateNodeTerminalReplay(
    input: Parameters<WorkflowRunCompositionStore["settleWorkflowNode"]>[0],
  ): void {
    if (input.outcome.status === "unknown") return;
    const eventId = workflowAuthorityId("run-event", {
      ...input, lifecycle: "workflow.node.terminal",
    }, this.#digester);
    const messageId = workflowAuthorityId("run-outbox", {
      ...input, lifecycle: "workflow.node.terminal",
    }, this.#digester);
    const events = this.#database.prepare(
      "SELECT event_json FROM run_events WHERE tenant_id=? AND run_id=? AND event_id=?",
    ).all(input.tenantId, input.runId, eventId) as { event_json: string }[];
    const outbox = this.#database.prepare(
      "SELECT message_json FROM outbox WHERE message_id=?",
    ).all(messageId) as { message_json: string }[];
    if (events.length !== 1 || outbox.length !== 1)
      throw new RunStoreError("workflow_node_terminal_lifecycle_corrupt");
    try {
      const event = JSON.parse(events[0]!.event_json) as
        import("@crewon/domain").RunLifecycleEvent;
      const message = JSON.parse(outbox[0]!.message_json) as Record<string, unknown>;
      const run = this.#loadRun(input.tenantId, input.runId);
      const execution = this.#loadExecution(input.tenantId, input.runId);
      const node = execution?.nodes.find((value) => value.nodeId === input.nodeId);
      const attempt = loadSqliteRunAttempt(this.#database, input);
      const step = loadSqliteRunStep(this.#database, input);
      const eventRows = this.#database.prepare(
        `SELECT event_json FROM run_events WHERE tenant_id=? AND run_id=? ORDER BY sequence`,
      ).all(input.tenantId, input.runId) as { event_json: string }[];
      const history = eventRows.map((row) => JSON.parse(row.event_json)) as
        import("@crewon/domain").RunLifecycleEvent[];
      const expectedData = { binding: input.binding, nodeId: input.nodeId,
        claimId: input.claimId, claimEpoch: input.claimEpoch,
        stepId: input.stepId, attemptId: input.attemptId,
        status: input.outcome.status,
        resultDigest: input.outcome.status === "completed" ? node?.resultDigest : null,
        failureCode: input.outcome.status === "failed" ? input.outcome.failureCode : null };
      const expectedMessage = { messageId, tenantId: input.tenantId, runId: input.runId,
        topic: "run.updated", payload: { eventId, eventType: event.type,
          throughSequence: event.sequence }, createdAt: event.occurredAt };
      if (event.schemaVersion !== "crewon.run-event.v0" ||
          event.identity.runId !== input.runId || event.eventId !== eventId ||
          event.type !== "workflow.node.terminal" ||
          event.occurredAt !== attempt?.terminalAt ||
          node === undefined || node.claimId !== input.claimId ||
          node.claimEpoch !== input.claimEpoch || node.status !== input.outcome.status ||
          attempt?.status !== input.outcome.status || attempt.stepId !== input.stepId ||
          attempt.attemptId !== input.attemptId || attempt.updatedAt !== event.occurredAt ||
          step?.status !== input.outcome.status || step.stepId !== input.stepId ||
          step.currentAttemptId !== input.attemptId || step.updatedAt !== event.occurredAt ||
          stableJson(event.data) !== stableJson(expectedData) ||
          stableJson(message) !== stableJson(expectedMessage) ||
          run === null || stableJson(replayRunLifecycle(history)) !== stableJson(run))
        throw new Error("lifecycle mismatch");
    } catch (error) {
      throw new RunStoreError("workflow_node_terminal_lifecycle_corrupt", {
        cause: error instanceof Error ? error : undefined });
    }
  }

  #validateTerminalReplay(
    input: { tenantId: string; runId: string; operationId: string },
    replay: unknown,
  ): void {
    const result = replay as { runDisposition?: unknown; execution?: unknown };
    if (result.runDisposition !== "terminalConverged") return;
    const execution = result.execution as import("@crewon/application").WorkflowExecutionState;
    validateWorkflowExecutionState(execution);
    const run = this.#loadRun(input.tenantId, input.runId);
    const eventId = workflowAuthorityId("run-event", input, this.#digester);
    const messageId = workflowAuthorityId("run-outbox", input, this.#digester);
    const eventRows = this.#database.prepare(
      `SELECT event_json FROM run_events WHERE tenant_id=? AND run_id=? ORDER BY sequence`,
    ).all(input.tenantId, input.runId) as { event_json: string }[];
    const eventRow = this.#database.prepare(
      `SELECT event_json FROM run_events WHERE tenant_id=? AND run_id=? AND event_id=?`,
    ).get(input.tenantId, input.runId, eventId) as { event_json: string } | undefined;
    const outboxRow = this.#database.prepare(
      `SELECT message_json FROM outbox WHERE tenant_id=? AND run_id=? AND message_id=?`,
    ).get(input.tenantId, input.runId, messageId) as { message_json: string } | undefined;
    if (run === null || eventRow === undefined || outboxRow === undefined ||
        run.lastSequence < 1 || run.status !== execution.status)
      throw new RunStoreError("workflow_composition_terminal_replay_corrupt");
    const events = eventRows.map((row) => JSON.parse(row.event_json)) as
      import("@crewon/domain").RunLifecycleEvent[];
    const event = JSON.parse(eventRow.event_json) as import("@crewon/domain").RunLifecycleEvent;
    const outbox = JSON.parse(outboxRow.message_json) as {
      messageId?: unknown; tenantId?: unknown; runId?: unknown; topic?: unknown;
      createdAt?: unknown; payload?: Record<string, unknown> };
    const expectedType = execution.status === "completed" ? "run.completed"
      : execution.status === "failed" ? "run.failed" : "run.canceled";
    const expectedData = execution.status === "completed"
      ? { outputRef: run.outputRef }
      : execution.status === "failed"
        ? { code: execution.nodes.some((node) =>
            node.failureCode === WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED)
              ? WORKFLOW_MODEL_DISPATCH_OPERATOR_REQUIRED
              : "workflow_node_failed", retryable: false }
        : { reasonCode: "workflow_canceled" };
    if (event.eventId !== eventId || event.sequence !== run.lastSequence ||
        event.type !== expectedType || stableJson(event.data) !== stableJson(expectedData) ||
        stableJson(replayRunLifecycle(events)) !== stableJson(run) ||
        outbox.messageId !== messageId || outbox.payload?.eventId !== eventId ||
        outbox.tenantId !== input.tenantId || outbox.runId !== input.runId ||
        outbox.topic !== "run.updated" || outbox.createdAt !== event.occurredAt ||
        outbox.payload?.eventType !== event.type ||
        outbox.payload?.throughSequence !== event.sequence ||
        Object.keys(outbox.payload ?? {}).sort().join(",") !==
          "eventId,eventType,throughSequence")
      throw new RunStoreError("workflow_composition_terminal_replay_corrupt");
    if (execution.status === "completed") {
      const output = this.#loadExecutionValue(input.tenantId, input.runId,
        "workflowOutput", null);
      if (output === null || run.outputRef !== output.valueId ||
          this.#digester.sha256(canonicalJson(output.value)) !== output.valueDigest)
        throw new RunStoreError("workflow_composition_terminal_replay_corrupt");
    }
  }
}

function executionNode(input: { nodeId: string }, execution: import("@crewon/application").WorkflowExecutionState | null) {
  const node = execution?.nodes.find((candidate) => candidate.nodeId === input.nodeId);
  if (node === undefined) throw new RunStoreError("workflow_execution_not_found");
  return node;
}

function assertGateDecisionOutcome(
  outcome: Parameters<
    WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]
  >[0]["outcome"],
): void {
  const keys = Object.keys(outcome).sort().join(",");
  if (outcome.status === "completed") {
    if (keys !== "status")
      throw new RunStoreError("workflow_gate_decision_invalid");
    return;
  }
  if (outcome.status !== "failed" || keys !== "failureCode,status" ||
      typeof outcome.failureCode !== "string" ||
      outcome.failureCode.length < 1 || outcome.failureCode.length > 256)
    throw new RunStoreError("workflow_gate_decision_invalid");
}

function assertCanonicalRun(
  run: RunState | null,
  binding: Parameters<
    WorkflowRunCompositionStore["scheduleWorkflowNodes"]
  >[0]["binding"],
): void {
  if (run === null)
    throw new RunStoreError("workflow_composition_run_not_found");
  if (
    run.purpose !== "workflow" ||
    run.status !== "running" ||
    run.workflowVersionBinding?.workflowId !== binding.workflowId ||
    run.workflowVersionBinding.workflowVersionId !==
      binding.workflowVersionId ||
    run.workflowVersionBinding.contentDigest !== binding.contentDigest
  )
    throw new RunStoreError("workflow_composition_run_authority_mismatch");
}

function normalizeCompositionError(error: unknown): Error {
  return error instanceof RunStoreError
    ? error
    : new RunStoreError("workflow_composition_store_failed", {
        cause: error instanceof Error ? error : undefined,
      });
}
