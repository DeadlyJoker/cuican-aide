import { AgentKernelError, type KernelAgentEvent } from "@crewon/agent-kernel";
import type { ProviderCheckpoint } from "@crewon/contracts/runtime";

export type AgentSegmentImmediateAction =
  | Readonly<{
      kind: "checkpointProviderResponse";
      checkpoint: ProviderCheckpoint;
    }>
  | Readonly<{
      kind: "persistEvent";
      event: Extract<
        KernelAgentEvent,
        { type: "segment.started" | "rate_limit.updated" }
      >;
    }>
  | Readonly<{ kind: "none" }>;

/** Pure state machine for one kernel segment; callers own all durable writes. */
export class AgentSegmentStateMachine {
  output = "";
  completed = false;
  providerCheckpoint: ProviderCheckpoint | null = null;
  checkpointSequence: number | null = null;
  completedSequence: number | null = null;
  latestUsage:
    | Extract<KernelAgentEvent, { type: "usage.recorded" }>["data"]
    | null = null;
  lastAgentSequence = 0;
  checkpointEvent: Extract<
    KernelAgentEvent,
    { type: "segment.checkpointed" }
  > | null = null;
  readonly requestedTools: Extract<
    KernelAgentEvent,
    { type: "tool.requested" }
  >[] = [];
  readonly bufferedEvents: Exclude<
    KernelAgentEvent,
    { type: "segment.continuation_requested" }
  >[] = [];
  assistantContinuation: Extract<
    KernelAgentEvent,
    { type: "segment.continuation_requested" }
  > | null = null;
  providerTurnState: string | null;

  constructor(providerTurnState: string | null) {
    this.providerTurnState = providerTurnState;
  }

  accept(event: KernelAgentEvent): AgentSegmentImmediateAction {
    if (event.sequence !== this.lastAgentSequence + 1) {
      throw new AgentKernelError("segment_sequence_mismatch", false);
    }
    this.lastAgentSequence = event.sequence;
    if (event.type === "segment.provider_response_created") {
      this.providerCheckpoint = event.data.checkpoint;
      return {
        kind: "checkpointProviderResponse",
        checkpoint: event.data.checkpoint,
      };
    }
    if (event.type === "segment.checkpointed") {
      if (this.checkpointSequence !== null) {
        throw new AgentKernelError("segment_checkpoint_duplicate", false);
      }
      this.providerCheckpoint = event.data.checkpoint;
      this.checkpointSequence = event.sequence;
      this.checkpointEvent = event;
      return { kind: "none" };
    }
    if (event.type === "segment.completed") {
      if (event.data.output !== this.output) {
        throw new AgentKernelError("segment_output_mismatch", false);
      }
      this.completed = true;
      this.providerTurnState =
        event.data.providerTurnState ?? this.providerTurnState;
      this.completedSequence = event.sequence;
      return { kind: "none" };
    }
    if (event.type === "segment.continuation_requested") {
      this.providerTurnState =
        event.data.providerTurnState ?? this.providerTurnState;
      this.assistantContinuation = event;
      return { kind: "none" };
    }
    if (
      event.type === "segment.started" ||
      event.type === "rate_limit.updated"
    ) {
      return { kind: "persistEvent", event };
    }
    this.bufferedEvents.push(event);
    if (event.type === "tool.requested") {
      this.providerTurnState =
        event.data.providerTurnState ?? this.providerTurnState;
      this.requestedTools.push(event);
    }
    if (
      (event.type === "model.sampling.retry" ||
        event.type === "model.transport.fallback") &&
      event.data.discardedOutput
    ) {
      this.output = "";
    } else if (event.type === "model.output.delta") {
      this.output += event.data.delta;
    } else if (event.type === "usage.recorded") {
      this.latestUsage = event.data;
    }
    return { kind: "none" };
  }

  validateContinuation(): void {
    if (
      this.assistantContinuation !== null &&
      this.assistantContinuation.data.completedAssistantItems.join("") !==
        this.assistantContinuation.data.output
    ) {
      throw new AgentKernelError("segment_output_mismatch", false);
    }
  }
}
