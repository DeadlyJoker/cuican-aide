import type { ModelInputItem, ModelTransportEvent } from "@crewon/agent-kernel";
import type { ProviderCheckpoint } from "@crewon/contracts";

import { protocolError, transportError } from "./responses-errors.ts";
import { parseResponsesSse } from "./responses-sse.ts";

const MAX_RESPONSE_ID_LENGTH = 512;
const MAX_REASONING_DELTA_BYTES = 16 * 1024;
const MAX_REASONING_BYTES = 64 * 1024;
const MAX_PENDING_OUTPUT_WHITESPACE_BYTES = 1024;

export type ResponsesSequencePolicy = "required" | "whenPresent";
export type ResponsesIdentityPolicy = "strict" | "terminalAuthoritative";
export type ResponsesFinalOutputPolicy =
  | "strict"
  | "streamAuthoritativeWhenEmpty";

export type ResponsesProtocolOptions = Readonly<{
  sequencePolicy: ResponsesSequencePolicy;
  identityPolicy?: ResponsesIdentityPolicy;
  finalOutputPolicy?: ResponsesFinalOutputPolicy;
  completedCheckpoint: (responseId: string) => ProviderCheckpoint | null;
  createdCheckpoint?: (responseId: string) => ProviderCheckpoint | null;
}>;

/** Decodes one Responses event stream independently of its HTTP or WebSocket framing. */
export class ResponsesProtocolDecoder {
  readonly #options: ResponsesProtocolOptions;
  #lastSequence = -1;
  #created = false;
  #responseId: string | null = null;
  #output = "";
  #pendingOutputWhitespace = "";
  #terminal = false;
  #completedHistoryItems: ModelInputItem[] = [];
  #reasoningBytes = 0;

  constructor(options: ResponsesProtocolOptions) {
    this.#options = options;
  }

  get terminal(): boolean {
    return this.#terminal;
  }

  get completedResponseId(): string | null {
    return this.#terminal ? this.#responseId : null;
  }

  get completedHistoryItems(): readonly ModelInputItem[] {
    return this.#completedHistoryItems.map((item) => ({ ...item }));
  }

