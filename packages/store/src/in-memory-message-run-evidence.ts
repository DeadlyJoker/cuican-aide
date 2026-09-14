import type {
  CommitTurnStartResult,
  MessageRecord,
  ThreadScopedLocator,
} from "@crewon/application";
import type { RunLifecycleEvent, RunState } from "@crewon/domain";
import {
  MessageRunEvidenceBudget,
  resolveMessageRunEvidence,
  type MessageRunEvidence,
} from "./message-run-evidence.ts";

/** Lightweight pointers to already-owned immutable receipts/events; no history scan on reads. */
export class InMemoryMessageRunEvidence {
  readonly #byMessage = new Map<string, MessageRunEvidence[]>();

  recordTurnStart(result: CommitTurnStartResult): void {
    const message = result.messages[0]!;
    this.#add(message.tenantId, message.messageId, {
      tenantId: message.tenantId,
      runId: result.runState.runId,
      spaceId: result.runState.spaceId,
      threadId: result.runState.threadId,
      payload: result,
    });
  }

  recordEvent(run: RunState, event: RunLifecycleEvent): void {
    if (event.type !== "message.completed") return;
    this.#add(run.tenantId, event.data.messageId, {
      tenantId: run.tenantId,
      runId: run.runId,
      spaceId: run.spaceId,
      threadId: run.threadId,
      payload: event,
    });
  }

  read(locator: ThreadScopedLocator, messages: readonly MessageRecord[]) {
    const budget = new MessageRunEvidenceBudget();
    return messages.map((message) => {
      const candidates =
        this.#byMessage.get(
          JSON.stringify([locator.tenantId, message.messageId]),
        ) ?? [];
      for (const candidate of candidates)
        budget.consume(Buffer.byteLength(JSON.stringify(candidate.payload)));
      return resolveMessageRunEvidence(locator, message, candidates);
    });
  }

  #add(
    tenantId: string,
    messageId: string,
    evidence: MessageRunEvidence,
  ): void {
    const key = JSON.stringify([tenantId, messageId]);
    const candidates = this.#byMessage.get(key) ?? [];
    // Two proofs already mean an invariant violation; no need to retain further duplicates.
    if (candidates.length < 2) candidates.push(evidence);
    this.#byMessage.set(key, candidates);
  }
}
