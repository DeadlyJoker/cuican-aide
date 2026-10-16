import {
  canonicalJson,
  RunStoreError,
  splitWorkflowModelFragment,
  type CommitRunInput,
  type CommitThreadInput,
  type WorkflowExecutionState,
} from "@crewon/application";
import {
  composeWorkflowOutput,
  type CompiledWorkflowVersion,
  type FrozenWorkflowVersionBinding,
  type RunState,
  type ThreadState,
  type RunLifecycleEvent,
} from "@crewon/domain";
import { workflowNodeValue } from "./workflow-node-value.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

/** Frozen node outputs determine the result; aggregation never requires another model call. */
export function workflowRootOutcome(input: {
  execution: WorkflowExecutionState;
  workflow: CompiledWorkflowVersion;
  rows: ReadonlyMap<string, { output_json: string | null }>;
}) {
  let output: ReturnType<typeof workflowNodeValue> | null = null;
  let failureCode: string | null =
    input.execution.status === "failed" ? "workflow_node_failed" : null;
  if (input.execution.status === "completed") {
    try {
      output = workflowNodeValue(
        composeWorkflowOutput({
          workflow: input.workflow,
          outputValues: input.workflow.outputNodeIds.map((nodeId) => {
            const row = input.rows.get(nodeId);
            if (!row?.output_json)
              throw new RunStoreError("workflow_output_authority_missing");
            return { nodeId, value: JSON.parse(row.output_json) };
          }),
        }),
        input.workflow.outputSchema,
      );
    } catch (error) {
      if (
        error instanceof RunStoreError &&
        error.code === "workflow_node_value_limit"
      )
        failureCode = "workflow_output_limit";
      else throw error;
    }
  }
  return { output, failureCode };
}
export function workflowRootFinalizationKey(input: {
  tenantId: string;
  runId: string;
  binding: FrozenWorkflowVersionBinding;
  execution: WorkflowExecutionState;
  output: ReturnType<typeof workflowNodeValue> | null;
  failureCode: string | null;
  canceled: boolean;
}): CommitRunInput["idempotency"] {
  return {
    scope: canonicalJson({
      namespace: "workflow.root-finalize.v1",
      tenantId: input.tenantId,
    }),
    key: input.runId,
    requestFingerprint: workflowAdmissionDigest.sha256(
      canonicalJson({
        binding: input.binding,
        executionDigest: workflowAdmissionDigest.sha256(
          canonicalJson(input.execution),
        ),
        outcome: input.canceled
          ? { status: "canceled", reasonCode: "workflow_cancel_requested" }
          : input.output
            ? { status: "completed", digest: input.output.digest }
            : { status: "failed", failureCode: input.failureCode },
      }),
    ),
  };
}

/** Pure commit preparation, invoked only after checking the durable terminal receipt. */
export function prepareWorkflowRootCompletion(input: {
  run: RunState;
  thread: ThreadState | null;
  historyHead: number;
  output: ReturnType<typeof workflowNodeValue> | null;
  failureCode: string | null;
  canceled: boolean;
  idempotency: CommitRunInput["idempotency"];
  now: string;
  nextId(): string;
}): { thread: CommitThreadInput | null; commit: CommitRunInput } {
  const { run, output, now, idempotency, nextId } = input;
  const events: RunLifecycleEvent[] = [];
  const envelope = () => ({
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: run.runId },
    eventId: nextId(),
    sequence: run.lastSequence + events.length + 1,
    occurredAt: now,
  });
  let threadCommit: CommitThreadInput | null = null;
  if (output) {
    const thread = input.thread;
    if (
      !thread ||
      thread.threadId !== run.threadId ||
      thread.tenantId !== run.tenantId ||
      thread.spaceId !== run.spaceId
    )
      throw new RunStoreError("thread_not_found");
    const message = {
      messageId: nextId(),
      tenantId: run.tenantId,
      threadId: run.threadId,
      sequence: thread.lastMessageSequence + 1,
      role: "assistant" as const,
      content: output.json,
      contentDigest: output.digest,
      createdAt: now,
      origin: null,
      proposedPlan: null,
    };
    threadCommit = {
      tenantId: run.tenantId,
      idempotency,
      expectedRevision: thread.revision,
      events: [
        {
          schemaVersion: "crewon.thread-event.v0",
          identity: { threadId: thread.threadId },
          eventId: nextId(),
          sequence: thread.lastEventSequence + 1,
          occurredAt: now,
          type: "thread.message.appended",
          data: {
            messageId: message.messageId,
            messageSequence: message.sequence,
            role: message.role,
            contentDigest: output.digest,
          },
        },
      ],
      messages: [message],
      history: {
        expectedLastSequence: input.historyHead,
        items: splitWorkflowModelFragment(output.json).map(
          (content, index) => ({
            schemaVersion: "crewon.model-history-item.v0" as const,
            itemId: nextId(),
            tenantId: run.tenantId,
            threadId: run.threadId,
            sequence: input.historyHead + index + 1,
            runId: run.runId,
            segmentId: null,
            createdAt: now,
            type: "message" as const,
            role: "assistant" as const,
            source: "assistant_completion" as const,
            content,
            contentDigest: workflowAdmissionDigest.sha256(content),
          }),
        ),
      },
    };
    events.push({
      ...envelope(),
      type: "message.completed",
      data: {
        messageId: message.messageId,
        messageSequence: message.sequence,
        role: "assistant",
        contentDigest: output.digest,
      },
    });
    events.push({
      ...envelope(),
      type: "run.completed",
      data: { outputRef: `message:${message.messageId}` },
    });
  } else if (input.canceled)
    events.push({
      ...envelope(),
      type: "run.canceled",
      data: { reasonCode: "workflow_cancel_requested" },
    });
  else
    events.push({
      ...envelope(),
      type: "run.failed",
      data: { code: input.failureCode!, retryable: false },
    });
  return {
    thread: threadCommit,
    commit: {
      tenantId: run.tenantId,
      idempotency,
      expectedRevision: run.revision,
      events,
      workItems: [],
      outbox: events.map((event) => ({
        messageId: nextId(),
        tenantId: run.tenantId,
        runId: run.runId,
        topic: "run.updated",
        payload: {
          eventId: event.eventId,
          eventType: event.type,
          throughSequence: event.sequence,
        },
        createdAt: now,
      })),
    },
  };
}