  accept(value: unknown): readonly ModelTransportEvent[] {
    const event = requireObject(value, "responses_event_invalid");
    if (this.#terminal) {
      throw protocolError("responses_event_after_terminal");
    }
    this.#lastSequence = validateSequence(
      event.sequence_number,
      this.#lastSequence,
      this.#options.sequencePolicy,
    );
    const type = requireString(event.type, "responses_event_type_invalid");
    switch (type) {
      case "response.created": {
        if (this.#created) {
          throw protocolError("responses_created_duplicate");
        }
        this.#created = true;
        this.#responseId = optionalResponseIdentity(event);
        if (this.#responseId === null) {
          return [];
        }
        const checkpoint =
          this.#options.createdCheckpoint?.(this.#responseId) ?? null;
        return checkpoint === null
          ? []
          : [{ type: "response.created", checkpoint }];
      }
      case "response.output_text.delta": {
        requireCreated(this.#created);
        if (
          typeof event.delta === "string" &&
          event.delta.trim().length === 0
        ) {
          this.#pendingOutputWhitespace += event.delta;
          if (
            new TextEncoder().encode(this.#pendingOutputWhitespace).byteLength >
            MAX_PENDING_OUTPUT_WHITESPACE_BYTES
          ) {
            throw protocolError("responses_delta_invalid");
          }
          return [];
        }
        const delta = requireString(event.delta, "responses_delta_invalid");
        const combined = `${this.#pendingOutputWhitespace}${delta}`;
        this.#pendingOutputWhitespace = "";
        this.#output += combined;
        return [{ type: "output.delta", delta: combined }];
      }
      case "response.completed": {
        requireCreated(this.#created);
        this.#flushPendingOutputWhitespace();
        const response = terminalResponse(
          event.response,
          this.#responseId,
          "responses_completed_response_invalid",
          this.#options.identityPolicy ?? "strict",
        );
        this.#responseId = response.id;
        requireStatus(response, "completed");
        if (
          response.end_turn !== undefined &&
          typeof response.end_turn !== "boolean"
        ) {
          throw protocolError("responses_end_turn_invalid");
        }
        if (response.output !== undefined) {
          validateFinalOutput(
            response.output,
            this.#output,
            this.#options.finalOutputPolicy ?? "strict",
          );
        }
        if (
          this.#output.length > 0 &&
          !this.#completedHistoryItems.some((item) => item.type === "message")
        ) {
          this.#completedHistoryItems.push({
            type: "message",
            role: "assistant",
            content: this.#output,
          });
        }
        const usage = parseUsage(response.usage);
        this.#terminal = true;
        const completed: ModelTransportEvent = {
          type: "completed",
          checkpoint: this.#options.completedCheckpoint(this.#responseId),
          ...(response.end_turn === false ? { endTurn: false } : {}),
        };
        return usage === null
          ? [completed]
          : [{ type: "usage", ...usage }, completed];
      }
      case "response.failed": {
        const response = failureResponse(
          event.response,
          this.#responseId,
          "responses_failed_response_invalid",
          this.#options.identityPolicy ?? "strict",
        );
        requireOptionalStatus(response, "failed");
        const failure = parseStreamFailure(response);
        this.#terminal = true;
        return [{ type: "failed", ...failure }];
      }
      case "response.incomplete": {
        const response = failureResponse(
          event.response,
          this.#responseId,
          "responses_incomplete_response_invalid",
          this.#options.identityPolicy ?? "strict",
        );
        requireOptionalStatus(response, "incomplete");
        const failure = parseIncomplete(response);
        this.#terminal = true;
        return [{ type: "failed", ...failure }];
      }
      case "error": {
        const failure = parseProviderError(event);
        this.#terminal = true;
        return [{ type: "failed", ...failure }];
      }
      case "response.output_item.done": {
        requireCreated(this.#created);
        const outputItem = requireObject(
          event.item,
          "responses_output_item_invalid",
        );
        if (outputItem.type === "message") {
          this.#flushPendingOutputWhitespace();
          const content = completedAssistantMessageContent(outputItem);
          if (content !== this.#output) {
            throw protocolError("responses_final_output_mismatch");
          }
          const item = {
            type: "message" as const,
            role: "assistant" as const,
            content,
          };
          this.#completedHistoryItems.push(item);
          return [{ type: "output.item.completed", item }];
        }
        if (outputItem.type === "reasoning") {
          return [];
        }
        if (
          outputItem.type !== "function_call" &&
          outputItem.type !== "custom_tool_call"
        ) {
          throw protocolError("responses_output_item_unsupported");
        }
        const kind: "function" | "custom" =
          outputItem.type === "function_call" ? "function" : "custom";
        const call = {
          type: "tool.call" as const,
          kind,
          callId: boundedNonEmpty(
            outputItem.call_id,
            512,
            "responses_tool_call_id_invalid",
          ),
          name: boundedNonEmpty(
            outputItem.name,
            128,
            "responses_tool_name_invalid",
          ),
          input: boundedString(
            kind === "function" ? outputItem.arguments : outputItem.input,
            32 * 1024,
            "responses_tool_input_invalid",
          ),
        };
        const item = {
          type: "tool_call",
          kind: call.kind,
          callId: call.callId,
          name: call.name,
          input: call.input,
        } as const;
        this.#completedHistoryItems.push(item);
        return [{ type: "output.item.completed", item }];
      }
      case "response.in_progress":
      case "response.output_item.added":
      case "response.content_part.added":
      case "response.content_part.done":
      case "response.output_text.done":
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
      case "response.custom_tool_call_input.delta":
      case "response.custom_tool_call_input.done":
        requireCreated(this.#created);
        return [];
      case "response.reasoning_summary_text.delta":
        requireCreated(this.#created);
        return [
          this.#reasoningDelta("summary", event.summary_index, event.delta),
        ];
      case "response.reasoning_text.delta":
        requireCreated(this.#created);
        return [
          this.#reasoningDelta("content", event.content_index, event.delta),
        ];
      case "response.reasoning_summary_part.added":
        requireCreated(this.#created);
        return [
          {
            type: "reasoning.part.added",
            channel: "summary",
            index: reasoningIndex(event.summary_index),
          },
        ];
      default:
        return [];
    }
  }

  #flushPendingOutputWhitespace(): void {
    if (this.#output.length > 0) {
      this.#output += this.#pendingOutputWhitespace;
    }
    this.#pendingOutputWhitespace = "";
  }

  finish(): void {
    if (!this.#terminal) {
      throw transportError("unavailable", "responses_stream_incomplete", true);
    }
  }

  #reasoningDelta(
    channel: "summary" | "content",
    indexValue: unknown,
    deltaValue: unknown,
  ): ModelTransportEvent {
    const delta = boundedString(
      deltaValue,
      MAX_REASONING_DELTA_BYTES,
      "responses_reasoning_delta_invalid",
    );
    this.#reasoningBytes += new TextEncoder().encode(delta).byteLength;
    if (this.#reasoningBytes > MAX_REASONING_BYTES) {
      throw protocolError("responses_reasoning_budget_exceeded");
    }
    return {
      type: "reasoning.delta",
      channel,
      index: reasoningIndex(indexValue),
      delta,
    };
  }
}

function reasoningIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw protocolError("responses_reasoning_index_invalid");
  }
  return Number(value);
}

function completedAssistantMessageContent(
  item: Readonly<Record<string, unknown>>,
): string {
  if (item.role !== "assistant" || !Array.isArray(item.content)) {
    throw protocolError("responses_output_message_invalid");
  }
  return item.content
    .map((part) => {
      const content = requireObject(part, "responses_output_message_invalid");
      if (content.type !== "output_text") {
        throw protocolError("responses_output_message_invalid");
      }
      return requireString(content.text, "responses_output_message_invalid");
    })
    .join("");
}

export async function* responsesProtocolEvents(
  body: ReadableStream<Uint8Array>,
  options: {
    sequencePolicy: ResponsesSequencePolicy;
    identityPolicy?: ResponsesIdentityPolicy;
    finalOutputPolicy?: ResponsesFinalOutputPolicy;
    outputDeltaFlushBytes?: number;
    onActivity: () => void;
    completedCheckpoint: (responseId: string) => ProviderCheckpoint | null;
    createdCheckpoint?: (responseId: string) => ProviderCheckpoint | null;
  },
): AsyncIterable<ModelTransportEvent> {
  const decoder = new ResponsesProtocolDecoder(options);
  const outputDeltaFlushBytes = options.outputDeltaFlushBytes;
  let pendingOutputDelta = "";
  for await (const item of parseResponsesSse(body, {
    onActivity: options.onActivity,
  })) {
    if (item.kind === "done") {
      if (!decoder.terminal) {
        throw protocolError("responses_done_before_terminal");
      }
      continue;
    }
    for (const event of decoder.accept(item.value)) {
      if (
        outputDeltaFlushBytes !== undefined &&
        event.type === "output.delta"
      ) {
        if (
          pendingOutputDelta.length > 0 &&
          byteLength(`${pendingOutputDelta}${event.delta}`) >
            outputDeltaFlushBytes
        ) {
          yield { type: "output.delta", delta: pendingOutputDelta };
          pendingOutputDelta = "";
        }
        pendingOutputDelta += event.delta;
        if (byteLength(pendingOutputDelta) >= outputDeltaFlushBytes) {
          yield { type: "output.delta", delta: pendingOutputDelta };
          pendingOutputDelta = "";
        }
        continue;
      }
      if (pendingOutputDelta.length > 0) {
        yield { type: "output.delta", delta: pendingOutputDelta };
        pendingOutputDelta = "";
      }
      yield event;
    }
  }
  if (pendingOutputDelta.length > 0) {
    yield { type: "output.delta", delta: pendingOutputDelta };
  }
  decoder.finish();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateSequence(
  value: unknown,
  previous: number,
  policy: ResponsesSequencePolicy,
): number {
  if (value === undefined && policy === "whenPresent") {
    return previous;
  }
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) <= previous
  ) {
    throw protocolError("responses_sequence_invalid");
  }
  return Number(value);
}

