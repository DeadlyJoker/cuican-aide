import {
  canonicalJson,
  RunStoreError,
  splitWorkflowModelFragment,
  type CommitRunResult,
  type CommitThreadInput,
  type CommitThreadResult,
  type CommitWorkflowRunStartInput,
} from "@crewon/application";
import type { ThreadState } from "@crewon/domain";
import type { JsonValue } from "@crewon/contracts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

/** A new Workflow start is one user turn in its main Thread, not only a final
 * assistant message. The admission transaction owns both writes and the receipt.
 * Existing receipts are replayed before this function and are never backfilled.
 */
export function prepareWorkflowRootInput(
  input: CommitWorkflowRunStartInput,
  run: CommitRunResult,
  thread: ThreadState,
  historyHead: number,
): CommitThreadInput {
  if (!Number.isSafeInteger(historyHead) || historyHead < 0)
    throw new RunStoreError("workflow_root_history_limit");
  const content = workflowRootInputContent(input.workflowInput);
  const digest = workflowAdmissionDigest.sha256(content);
  const id = (kind: string) =>
    workflowAdmissionDigest
      .sha256(
        canonicalJson([
          "workflow-root-input.v1",
          run.state.tenantId,
          run.state.runId,
          kind,
        ]),
      )
      .slice(7);
  const message = {
    messageId: id("message"),
    tenantId: input.tenantId,
    threadId: thread.threadId,
    sequence: thread.lastMessageSequence + 1,
    role: "user" as const,
    content,
    contentDigest: digest,
    createdAt: run.state.createdAt,
    origin: null,
    proposedPlan: null,
  };
  return {
    tenantId: input.tenantId,
    idempotency: input.idempotency,
    expectedRevision: thread.revision,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: thread.threadId },
        eventId: id("event"),
        sequence: thread.lastEventSequence + 1,
        occurredAt: run.state.createdAt,
        type: "thread.message.appended",
        data: {
          messageId: message.messageId,
          messageSequence: message.sequence,
          role: "user",
          contentDigest: digest,
        },
      },
    ],
    messages: [message],
    history: {
      expectedLastSequence: historyHead,
      items: splitWorkflowModelFragment(content).map((fragment, index) => ({
        schemaVersion: "crewon.model-history-item.v0",
        itemId: id(`history:${index}`),
        tenantId: input.tenantId,
        threadId: thread.threadId,
        sequence: historyHead + index + 1,
        runId: run.state.runId,
        segmentId: null,
        createdAt: run.state.createdAt,
        type: "message",
        role: "user",
        source: "thread_message",
        content: fragment,
        contentDigest: workflowAdmissionDigest.sha256(fragment),
      })),
    },
  };
}

export function workflowRootInputContent(value: JsonValue): string {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.prompt === "string" &&
    value.prompt.trim().length > 0
    ? value.prompt
    : canonicalJson(value);
}

/** Reuse the existing indexed compound-start proof consumed by message windows.
 * The public Workflow result remains CommitRunResult; these are receipt-only fields.
 */
export function workflowRootInputReceipt(
  run: CommitRunResult,
  thread: CommitThreadResult,
) {
  if (thread.disposition !== "committed")
    throw new RunStoreError("workflow_run_admission_receipt_invalid");
  return {
    ...run,
    runState: run.state,
    threadState: thread.state,
    messages: thread.messages,
    runEvents: run.events,
    threadEvents: thread.events,
  };
}
