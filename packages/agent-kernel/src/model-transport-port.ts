import type { ProviderCheckpoint, RateLimitSnapshot } from "@crewon/contracts";
import type { ToolCallKind, ToolDefinition } from "@crewon/tool-broker";
import type { AgentHistoryItem } from "./agent-kernel-port.ts";

export type ModelInputItem = AgentHistoryItem;

export type ModelInput =
  | Readonly<{
      strategy: "manual";
      items: readonly ModelInputItem[];
    }>
  | Readonly<{
      strategy: "providerCheckpoint";
      checkpoint: ProviderCheckpoint;
      items: readonly ModelInputItem[];
      newHistoryStartIndex: number;
    }>;

export type ModelRequest = Readonly<{
  schemaVersion: "crewon.model-request.v0";
  runId: string;
  segmentId: string;
  agentVersionId: string;
  instructions: string | null;
  input: ModelInput;
  tools: readonly ToolDefinition[];
  maxOutputBytes: number;
  reconcileCheckpoint?: ProviderCheckpoint;
}>;

export type ModelTransportEvent =
  | Readonly<{ type: "response.created"; checkpoint: ProviderCheckpoint }>
  | Readonly<{ type: "output.delta"; delta: string }>
  | Readonly<{ type: "output.item.completed"; item: ModelInputItem }>
  | Readonly<{
      type: "usage";
      inputTokens: number;
      /** Defaults to zero for legacy Provider transports. */
      cachedInputTokens?: number;
      outputTokens: number;
      totalTokens: number;
    }>
  | Readonly<{ type: "rate_limit"; snapshot: RateLimitSnapshot }>
  | Readonly<{
      type: "tool.call";
      kind: ToolCallKind;
      callId: string;
      name: string;
      input: string;
    }>
  | Readonly<{
      type: "transport.fallback";
      fromTransport: string;
      toTransport: string;
      code: string;
      discardedOutput: boolean;
    }>
  | Readonly<{
      type: "completed";
      checkpoint: ProviderCheckpoint | null;
    }>
  | Readonly<{ type: "failed"; code: string; retryable: boolean }>;

/** Transports one bounded model request without owning Agent state. */
export interface ModelTransportPort {
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly modelId: string;
  readonly supportsResponseRetrieve?: boolean;
  prewarm?(signal: AbortSignal): Promise<void>;
  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelTransportEvent>;
  close?(): Promise<void>;
}

export type ModelTransportErrorCategory =
  | "authentication"
  | "permission"
  | "rateLimit"
  | "invalidRequest"
  | "notFound"
  | "timeout"
  | "unavailable"
  | "protocol"
  | "incomplete"
  | "canceled";

/** A provider-safe transport failure that never exposes a raw response body. */
export class ModelTransportError extends Error {
  readonly category: ModelTransportErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(options: {
    category: ModelTransportErrorCategory;
    code: string;
    retryable: boolean;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(options.code, { cause: options.cause });
    this.name = "ModelTransportError";
    this.category = options.category;
    this.code = options.code;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}
