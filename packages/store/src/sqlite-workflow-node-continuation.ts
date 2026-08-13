import { DatabaseSync } from "node:sqlite";
import { parseCanonicalAgentEvent } from "@crewon/contracts";
import {
  canonicalJson,
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  type CommitWorkflowAssistantContinuationInput,
  type CommitWorkflowToolContinuationInput,
  type WorkflowAgentAttemptAuthority,
  type WorkflowNodeContinuationCheckpoint,
} from "@crewon/application";
import {
  createWorkflowNodeTerminalEvidence,
  validateWorkflowDispatchTerminalCorrelation,
  validateWorkflowNodeTerminalEvidence,
  reduceRunLifecycleEvent,
  resolveToolExecutionReceipt,
  type RunLifecycleEvent,
  type RunState,
  type ToolExecutionReceiptState,
  type WorkflowContentDigester,
} from "@crewon/domain";
import { parseBoundWorkflow } from "./workflow-run-composition-support.ts";

import { readLeaseClock, type LeaseClock } from "./lease-clock.ts";
import {
  finishSqliteRunAttempt,
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import { rollback } from "./sqlite-schema.ts";
import { stableJson } from "./store-invariants.ts";
import { loadSqliteModelDispatchReceipt } from "./sqlite-model-dispatch-evidence.ts";
import {
  loadSqliteToolExecutionReceipt,
  updateSqliteToolExecutionReceipt,
} from "./sqlite-tool-execution-receipts.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import {
  decodeWorkflowExecutionState,
  validateWorkflowExecutionState,
} from "./workflow-execution-state.ts";

export class SqliteWorkflowNodeContinuationAuthority {
  readonly #database: DatabaseSync;
  readonly #clock: LeaseClock;
  readonly #digester: WorkflowContentDigester;

  constructor(
    database: DatabaseSync,
    clock: LeaseClock,
    digester: WorkflowContentDigester,
  ) {
    this.#database = database;
    this.#clock = clock;
    this.#digester = digester;
  }

