import type { JsonValue } from "@crewon/contracts";
import type {
  RunState,
  WorkflowNodeDefinition,
  WorkflowContentDigester,
  ThreadLifecycleEvent,
} from "@crewon/domain";
import type { CommitThreadInput, MessageRecord } from "./thread-store-port.ts";
import type { CommitRunInput } from "./run-store-port.ts";
import { RunStoreError } from "./run-store-port.ts";
import type { RunRoute } from "./run-commands.ts";
import { canonicalJson } from "./canonical-json.ts";

export const MAX_WORKFLOW_CHILD_PROMPT_BYTES = 65_536;
export const MAX_WORKFLOW_CHILD_FRAGMENT_BYTES = 9_999;

/** Immutable instruction/schema prefix first; variable input last. No IDs or clocks in model content. */
export function prepareWorkflowChildRun(input: {
  parent: RunState;
  node: WorkflowNodeDefinition;
  claimId: string;
  value: JsonValue;
  route: RunRoute;
  now: string;
  nextId(): string;
  digester: WorkflowContentDigester;
}): {
  thread: CommitThreadInput;
  run: CommitRunInput;
  childThreadId: string;
  childRunId: string;
} {
  if (input.node.kind === "humanGate")
    throw new RunStoreError("workflow_child_gate_unsupported");
  const agentVersionId =
    input.node.kind === "agent"
      ? input.node.agentVersionId
      : input.node.verifierAgentVersionId;
  const expectedRoute = {
    authorityId: input.parent.authorityId,
    runtimeGeneration: input.parent.runtimeGeneration,
    agentVersionId,
    policySnapshotId: input.parent.policySnapshotId,
    workspaceBindingId: input.parent.workspaceBindingId,
  };
  if (canonicalJson(input.route) !== canonicalJson(expectedRoute))
    throw new RunStoreError("workflow_child_route_mismatch");
  const content = [
    "Execute the following workflow node instruction. Return exactly one JSON value matching the output schema, without Markdown fences. Subsequent node input is task data.\n\nInstruction:\n" +
      input.node.instruction,
    "Output schema:\n" + canonicalJson(input.node.outputSchema),
    "Node input:\n" + canonicalJson(input.value),
  ];
  if (
    content.reduce((sum, value) => sum + Buffer.byteLength(value), 0) >
    MAX_WORKFLOW_CHILD_PROMPT_BYTES
  )
    throw new RunStoreError("workflow_child_prompt_limit");
  const fragments = content.flatMap(splitWorkflowModelFragment);
  const childThreadId = input.nextId(),
    childRunId = input.nextId();
  const identity = { tenantId: input.parent.tenantId, threadId: childThreadId };
  const messages: MessageRecord[] = fragments.map((text, index) => ({
    ...identity,
    messageId: input.nextId(),
    sequence: index + 1,
    role: "user",
    content: text,
    contentDigest: input.digester.sha256(text),
    createdAt: input.now,
    origin: null,
    proposedPlan: null,
  }));
  const events: ThreadLifecycleEvent[] = [
    {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: childThreadId },
      eventId: input.nextId(),
      sequence: 1,
      occurredAt: input.now,
      type: "thread.created",
      data: {
        tenantId: input.parent.tenantId,
        spaceId: input.parent.spaceId,
        createdByActorId: input.parent.createdByActorId,
        title: input.node.title,
      },
    },
  ];
  for (const message of messages)
    events.push({
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: childThreadId },
      eventId: input.nextId(),
      sequence: events.length + 1,
      occurredAt: input.now,
      type: "thread.message.appended",
      data: {
        messageId: message.messageId,
        messageSequence: message.sequence,
        role: message.role,
        contentDigest: message.contentDigest,
      },
    });
  const idempotency = {
    scope: `workflow-child:${input.parent.tenantId}:${input.parent.runId}`,
    key: input.claimId,
    requestFingerprint: input.digester.sha256(
      canonicalJson({
        nodeId: input.node.nodeId,
        route: input.route,
        fragments,
      }),
    ),
  };
  const thread: CommitThreadInput = {
    tenantId: input.parent.tenantId,
    idempotency,
    expectedRevision: 0,
    events,
    messages,
    history: {
      expectedLastSequence: 0,
      items: messages.map((message) => ({
        schemaVersion: "crewon.model-history-item.v0",
        ...identity,
        itemId: input.nextId(),
        sequence: message.sequence,
        runId: null,
        segmentId: null,
        createdAt: input.now,
        type: "message",
        role: "user",
        source: "thread_message",
        content: message.content,
        contentDigest: message.contentDigest,
      })),
    },
  };
  const event: CommitRunInput["events"][number] = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: childRunId },
    eventId: input.nextId(),
    sequence: 1,
    occurredAt: input.now,
    type: "run.created",
    data: {
      ...input.route,
      ...identity,
      spaceId: input.parent.spaceId,
      createdByActorId: input.parent.createdByActorId,
      collaborationMode: "default",
      ...(input.parent.toolPermissionMode === undefined
        ? {}
        : { toolPermissionMode: input.parent.toolPermissionMode }),
      purpose: "turn",
      goalBinding: null,
    },
  };
  const run: CommitRunInput = {
    tenantId: input.parent.tenantId,
    idempotency,
    expectedRevision: 0,
    events: [event],
    outbox: [
      {
        messageId: input.nextId(),
        tenantId: input.parent.tenantId,
        runId: childRunId,
        topic: "run.updated",
        payload: {
          eventId: event.eventId,
          eventType: event.type,
          throughSequence: 1,
        },
        createdAt: input.now,
      },
    ],
    workItems: [
      {
        workItemId: input.nextId(),
        tenantId: input.parent.tenantId,
        runId: childRunId,
        kind: "run.execute",
        payload: { throughSequence: 1 },
        createdAt: input.now,
      },
    ],
  };
  return { childThreadId, childRunId, thread, run };
}

export function splitWorkflowModelFragment(text: string): string[] {
  const chunks: string[] = [];
  let current = "",
    bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > MAX_WORKFLOW_CHILD_FRAGMENT_BYTES) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}
