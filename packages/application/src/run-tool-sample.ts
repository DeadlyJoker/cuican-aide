import {
  parseCanonicalAgentEvent,
  parseProviderCheckpoint,
  type CanonicalAgentEvent,
  type ProviderCheckpoint,
} from "@crewon/contracts";
import type { ModelHistoryItem, RunState } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import type {
  CommitToolSampleInput,
  RunAttemptIdentity,
  ThreadContinuationLocator,
  ThreadModelState,
} from "./run-execution-store-port.ts";
import {
  executionIdempotency,
  leaseInput,
  mapAgentEvent,
  requireBoundedContent,
  validateModelIdentity,
} from "./run-execution-support.ts";

export type ToolSampleCommitRequest = Readonly<{
  segmentId: string;
  events: readonly CanonicalAgentEvent[];
  identity: Omit<ThreadContinuationLocator, "tenantId" | "threadId">;
  contextRevision: string;
  modelPolicy: Readonly<{
    contextWindowTokens: number;
    autoCompactAtTokens: number | null;
  }>;
  latestUsage: ThreadModelState["latestUsage"];
  checkpoint: ProviderCheckpoint | null;
  providerTurnState: string | null;
}>;

export function prepareToolSampleCommit(input: {
  state: RunState;
  claim: WorkItemClaim;
  attempt: RunAttemptIdentity;
  sample: ToolSampleCommitRequest;
  historySequence: number;
  occurredAt: string;
  nextId: (kind: "runEvent" | "modelHistoryItem" | "outboxMessage") => string;
  digest: (value: string) => string;
}): CommitToolSampleInput {
  const { state, sample, occurredAt, digest } = input;
  validateModelIdentity(sample.identity);
  if (
    sample.identity.agentVersionId !== state.agentVersionId ||
    sample.events.length < 2 ||
    sample.events.length > 256
  )
    invalid();
  const checkpoint =
    sample.checkpoint === null
      ? null
      : parseProviderCheckpoint(sample.checkpoint);
  if (
    checkpoint !== null &&
    (checkpoint.adapterName !== sample.identity.adapterName ||
      checkpoint.adapterVersion !== sample.identity.adapterVersion ||
      checkpoint.modelId !== sample.identity.modelId)
  )
    invalid();
  const historyItems: ModelHistoryItem[] = [];
  let lastSequence = 0;
  let calls = 0;
  let checkpointCount = 0;
  const checkpointDigest =
    checkpoint === null ? null : digest(canonicalJson(checkpoint));
  const events = sample.events.map((event, index) => {
    parseCanonicalAgentEvent(event);
    if (
      event.runId !== state.runId ||
      event.segmentId !== sample.segmentId ||
      event.sequence <= lastSequence
    )
      invalid();
    lastSequence = event.sequence;
    if (index === sample.events.length - 1) {
      if (event.type !== "segment.completed" || event.data.output !== "")
        invalid();
    } else if (
      ![
        "tool.requested",
        "usage.recorded",
        "model.reasoning.summary",
        "segment.checkpointed",
      ].includes(event.type)
    )
      invalid();
    const base = () => ({
      schemaVersion: "crewon.model-history-item.v0" as const,
      itemId: input.nextId("modelHistoryItem"),
      tenantId: state.tenantId,
      threadId: state.threadId,
      runId: state.runId,
      segmentId: sample.segmentId,
      sequence: input.historySequence + historyItems.length + 1,
      createdAt: occurredAt,
    });
    if (event.type === "tool.requested") {
      if (++calls > 16) invalid();
      const {
        kind,
        callId,
        name,
        input: toolInput,
        completedAssistantItems = [],
      } = event.data;
      if (
        (kind !== "function" && kind !== "custom") ||
        typeof callId !== "string" ||
        typeof name !== "string" ||
        typeof toolInput !== "string" ||
        !Array.isArray(completedAssistantItems)
      )
        invalid();
      for (const content of completedAssistantItems) {
        if (typeof content !== "string" || calls !== 1) invalid();
        requireBoundedContent(content);
        historyItems.push({
          ...base(),
          type: "message",
          role: "assistant",
          source: "assistant_completion",
          content,
          contentDigest: digest(content),
        });
      }
      historyItems.push({
        ...base(),
        type: "tool_call",
        kind,
        callId,
        name,
        input: toolInput,
      });
    }
    if (event.type === "segment.checkpointed") {
      if (
        ++checkpointCount !== 1 ||
        checkpoint === null ||
        canonicalJson(event.data.checkpoint) !== canonicalJson(checkpoint) ||
        index !== sample.events.length - 2
      )
        invalid();
    }
    return mapAgentEvent(
      event,
      state.lastSequence + index + 1,
      input.nextId("runEvent"),
      occurredAt,
      (value) => digest(canonicalJson(value)),
    );
  });
  if (calls === 0 || checkpointCount !== (checkpoint === null ? 0 : 1))
    invalid();
  const throughHistorySequence = historyItems.at(-1)!.sequence;
  const continuation =
    checkpoint === null
      ? null
      : {
          tenantId: state.tenantId,
          threadId: state.threadId,
          ...sample.identity,
          throughHistorySequence,
          contextRevision: sample.contextRevision,
          checkpoint,
          updatedAt: occurredAt,
        };
  const modelState: ThreadModelState = {
    schemaVersion: "crewon.thread-model-state.v0",
    tenantId: state.tenantId,
    threadId: state.threadId,
    ...sample.identity,
    ...sample.modelPolicy,
    throughHistorySequence,
    contextRevision: sample.contextRevision,
    latestUsage: sample.latestUsage,
    updatedAt: occurredAt,
  };
  // The receipt retains a bounded semantic digest, not another copy of tool arguments.
  const semantic = {
    sample,
    attempt: input.attempt,
    historySequence: input.historySequence,
  };
  return {
    lease: leaseInput(input.claim),
    commit: {
      tenantId: state.tenantId,
      expectedRevision: state.revision,
      idempotency: executionIdempotency(
        state,
        input.claim.workItem,
        `tool-sample:${sample.segmentId}`,
        {
          schemaVersion: "crewon.tool-sample-fingerprint.v0",
          digest: digest(canonicalJson(semantic)),
        },
      ),
      events,
      outbox: events.map((event) => ({
        messageId: input.nextId("outboxMessage"),
        tenantId: state.tenantId,
        runId: state.runId,
        topic: "run.updated",
        payload: {
          eventId: event.eventId,
          eventType: event.type,
          throughSequence: event.sequence,
        },
        createdAt: occurredAt,
      })),
      workItems: [],
    },
    history: {
      expectedLastSequence: input.historySequence,
      items: historyItems,
    },
    modelState,
    continuation,
    attempt: {
      ...input.attempt,
      finishedAt: occurredAt,
      checkpointDigest,
      providerTurnState: sample.providerTurnState,
    },
  };
}

function invalid(): never {
  throw new ApplicationError("validation", "tool_sample_commit_invalid");
}