  async load(
    authority: WorkflowAgentAttemptAuthority,
  ): Promise<WorkflowNodeContinuationCheckpoint | null> {
    const row = this.#database
      .prepare(
        `SELECT checkpoint_json FROM workflow_node_continuations
         WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
      )
      .get(
        authority.tenantId,
        authority.runId,
        authority.attempt.stepId,
        authority.attempt.attemptId,
      ) as { checkpoint_json: string } | undefined;
    if (row === undefined) return null;
    try {
      this.#validateAuthority(authority);
      const checkpoint = validateWorkflowNodeContinuationCheckpoint(
        JSON.parse(row.checkpoint_json),
      );
      if (stableJson(checkpoint.authority) !== stableJson(authority))
        throw new Error("authority mismatch");
      this.#validateCheckpointCorrelation(authority, checkpoint);
      return checkpoint;
    } catch (error) {
      throw new RunStoreError("workflow_node_continuation_corrupt", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  async loadForReconciliation(authority: WorkflowAgentAttemptAuthority) {
    const row = this.#database.prepare(`SELECT checkpoint_json FROM workflow_node_continuations
      WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`).get(
        authority.tenantId, authority.runId, authority.attempt.stepId,
        authority.attempt.attemptId) as { checkpoint_json: string } | undefined;
    if (row === undefined) return null;
    try {
      const checkpoint = validateWorkflowNodeContinuationCheckpoint(JSON.parse(row.checkpoint_json));
      if (stableJson(checkpoint.authority) !== stableJson(authority))
        throw new Error("authority mismatch");
      this.#validateCheckpointCorrelation(authority, checkpoint);
      return checkpoint;
    } catch (error) {
      throw new RunStoreError("workflow_node_continuation_corrupt", {
        cause: error instanceof Error ? error : undefined });
    }
  }

  async commitAssistant(
    input: CommitWorkflowAssistantContinuationInput,
  ): Promise<WorkflowNodeContinuationCheckpoint> {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateLease(input, readLeaseClock(this.#clock));
      this.#validateAuthority(input.authority);
      const current = await this.load(input.authority);
      if ((current?.revision ?? null) !== input.expectedContinuationRevision)
        throw new RunStoreError("workflow_node_continuation_revision_conflict");
      const checkpoint = validateWorkflowNodeContinuationCheckpoint({
        ...input.next,
        terminalCandidate: this.#terminalCandidate(input),
        revision: (current?.revision ?? 0) + 1,
        updatedAt: input.committedAt,
      });
      if (stableJson(checkpoint.authority) !== stableJson(input.authority))
        throw new RunStoreError(
          "workflow_node_continuation_authority_mismatch",
        );
      this.#validateCheckpointCorrelation(input.authority, checkpoint);
      const write = this.#database
        .prepare(
          `INSERT INTO workflow_node_continuations
           (tenant_id,run_id,step_id,attempt_id,revision,checkpoint_json,updated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(tenant_id,run_id,step_id,attempt_id) DO UPDATE SET
             revision=excluded.revision,checkpoint_json=excluded.checkpoint_json,
             updated_at=excluded.updated_at WHERE revision=?`,
        )
        .run(
          input.authority.tenantId,
          input.authority.runId,
          input.authority.attempt.stepId,
          input.authority.attempt.attemptId,
          checkpoint.revision,
          stableJson(checkpoint),
          checkpoint.updatedAt,
          current?.revision ?? 0,
        );
      if (write.changes !== 1)
        throw new RunStoreError("workflow_node_continuation_revision_conflict");
      this.#database.exec("COMMIT");
      return checkpoint;
    } catch (error) {
      rollback(this.#database);
      throw error instanceof RunStoreError
        ? error
        : new RunStoreError("workflow_node_continuation_store_failed", {
            cause: error instanceof Error ? error : undefined,
          });
    }
  }

  async commitTool(input: CommitWorkflowToolContinuationInput): Promise<{
    receipt: ToolExecutionReceiptState;
    continuation: WorkflowNodeContinuationCheckpoint;
  }> {
    try {
      parseCanonicalAgentEvent(input.completedEvent);
      this.#database.exec("BEGIN IMMEDIATE");
      const currentReceipt = loadSqliteToolExecutionReceipt(
        this.#database,
        input.receipt,
      );
      if (currentReceipt === null)
        throw new RunStoreError("workflow_tool_continuation_corrupt");
      if (currentReceipt.status === "completed") {
        const replay = this.#validateToolReplay(input, currentReceipt);
        this.#database.exec("COMMIT");
        return replay;
      }
      this.#validateLease(input, readLeaseClock(this.#clock));
      this.#validateAuthority(input.authority);
      this.#validateToolCorrelation(input, currentReceipt);
      const currentContinuation = await this.load(input.authority);
      const continuation = this.#nextCheckpoint(input, currentContinuation);
      const receipt = resolveToolExecutionReceipt(currentReceipt, {
        status: "completed",
        resolvedAt: input.committedAt,
        providerReceiptId: input.providerReceiptId,
        result: toolResult(input, this.#digester),
      });
      const event = this.#toolCompletedEvent(input);
      const currentRun = this.#loadRun(input.authority);
      const nextRun = reduceRunLifecycleEvent(currentRun, event);
      const updated = this.#database
        .prepare(
          `UPDATE run_snapshots SET revision=?,last_sequence=?,state_json=?,updated_at=?
           WHERE tenant_id=? AND run_id=? AND revision=?`,
        )
        .run(
          nextRun.revision,
          nextRun.lastSequence,
          stableJson(nextRun),
          input.committedAt,
          input.authority.tenantId,
          input.authority.runId,
          currentRun.revision,
        );
      if (updated.changes !== 1) throw new RunStoreError("revision_conflict");
      updateSqliteToolExecutionReceipt(this.#database, currentReceipt, receipt);
      finishSqliteRunAttempt(this.#database, {
        tenantId: input.authority.tenantId,
        runId: input.authority.runId,
        workItemId: input.authority.workItemId,
        leaseEpoch: input.authority.leaseEpoch,
        attempt: {
          ...input.toolAttempt,
          status: "completed",
          finishedAt: input.committedAt,
          checkpointDigest: null,
        },
      });
      this.#insertEventAndOutbox(input, event);
      this.#writeCheckpoint(
        input.authority,
        input.expectedContinuationRevision,
        continuation,
      );
      this.#database.exec("COMMIT");
      return { receipt, continuation };
    } catch (error) {
      rollback(this.#database);
      throw error instanceof RunStoreError
        ? error
        : new RunStoreError("workflow_node_continuation_store_failed", {
            cause: error instanceof Error ? error : undefined,
          });
    }
  }

  #validateLease(
    input: Pick<CommitWorkflowAssistantContinuationInput, "lease"> &
      Readonly<{ authority: WorkflowAgentAttemptAuthority }>,
    nowMs: number,
  ): void {
    if (
      input.lease.workItemId !== input.authority.workItemId ||
      input.lease.leaseEpoch !== input.authority.leaseEpoch
    )
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
    const row = this.#database
      .prepare(
        `SELECT tenant_id,run_id,status,lease_owner_id,lease_id,lease_epoch,
                lease_expires_at_ms
         FROM work_items WHERE work_item_id=?`,
      )
      .get(input.lease.workItemId) as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      row.tenant_id !== input.authority.tenantId ||
      row.run_id !== input.authority.runId ||
      row.status !== "leased" ||
      row.lease_owner_id !== input.lease.ownerId ||
      row.lease_id !== input.lease.leaseId ||
      row.lease_epoch !== input.lease.leaseEpoch ||
      typeof row.lease_expires_at_ms !== "number" ||
      row.lease_expires_at_ms <= nowMs
    )
      throw new RunStoreError("stale_lease");
  }

  #validateAuthority(authority: WorkflowAgentAttemptAuthority): void {
    const row = this.#database
      .prepare(
        `SELECT state_json FROM workflow_executions
         WHERE tenant_id=? AND run_id=?`,
      )
      .get(authority.tenantId, authority.runId) as
      | { state_json: string }
      | undefined;
    if (row === undefined)
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
    let execution;
    try {
      execution = decodeWorkflowExecutionState(JSON.parse(row.state_json));
      validateWorkflowExecutionState(execution);
    } catch (error) {
      throw new RunStoreError("workflow_execution_corrupt", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    const node = execution.nodes.find(
      (candidate) => candidate.nodeId === authority.nodeId,
    );
    const step = loadSqliteRunStep(this.#database, {
      tenantId: authority.tenantId,
      runId: authority.runId,
      stepId: authority.attempt.stepId,
    });
    const attempt = loadSqliteRunAttempt(this.#database, {
      tenantId: authority.tenantId,
      runId: authority.runId,
      ...authority.attempt,
    });
    if (
      node?.status !== "running" ||
      node.kind !== authority.nodeKind ||
      node.claimId !== authority.claimId ||
      node.claimEpoch !== authority.claimEpoch ||
      node.agentVersionId !== authority.agentVersionId ||
      step?.currentAttemptId !== authority.attempt.attemptId ||
      step.kind !== authority.nodeKind ||
      step.status !== "running" ||
      attempt?.status !== "running" ||
      attempt.workItemId !== authority.workItemId ||
      attempt.leaseEpoch !== authority.leaseEpoch
    )
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
  }

  #validateCheckpointCorrelation(
    authority: WorkflowAgentAttemptAuthority,
    checkpoint: WorkflowNodeContinuationCheckpoint,
  ): void {
    const attempt = loadSqliteRunAttempt(this.#database, {
      tenantId: authority.tenantId,
      runId: authority.runId,
      ...authority.attempt,
    });
    if (attempt?.status !== "running" ||
        attempt.workItemId !== authority.workItemId ||
        attempt.leaseEpoch !== authority.leaseEpoch ||
        attempt.stepId !== authority.attempt.stepId ||
        attempt.attemptId !== authority.attempt.attemptId ||
        attempt.providerTurnState !== checkpoint.providerTurnState)
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
    if (checkpoint.activeDispatch === null) {
      if (checkpoint.terminalCandidate !== null)
        throw new RunStoreError("workflow_terminal_candidate_dispatch_mismatch");
      return;
    }
    const dispatch = loadSqliteModelDispatchReceipt(this.#database, {
      tenantId: authority.tenantId,
      runId: authority.runId,
      ...authority.attempt,
      operationId: checkpoint.activeDispatch.operationId,
    });
    if (
      dispatch === null ||
      dispatch.requestSequence !== checkpoint.activeDispatch.requestSequence ||
      dispatch.revision !== checkpoint.activeDispatch.expectedRevision ||
      dispatch.status !== checkpoint.activeDispatch.status
    )
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
    if (checkpoint.terminalCandidate !== null) {
      if (checkpoint.activeDispatch.status !== "responseObserved" ||
          checkpoint.terminalCandidate.segmentId !== checkpoint.segmentId)
        throw new RunStoreError("workflow_terminal_candidate_dispatch_mismatch");
      const evidence = validateWorkflowNodeTerminalEvidence({
        workflow: this.#loadBoundWorkflow(authority), nodeId: authority.nodeId,
        evidence: checkpoint.terminalCandidate.evidence, digester: this.#digester });
      validateWorkflowDispatchTerminalCorrelation({ dispatch:
        checkpoint.terminalCandidate.dispatchTerminalOutcome, evidence });
      const candidateId = this.#digester.sha256(canonicalJson({ authority,
        segmentId: checkpoint.segmentId, evidence,
        dispatchTerminalOutcome: checkpoint.terminalCandidate.dispatchTerminalOutcome }));
      if (candidateId !== checkpoint.terminalCandidate.candidateId)
        throw new RunStoreError("workflow_terminal_candidate_corrupt");
    }
  }

  #validateToolCorrelation(
    input: CommitWorkflowToolContinuationInput,
    receipt: ToolExecutionReceiptState,
  ): void {
    const attempt = loadSqliteRunAttempt(this.#database, {
      tenantId: input.authority.tenantId,
      runId: input.authority.runId,
      ...input.toolAttempt,
    });
    const event = input.completedEvent;
    if (
      stableJson(receipt) !== stableJson(input.receipt) ||
      receipt.tenantId !== input.authority.tenantId ||
      receipt.runId !== input.authority.runId ||
      receipt.workItemId !== input.authority.workItemId ||
      receipt.stepId !== input.toolAttempt.stepId ||
      receipt.attemptId !== input.toolAttempt.attemptId ||
      receipt.status !== "dispatched" ||
      attempt?.status !== "running" ||
      attempt.workItemId !== input.authority.workItemId ||
      attempt.leaseEpoch !== input.authority.leaseEpoch ||
      event.runId !== input.authority.runId ||
      receipt.call.segmentId !== event.segmentId ||
      receipt.call.callId !== event.data.callId ||
      receipt.call.kind !== event.data.kind ||
      receipt.call.name !== event.data.name ||
      !toolSegmentMatches(input.authority.attempt.attemptId, event.segmentId)
    )
      throw new RunStoreError("workflow_tool_completion_mismatch");
    const prior = this.#latestSegmentEvent(input.authority, event.segmentId);
    if (
      prior === null ||
      !("segmentSequence" in prior.data) ||
      event.sequence !== prior.data.segmentSequence + 1
    )
      throw new RunStoreError("workflow_tool_event_sequence_mismatch");
  }

  #nextCheckpoint(
    input: CommitWorkflowToolContinuationInput,
    current: WorkflowNodeContinuationCheckpoint | null,
  ): WorkflowNodeContinuationCheckpoint {
    if ((current?.revision ?? null) !== input.expectedContinuationRevision)
      throw new RunStoreError("workflow_node_continuation_revision_conflict");
    const next = validateWorkflowNodeContinuationCheckpoint({
      ...input.next,
      terminalCandidate: null,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: input.committedAt,
    });
    if (stableJson(next.authority) !== stableJson(input.authority))
      throw new RunStoreError("workflow_node_continuation_authority_mismatch");
    this.#validateCheckpointCorrelation(input.authority, next);
    return next;
  }

  #writeCheckpoint(
    authority: WorkflowAgentAttemptAuthority,
    expectedRevision: number | null,
    checkpoint: WorkflowNodeContinuationCheckpoint,
  ): void {
    const write = this.#database
      .prepare(
        `INSERT INTO workflow_node_continuations
         (tenant_id,run_id,step_id,attempt_id,revision,checkpoint_json,updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id,run_id,step_id,attempt_id) DO UPDATE SET
           revision=excluded.revision,checkpoint_json=excluded.checkpoint_json,
           updated_at=excluded.updated_at WHERE revision=?`,
      )
      .run(
        authority.tenantId,
        authority.runId,
        authority.attempt.stepId,
        authority.attempt.attemptId,
        checkpoint.revision,
        stableJson(checkpoint),
        checkpoint.updatedAt,
        expectedRevision ?? 0,
      );
    if (write.changes !== 1)
      throw new RunStoreError("workflow_node_continuation_revision_conflict");
  }

  #toolCompletedEvent(
    input: CommitWorkflowToolContinuationInput,
  ): Extract<RunLifecycleEvent, { type: "tool.completed" }> {
    const run = this.#loadRun(input.authority);
    const eventId = this.#id("tool-event", {
      authority: input.authority,
      segmentId: input.completedEvent.segmentId,
      sequence: input.completedEvent.sequence,
      callId: input.completedEvent.data.callId,
    });
    return {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: input.authority.runId },
      eventId,
      sequence: run.lastSequence + 1,
      occurredAt: input.committedAt,
      type: "tool.completed",
      data: {
        segmentId: input.completedEvent.segmentId,
        segmentSequence: input.completedEvent.sequence,
        ...input.completedEvent.data,
      },
    };
  }

  #insertEventAndOutbox(
    input: CommitWorkflowToolContinuationInput,
    event: Extract<RunLifecycleEvent, { type: "tool.completed" }>,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json)
         VALUES (?,?,?,?,?)`,
      )
      .run(
        input.authority.tenantId,
        input.authority.runId,
        event.sequence,
        event.eventId,
        stableJson(event),
      );
    const messageId = this.#id("tool-outbox", {
      authority: input.authority,
      eventId: event.eventId,
    });
    const message = {
      messageId,
      tenantId: input.authority.tenantId,
      runId: input.authority.runId,
      topic: "run.updated",
      payload: {
        eventId: event.eventId,
        eventType: event.type,
        throughSequence: event.sequence,
      },
      createdAt: input.committedAt,
    };
    this.#database
      .prepare(
        `INSERT INTO outbox(message_id,tenant_id,run_id,topic,message_json,created_at,
         status,available_at_ms,lease_epoch,attempt_count)
         VALUES (?,?,?,?,?,?,'pending',?,0,0)`,
      )
      .run(
        messageId,
        input.authority.tenantId,
        input.authority.runId,
        message.topic,
        stableJson(message),
        input.committedAt,
        Date.parse(input.committedAt),
      );
  }

  #validateToolReplay(
    input: CommitWorkflowToolContinuationInput,
    receipt: ToolExecutionReceiptState,
  ): {
    receipt: ToolExecutionReceiptState;
    continuation: WorkflowNodeContinuationCheckpoint;
  } {
    try {
      const expectedReceipt = resolveToolExecutionReceipt(input.receipt, {
        status: "completed",
        resolvedAt: input.committedAt,
        providerReceiptId: input.providerReceiptId,
        result: toolResult(input, this.#digester),
      });
      if (stableJson(receipt) !== stableJson(expectedReceipt))
        throw new Error("receipt mismatch");
      const attempt = loadSqliteRunAttempt(this.#database, {
        tenantId: input.authority.tenantId,
        runId: input.authority.runId,
        ...input.toolAttempt,
      });
      const continuation = this.#loadStoredCheckpoint(input.authority);
      const expected = validateWorkflowNodeContinuationCheckpoint({
        ...input.next,
        terminalCandidate: null,
        revision: (input.expectedContinuationRevision ?? 0) + 1,
        updatedAt: input.committedAt,
      });
      const event = this.#toolCompletedEventForReplay(input);
      const run = this.#loadRun(input.authority);
      const messageId = this.#id("tool-outbox", {
        authority: input.authority,
        eventId: event.eventId,
      });
      const outbox = this.#database
        .prepare("SELECT message_json FROM outbox WHERE message_id=?")
        .get(messageId) as { message_json: string } | undefined;
      if (
        attempt?.status !== "completed" ||
        attempt.workItemId !== input.authority.workItemId ||
        attempt.leaseEpoch !== input.authority.leaseEpoch ||
        attempt.updatedAt !== input.committedAt ||
        attempt.terminalAt !== input.committedAt ||
        attempt.checkpointDigest !== null ||
        attempt.providerCheckpoint !== null ||
        attempt.providerTurnState !== null ||
        attempt.failure !== null ||
        run.lastSequence !== event.sequence ||
        run.revision !== event.sequence ||
        run.updatedAt !== input.committedAt ||
        stableJson(continuation) !== stableJson(expected) ||
        stableJson(event.data) !==
          stableJson({
            segmentId: input.completedEvent.segmentId,
            segmentSequence: input.completedEvent.sequence,
            ...input.completedEvent.data,
          }) ||
        event.occurredAt !== input.committedAt ||
        outbox === undefined ||
        stableJson(JSON.parse(outbox.message_json)) !==
          stableJson({
            messageId,
            tenantId: input.authority.tenantId,
            runId: input.authority.runId,
            topic: "run.updated",
            payload: {
              eventId: event.eventId,
              eventType: event.type,
              throughSequence: event.sequence,
            },
            createdAt: input.committedAt,
          })
      )
        throw new Error("atomic result mismatch");
      return { receipt, continuation };
    } catch (error) {
      throw new RunStoreError("workflow_tool_continuation_corrupt", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  #loadStoredCheckpoint(
    authority: WorkflowAgentAttemptAuthority,
  ): WorkflowNodeContinuationCheckpoint {
    const row = this.#database
      .prepare(
        `SELECT checkpoint_json FROM workflow_node_continuations
         WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
      )
      .get(
        authority.tenantId,
        authority.runId,
        authority.attempt.stepId,
        authority.attempt.attemptId,
      ) as { checkpoint_json: string } | undefined;
    if (row === undefined) throw new Error("continuation missing");
    return validateWorkflowNodeContinuationCheckpoint(
      JSON.parse(row.checkpoint_json),
    );
  }

  #terminalCandidate(input: CommitWorkflowAssistantContinuationInput) {
    if (input.terminalResult === null) return null;
    if (input.next.activeDispatch?.status !== "responseObserved")
      throw new RunStoreError("workflow_terminal_candidate_dispatch_mismatch");
    const workflow = this.#loadBoundWorkflow(input.authority);
    let outcome;
    if (input.terminalResult.status === "completed") {
      let value: unknown;
      try { value = JSON.parse(input.terminalResult.output); }
      catch { throw new RunStoreError("workflow_terminal_candidate_invalid"); }
      outcome = { status: "completed" as const,
        value: value as import("@crewon/domain").WorkflowSchemaValue };
    } else if (input.terminalResult.status === "failed") {
      outcome = { ...input.terminalResult, certainty: "responseObserved" as const };
    } else outcome = { status: "canceled" as const,
      certainty: "responseObserved" as const };
    const evidence = createWorkflowNodeTerminalEvidence({ workflow,
      nodeId: input.authority.nodeId, outcome, digester: this.#digester });
    const dispatchTerminalOutcome = { kind: input.terminalResult.status,
      code: input.terminalResult.status === "failed" ? input.terminalResult.failureCode
        : input.terminalResult.status === "canceled" ? "workflow_node_canceled" : null,
      certainty: "responseObserved" as const };
    return { schemaVersion: "crewon.workflow-node-terminal-candidate.v0" as const,
      candidateId: this.#digester.sha256(canonicalJson({ authority: input.authority,
        segmentId: input.next.segmentId, evidence, dispatchTerminalOutcome })),
      segmentId: input.next.segmentId, evidence, dispatchTerminalOutcome };
  }

  #loadBoundWorkflow(authority: WorkflowAgentAttemptAuthority) {
    const executionRow = this.#database.prepare(
      "SELECT state_json FROM workflow_executions WHERE tenant_id=? AND run_id=?",
    ).get(authority.tenantId, authority.runId) as
      { state_json: string } | undefined;
    if (executionRow === undefined)
      throw new RunStoreError("workflow_execution_not_found");
    const execution = decodeWorkflowExecutionState(executionRow.state_json);
    const version = this.#database.prepare(`SELECT definition_json FROM workflow_versions
      WHERE tenant_id=? AND workflow_version_id=? AND content_digest=?`).get(
        authority.tenantId, execution.workflowVersionId,
        execution.contentDigest) as { definition_json: string } | undefined;
    if (version === undefined) throw new RunStoreError("workflow_version_not_found");
    return parseBoundWorkflow(version.definition_json, {
      workflowId: execution.workflowId, workflowVersionId: execution.workflowVersionId,
      contentDigest: execution.contentDigest }, this.#digester);
  }

  #toolCompletedEventForReplay(
    input: CommitWorkflowToolContinuationInput,
  ): Extract<RunLifecycleEvent, { type: "tool.completed" }> {
    const eventId = this.#id("tool-event", {
      authority: input.authority,
      segmentId: input.completedEvent.segmentId,
      sequence: input.completedEvent.sequence,
      callId: input.completedEvent.data.callId,
    });
    const row = this.#database
      .prepare("SELECT sequence,event_json FROM run_events WHERE event_id=?")
      .get(eventId) as { sequence: number; event_json: string } | undefined;
    if (row === undefined) throw new Error("event missing");
    const event = JSON.parse(row.event_json) as RunLifecycleEvent;
    if (
      event.type !== "tool.completed" ||
      event.eventId !== eventId ||
      event.sequence !== row.sequence
    )
      throw new Error("event mismatch");
    parseCanonicalAgentEvent({
      schemaVersion: "crewon.agent-event.v0",
      runId: event.identity.runId,
      segmentId: event.data.segmentId,
      sequence: event.data.segmentSequence,
      type: event.type,
      data: {
        callId: event.data.callId,
        kind: event.data.kind,
        name: event.data.name,
        output: event.data.output,
        isError: event.data.isError,
        artifactRef: event.data.artifactRef,
        outputTruncated: event.data.outputTruncated,
      },
    });
    return event;
  }

  #latestSegmentEvent(
    authority: WorkflowAgentAttemptAuthority,
    segmentId: string,
  ): RunLifecycleEvent | null {
    const row = this.#database
      .prepare(
        `SELECT event_json FROM run_events
         WHERE tenant_id=? AND run_id=?
           AND json_extract(event_json,'$.data.segmentId')=?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(authority.tenantId, authority.runId, segmentId) as
      | { event_json: string }
      | undefined;
    if (row === undefined) return null;
    try {
      return JSON.parse(row.event_json) as RunLifecycleEvent;
    } catch (error) {
      throw new RunStoreError("workflow_tool_continuation_corrupt", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  #loadRun(authority: WorkflowAgentAttemptAuthority): RunState {
    const row = this.#database
      .prepare(
        "SELECT state_json FROM run_snapshots WHERE tenant_id=? AND run_id=?",
      )
      .get(authority.tenantId, authority.runId) as
      | { state_json: string }
      | undefined;
    if (row === undefined) throw new RunStoreError("run_not_found");
    return normalizeStoredRunState(
      JSON.parse(row.state_json),
      "stored_run_invalid",
    );
  }

  #id(role: string, value: unknown): string {
    const digest = this.#digester.sha256(
      stableJson({
        schemaVersion: "crewon.workflow-tool-authority.v0",
        role,
        value,
      }),
    );
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new RunStoreError("workflow_composition_digest_invalid");
    return `wf-tool:${role}:${digest.slice(7)}`;
  }
}

function toolResult(
  input: CommitWorkflowToolContinuationInput,
  digester: WorkflowContentDigester,
) {
  return {
    output: input.completedEvent.data.output,
    outputDigest: digester.sha256(input.completedEvent.data.output),
    isError: input.completedEvent.data.isError,
    artifactRef: input.completedEvent.data.artifactRef,
  };
}

function toolSegmentMatches(
  parentAttemptId: string,
  segmentId: string,
): boolean {
  const prefix = `segment:${parentAttemptId}`;
  return segmentId === prefix || segmentId.startsWith(`${prefix}:round:`);
}