function optionalResponseIdentity(
  event: Readonly<Record<string, unknown>>,
): string | null {
  const response = requireObject(
    event.response,
    "responses_created_response_invalid",
  );
  if (response.id === undefined) {
    return null;
  }
  return boundedNonEmpty(
    response.id,
    MAX_RESPONSE_ID_LENGTH,
    "responses_response_id_invalid",
  );
}

function requireCreated(created: boolean): asserts created is true {
  if (!created) {
    throw protocolError("responses_created_missing");
  }
}

function terminalResponse(
  value: unknown,
  expectedId: string | null,
  code: string,
  identityPolicy: ResponsesIdentityPolicy,
): Readonly<Record<string, unknown>> & { readonly id: string } {
  const response = requireObject(value, code);
  const responseId = boundedNonEmpty(
    response.id,
    MAX_RESPONSE_ID_LENGTH,
    "responses_response_id_invalid",
  );
  if (
    identityPolicy === "strict" &&
    expectedId !== null &&
    responseId !== expectedId
  ) {
    throw protocolError("responses_response_id_mismatch");
  }
  return { ...response, id: responseId };
}

function failureResponse(
  value: unknown,
  expectedId: string | null,
  code: string,
  identityPolicy: ResponsesIdentityPolicy,
): Readonly<Record<string, unknown>> {
  const response = value === undefined ? {} : requireObject(value, code);
  if (response.id !== undefined) {
    const responseId = boundedNonEmpty(
      response.id,
      MAX_RESPONSE_ID_LENGTH,
      "responses_response_id_invalid",
    );
    if (
      identityPolicy === "strict" &&
      expectedId !== null &&
      responseId !== expectedId
    ) {
      throw protocolError("responses_response_id_mismatch");
    }
  }
  return response;
}

