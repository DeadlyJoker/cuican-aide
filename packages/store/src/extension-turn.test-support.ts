import type { CommitExtensionTurnInput } from "@crewon/application";
import { createExtensionRunBinding } from "@crewon/domain";
import { runInput, timestamp } from "./extension-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { turnStartCommit } from "./turn-start-store-conformance.test-support.ts";

export function extensionTurnInput(
  id = "run-1",
  patch: Partial<CommitExtensionTurnInput["binding"]> = {},
): CommitExtensionTurnInput {
  const content = JSON.stringify({
    prompt: "A ceramic teapot by a sunlit window.",
  });
  const inputDigest = extensionStoreDigester.sha256(content);
  const run = runInput(id, { ...patch, inputDigest });
  const binding = createExtensionRunBinding(
    { ...run.binding, inputDigest },
    extensionStoreDigester,
  );
  const turn = turnStartCommit({ runId: id, occurredAt: timestamp });
  const event = turn.thread.events[0]!;
  if (event.type !== "thread.message.appended")
    throw new Error("invalid fixture");
  const historyItem = turn.thread.history.items[0]!;
  if (historyItem.type !== "message") throw new Error("invalid fixture");
  return {
    binding,
    expectedActivationRevision: run.expectedActivationRevision,
    receipt: run.receipt,
    turn: {
      ...turn,
      tenantId: binding.tenantId,
      run: run.commit,
      thread: {
        ...turn.thread,
        events: [
          {
            ...event,
            identity: { threadId: binding.threadId },
            eventId: `thread-event-${id}`,
            data: {
              ...event.data,
              messageId: `message-${id}`,
              contentDigest: inputDigest,
            },
          },
        ],
        messages: [
          {
            ...turn.thread.messages[0]!,
            messageId: `message-${id}`,
            tenantId: binding.tenantId,
            threadId: binding.threadId,
            content,
            contentDigest: inputDigest,
          },
        ],
        history: {
          ...turn.thread.history,
          items: [
            {
              ...historyItem,
              itemId: `history-${id}`,
              tenantId: binding.tenantId,
              threadId: binding.threadId,
              content,
              contentDigest: inputDigest,
            },
          ],
        },
      },
    },
  };
}
