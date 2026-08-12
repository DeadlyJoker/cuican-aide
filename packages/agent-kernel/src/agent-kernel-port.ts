import type {
  CanonicalAgentEvent,
  ProviderCheckpoint,
  RateLimitSnapshot,
} from "@crewon/contracts";
import type { ToolCallKind, ToolDefinition } from "@crewon/tool-broker";

export type AgentHistoryItem =
  | Readonly<{
      type: "message";
      role: "user" | "assistant" | "developer" | "system";
      content: string;
    }>
  | Readonly<{
      type: "tool_call";
      kind: ToolCallKind;
      callId: string;
      name: string;
      input: string;
    }>
  | Readonly<{
      type: "tool_result";
      kind: ToolCallKind;
      callId: string;
      output: string;
    }>;

export type AgentContinuation =
  | Readonly<{ kind: "manual" }>
  | Readonly<{
      kind: "providerCheckpoint";
      checkpoint: ProviderCheckpoint;
      newHistoryStartIndex: number;
    }>;

export type AgentSegmentContract = Readonly<{
  schemaVersion: "crewon.agent-segment.v0";
  purpose: "agent" | "compaction";
  runId: string;
  segmentId: string;
  attempt: number;
  agentVersionId: string;
  policySnapshotId: string;
  collaborationMode: "default" | "plan";
  allowedTools:
    | readonly Readonly<{
        kind: ToolCallKind;
        name: string;
      }>[]
    | null;
  runtimeTools?: readonly ToolDefinition[];
  history: readonly AgentHistoryItem[];
  continuation: AgentContinuation;
  reconcileCheckpoint?: ProviderCheckpoint;
  /** Run-private continuation control state; never projected into history. */
  providerTurnState?: string;
  budget: Readonly<{
    maxOutputBytes: number;
  }>;
}>;

type KernelEventBase = Omit<CanonicalAgentEvent, "type" | "data">;

export type KernelAgentEvent =
  | (KernelEventBase & {
      type: "segment.provider_response_created";
      data: Readonly<{ checkpoint: ProviderCheckpoint }>;
    })
  | (KernelEventBase & {
      type: "segment.started";
      data: Readonly<{ attempt: number; model: string }>;
    })
  | (KernelEventBase & {
      type: "model.sampling.retry";
      data: Readonly<{
        samplingAttempt: number;
        maxRetries: number;
        code: string;
        discardedOutput: boolean;
      }>;
    })
  | (KernelEventBase & {
      type: "model.output.delta";
      data: Readonly<{ delta: string }>;
    })
  | (KernelEventBase & {
      type: "model.reasoning.summary";
      data:
        | Readonly<{ kind: "delta"; summaryIndex: number; delta: string }>
        | Readonly<{ kind: "partAdded"; summaryIndex: number }>;
    })
  | (KernelEventBase & {
      type: "model.transport.fallback";
      data: Readonly<{
        fromTransport: string;
        toTransport: string;
        code: string;
        discardedOutput: boolean;
      }>;
    })
  | (KernelEventBase & {
      type: "tool.requested";
      data: Readonly<{
        callId: string;
        kind: ToolCallKind;
        name: string;
        input: string;
        /** Completed assistant items that precede this Tool boundary. */
        completedAssistantItems?: string[];
        /** Run-private continuation control state; excluded from RunEvent projection. */
        providerTurnState?: string | null;
      }>;
    })
  | (KernelEventBase & {
      type: "tool.completed";
      data: Readonly<{
        callId: string;
        kind: ToolCallKind;
        name: string;
        output: string;
        isError: boolean;
        artifactRef: string | null;
        outputTruncated: boolean;
      }>;
    })
  | (KernelEventBase & {
      type: "rate_limit.updated";
      data: Readonly<{ snapshot: RateLimitSnapshot }>;
    })
  | (KernelEventBase & {
      type: "usage.recorded";
      data: Readonly<{
        inputTokens: number;
        /** Normalized to zero at the Provider transport boundary when absent. */
        cachedInputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }>;
    })
  | (KernelEventBase & {
      type: "segment.checkpointed";
      data: Readonly<{ checkpoint: ProviderCheckpoint }>;
    })
  | (KernelEventBase & {
      type: "segment.completed";
      data: Readonly<{ output: string; providerTurnState?: string | null }>;
    })
  | (KernelEventBase & {
      type: "segment.continuation_requested";
      data: Readonly<{
        output: string;
        completedAssistantItems: string[];
        checkpoint: ProviderCheckpoint | null;
        providerTurnState?: string | null;
      }>;
    })
  | (KernelEventBase & {
      type: "segment.failed";
      data: Readonly<{ code: string; retryable: boolean }>;
    });

/**
 * Runs one bounded Agent segment and yields only canonical CrewON events.
 *
 * A segment may end after `tool.requested` (and an optional checkpoint) without
 * `segment.completed`; that is the durable Tool boundary owned by the Worker.
 */
export interface AgentKernelPort {
  readonly modelIdentity: Readonly<{
    adapterName: string;
    adapterVersion: string;
    modelId: string;
  }>;
  runSegment(
    contract: AgentSegmentContract,
    signal: AbortSignal,
    options?: AgentSegmentRunOptions,
  ): AsyncIterable<KernelAgentEvent>;
}

/** Private control sink that is never projected into canonical Agent events. */
export interface AgentSegmentControlSink {
  providerTurnStateObserved(providerTurnState: string): Promise<void>;
}

export type AgentSegmentRunOptions = Readonly<{
  controlSink?: AgentSegmentControlSink;
}>;

/** Waits between same-Turn sampling attempts and remains abortable. */
export interface SamplingRetryScheduler {
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export class AgentKernelError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: string,
    retryable: boolean,
    options?: ErrorOptions & { retryAfterMs?: number },
  ) {
    super(code, options);
    this.name = "AgentKernelError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = options?.retryAfterMs;
  }
}