function parseUsage(value: unknown): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null {
  if (value === undefined || value === null) {
    return null;
  }
  const usage = requireObject(value, "responses_usage_missing");
  const inputTokens = nonNegativeInteger(
    usage.input_tokens,
    "responses_input_tokens_invalid",
  );
  const cachedInputTokens = parseCachedInputTokens(usage.input_tokens_details);
  if (cachedInputTokens > inputTokens) {
    throw protocolError("responses_cached_input_tokens_exceeds_input");
  }
  const result = {
    inputTokens,
    cachedInputTokens,
    outputTokens: nonNegativeInteger(
      usage.output_tokens,
      "responses_output_tokens_invalid",
    ),
    totalTokens: nonNegativeInteger(
      usage.total_tokens,
      "responses_total_tokens_invalid",
    ),
  };
  if (result.totalTokens !== result.inputTokens + result.outputTokens) {
    throw protocolError("responses_usage_total_mismatch");
  }
  return result;
}

function parseCachedInputTokens(value: unknown): number {
  if (value === undefined) return 0;
  const details = requireObject(
    value,
    "responses_input_tokens_details_invalid",
  );
  return details.cached_tokens === undefined
    ? 0
    : nonNegativeInteger(
        details.cached_tokens,
        "responses_cached_input_tokens_invalid",
      );
}

function validateFinalOutput(
  value: unknown,
  streamed: string,
  policy: ResponsesFinalOutputPolicy,
): void {
  if (!Array.isArray(value)) {
    throw protocolError("responses_output_invalid");
  }
  if (policy === "streamAuthoritativeWhenEmpty" && value.length === 0) {
    return;
  }
  const finalText = value
    .flatMap((item) => {
      if (
        !isPlainObject(item) ||
        item.type !== "message" ||
        !Array.isArray(item.content)
      ) {
        return [];
      }
      return item.content.flatMap((content) =>
        isPlainObject(content) &&
        content.type === "output_text" &&
        typeof content.text === "string"
          ? [content.text]
          : [],
      );
    })
    .join("");
  if (finalText !== streamed) {
    throw protocolError("responses_output_mismatch");
  }
}

function requireStatus(
  response: Readonly<Record<string, unknown>>,
  expected: string,
): void {
  if (response.status !== expected) {
    throw protocolError("responses_status_invalid");
  }
}

function requireOptionalStatus(
  response: Readonly<Record<string, unknown>>,
  expected: string,
): void {
  if (response.status !== undefined) {
    requireStatus(response, expected);
  }
}

function parseStreamFailure(response: Readonly<Record<string, unknown>>): {
  code: string;
  retryable: boolean;
} {
  return providerFailure(
    isPlainObject(response.error) ? response.error.code : undefined,
  );
}

function parseIncomplete(response: Readonly<Record<string, unknown>>): {
  code: string;
  retryable: boolean;
} {
  const details = isPlainObject(response.incomplete_details)
    ? response.incomplete_details
    : {};
  const reason = safeProviderCode(details.reason, "unknown");
  return {
    code: `responses_incomplete_${reason}`,
    retryable: reason !== "max_output_tokens" && reason !== "content_filter",
  };
}

function parseProviderError(value: Readonly<Record<string, unknown>>): {
  code: string;
  retryable: boolean;
} {
  const nested = isPlainObject(value.error) ? value.error : value;
  return providerFailure(nested.code);
}

function providerFailure(value: unknown): {
  code: string;
  retryable: boolean;
} {
  const providerCode = safeProviderCode(value);
  return {
    code: `responses_provider_${providerCode}`,
    retryable: ![
      "context_length_exceeded",
      "insufficient_quota",
      "usage_not_included",
      "invalid_prompt",
      "cyber_policy",
      "server_is_overloaded",
      "slow_down",
    ].includes(providerCode),
  };
}

function safeProviderCode(value: unknown, fallback = "failed"): string {
  return typeof value === "string" && /^[a-z0-9_]{1,96}$/.test(value)
    ? value
    : fallback;
}

function boundedNonEmpty(
  value: unknown,
  maxLength: number,
  code: string,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw protocolError(code);
  }
  return value;
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw protocolError(code);
  }
  return Number(value);
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw protocolError(code);
  }
  return value;
}

function boundedString(value: unknown, maxBytes: number, code: string): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw protocolError(code);
  }
  return value;
}

function requireObject(
  value: unknown,
  code: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    throw protocolError(code);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
