import assert from "node:assert/strict";
import type { ControlApiClient } from "@crewon/control-client";

/** Prove the accepted original input remains one exact, root-bound user message
 * on success, rejection, failure, cancellation and receipt recovery alike.
 */
export function assertWorkflowRootInput(
  snapshot: Awaited<
    ReturnType<ControlApiClient["getThreadTranscriptSnapshot"]>
  >,
  runId: string,
  content?: string,
) {
  const users = snapshot.transcriptWindow.messageWindow.data.filter(
    (message) =>
      message.role === "user" &&
      snapshot.transcriptWindow.runBindings.some(
        (binding) =>
          binding.messageId === message.messageId && binding.runId === runId,
      ),
  );
  assert.equal(
    users.length,
    1,
    "one original input per admitted Workflow root",
  );
  const user = users[0]!;
  assert.equal(
    snapshot.transcriptWindow.runBindings.find(
      (binding) => binding.messageId === user.messageId,
    )!.source,
    "turnStartReceipt",
  );
  if (content !== undefined) assert.equal(user.content, content);
  return user;
}
