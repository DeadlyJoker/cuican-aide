import { RunStoreError } from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";

export type WorkflowOutputRow = {
  role: string;
  content_digest: string;
  sequence: number;
  content_bytes: number;
  content: string | null;
  message_json: string | null;
};

export function workflowOutputMessageId(child: RunState): string {
  if (!child.outputRef?.startsWith("message:")) corrupt();
  return child.outputRef.slice("message:".length);
}

/** A bounded canonical message must have the same Run's completion evidence. */
export function decodeWorkflowRunOutput(
  child: RunState,
  row: WorkflowOutputRow | undefined,
  events: readonly { json: string | null }[],
): string {
  const messageId = workflowOutputMessageId(child);
  if (row && row.content_bytes > 32768)
    throw new RunStoreError("workflow_child_output_limit");
  if (
    !row ||
    row.content === null ||
    row.message_json === null ||
    row.role !== "assistant" ||
    workflowAdmissionDigest.sha256(row.content) !== row.content_digest
  )
    corrupt();
  const message = JSON.parse(row.message_json);
  if (
    message.tenantId !== child.tenantId ||
    message.threadId !== child.threadId ||
    message.messageId !== messageId ||
    message.role !== "assistant" ||
    message.sequence !== row.sequence ||
    message.content !== row.content ||
    message.contentDigest !== row.content_digest
  )
    corrupt();
  if (events.length > 8 || events.some((event) => event.json === null))
    corrupt();
  const evidence = events
    .map((event) => JSON.parse(event.json!))
    .filter(
      (event) =>
        event.type === "message.completed" &&
        event.identity?.runId === child.runId &&
        event.data?.messageId === messageId,
    );
  if (
    evidence.length !== 1 ||
    evidence[0].data.role !== "assistant" ||
    evidence[0].data.contentDigest !== row.content_digest ||
    evidence[0].data.messageSequence !== row.sequence
  )
    corrupt();
  return row.content;
}
function corrupt(): never {
  throw new RunStoreError("workflow_child_output_authority_corrupt");
}
