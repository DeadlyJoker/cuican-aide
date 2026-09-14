import {
  RunStoreError,
  type MessageRecord,
  type ThreadMessageRunBinding,
  type ThreadScopedLocator,
} from "@crewon/application";

export const MAX_MESSAGE_RUN_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_MESSAGE_RUN_EVIDENCE_WINDOW_BYTES = 8 * 1024 * 1024;

export type MessageRunEvidence = Readonly<{
  tenantId: string;
  runId: string;
  spaceId: string | null;
  threadId: string | null;
  payload: unknown;
}>;

/** Checks identities against both physical binding rows and the immutable proof. */
export function resolveMessageRunEvidence(
  locator: ThreadScopedLocator,
  message: MessageRecord,
  candidates: readonly MessageRunEvidence[],
): ThreadMessageRunBinding {
  const fail = (): never => {
    throw new RunStoreError("message_run_evidence_invalid");
  };
  if (
    message.tenantId !== locator.tenantId ||
    message.threadId !== locator.threadId
  )
    fail();
  if (candidates.length > 1)
    throw new RunStoreError("message_run_evidence_ambiguous");
  const evidence = candidates[0];
  if (evidence === undefined)
    return {
      messageId: message.messageId,
      runId: null,
      source: "unassociated",
    };
  if (
    evidence.tenantId !== locator.tenantId ||
    evidence.spaceId !== locator.spaceId ||
    evidence.threadId !== locator.threadId ||
    typeof evidence.runId !== "string" ||
    evidence.runId.trim().length === 0 ||
    evidence.runId.length > 512
  )
    fail();
  if (
    message.proposedPlan != null &&
    message.proposedPlan.runId !== evidence.runId
  )
    fail();
  const value = evidence.payload;
  if (!record(value)) return fail();
  if (message.role === "user") {
    if (
      value.disposition !== "committed" ||
      !record(value.runState) ||
      !record(value.threadState) ||
      value.runState.tenantId !== locator.tenantId ||
      value.runState.spaceId !== locator.spaceId ||
      value.runState.threadId !== locator.threadId ||
      value.runState.runId !== evidence.runId ||
      value.threadState.tenantId !== locator.tenantId ||
      value.threadState.spaceId !== locator.spaceId ||
      value.threadState.threadId !== locator.threadId ||
      !Array.isArray(value.messages) ||
      value.messages.length !== 1 ||
      !record(value.messages[0]) ||
      !Array.isArray(value.runEvents) ||
      value.runEvents.length !== 1 ||
      !record(value.runEvents[0]) ||
      !Array.isArray(value.threadEvents) ||
      value.threadEvents.length !== 1 ||
      !record(value.threadEvents[0])
    )
      return fail();
    const stored = value.messages[0];
    for (const key of [
      "messageId",
      "tenantId",
      "threadId",
      "sequence",
      "role",
      "content",
      "contentDigest",
      "createdAt",
    ] as const) {
      if (stored[key] !== message[key]) fail();
    }
    const created = value.runEvents[0];
    const appended = value.threadEvents[0];
    if (
      created.schemaVersion !== "crewon.run-event.v0" ||
      created.type !== "run.created" ||
      created.sequence !== 1 ||
      !record(created.identity) ||
      created.identity.runId !== evidence.runId ||
      !record(created.data) ||
      created.data.tenantId !== locator.tenantId ||
      created.data.spaceId !== locator.spaceId ||
      created.data.threadId !== locator.threadId ||
      appended.schemaVersion !== "crewon.thread-event.v0" ||
      appended.type !== "thread.message.appended" ||
      !record(appended.identity) ||
      appended.identity.threadId !== locator.threadId ||
      !record(appended.data) ||
      !matchesMessage(appended.data, message)
    )
      fail();
    return {
      messageId: message.messageId,
      runId: evidence.runId,
      source: "turnStartReceipt",
    };
  }
  if (
    message.role !== "assistant" ||
    value.schemaVersion !== "crewon.run-event.v0" ||
    value.type !== "message.completed" ||
    !record(value.identity) ||
    value.identity.runId !== evidence.runId ||
    !record(value.data) ||
    !matchesMessage(value.data, message)
  )
    fail();
  return {
    messageId: message.messageId,
    runId: evidence.runId,
    source: "messageCompletedEvent",
  };
}

function matchesMessage(data: Record<string, unknown>, message: MessageRecord) {
  return (
    data.messageId === message.messageId &&
    data.messageSequence === message.sequence &&
    data.contentDigest === message.contentDigest &&
    data.role === message.role
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class MessageRunEvidenceBudget {
  #bytes = 0;
  consume(storedBytes: number | string): void {
    const bytes = Number(storedBytes);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_MESSAGE_RUN_EVIDENCE_BYTES ||
      this.#bytes + bytes > MAX_MESSAGE_RUN_EVIDENCE_WINDOW_BYTES
    ) {
      throw new RunStoreError("message_run_evidence_too_large");
    }
    this.#bytes += bytes;
  }
  get remaining(): number {
    return Math.min(
      MAX_MESSAGE_RUN_EVIDENCE_BYTES,
      MAX_MESSAGE_RUN_EVIDENCE_WINDOW_BYTES - this.#bytes,
    );
  }
}
