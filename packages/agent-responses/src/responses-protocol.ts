import type { ModelInputItem, ModelTransportEvent } from "@crewon/agent-kernel";
import type { ProviderCheckpoint } from "@crewon/contracts";

import { protocolError, transportError } from "./responses-errors.ts";
import { parseResponsesSse } from "./responses-sse.ts";

const MAX_RESPONSE_ID_LENGTH = 512;

export type ResponsesSequencePolicy = "required" | "whenPresent";

export type ResponsesProtocolOptions = Readonly<{
  sequencePolicy: ResponsesSequencePolicy;
  completedCheckpoint: (responseId: string) => ProviderCheckpoint | null;
  createdCheckpoint?: (responseId: string) => ProviderCheckpoint | null;
}>;

/** Decodes one Responses event stream independently of its HTTP or WebSocket framing. */
export class ResponsesProtocolDecoder {
  readonly #options: ResponsesProtocolOptions;
  #lastSequence = -1;
  #responseId: string | null = null;
  #output = "";
  #terminal = false;
  #completedHistoryItems: ModelInputItem[] = [];

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
        if (this.#responseId !== null) {
          throw protocolError("responses_created_duplicate");
        }
        this.#responseId = responseIdentity(event);
        const checkpoint =
          this.#options.createdCheckpoint?.(this.#responseId) ?? null;
        return checkpoint === null
          ? []
          : [{ type: "response.created", checkpoint }];
      }
      case "response.output_text.delta": {
        requireCreated(this.#responseId);
        const delta = requireString(event.delta, "responses_delta_invalid");
        this.#output += delta;
        return [{ type: "output.delta", delta }];
      }
      case "response.completed": {
        requireCreated(this.#responseId);
        const response = terminalResponse(
          event.response,
          this.#responseId,
          "responses_completed_response_invalid",
        );
        requireStatus(response, "completed");
        validateFinalOutput(response.output, this.#output);
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
        return [
          { type: "usage", ...usage },
          {
            type: "completed",
            checkpoint: this.#options.completedCheckpoint(this.#responseId),
          },
        ];
      }
      case "response.failed": {
        requireCreated(this.#responseId);
        const response = terminalResponse(
          event.response,
          this.#responseId,
          "responses_failed_response_invalid",
        );
        requireStatus(response, "failed");
        const failure = parseStreamFailure(response);
        this.#terminal = true;
        return [{ type: "failed", ...failure }];
      }
      case "response.incomplete": {
        requireCreated(this.#responseId);
        const response = terminalResponse(
          event.response,
          this.#responseId,
          "responses_incomplete_response_invalid",
        );
        requireStatus(response, "incomplete");
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
        requireCreated(this.#responseId);
        const outputItem = requireObject(
          event.item,
          "responses_output_item_invalid",
        );
        if (outputItem.type === "message") {
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
        requireCreated(this.#responseId);
        return [];
      default:
        throw protocolError("responses_event_unsupported");
    }
  }

  finish(): void {
    if (!this.#terminal) {
      throw transportError("unavailable", "responses_stream_incomplete", true);
    }
  }
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
    onActivity: () => void;
    completedCheckpoint: (responseId: string) => ProviderCheckpoint | null;
    createdCheckpoint?: (responseId: string) => ProviderCheckpoint | null;
  },
): AsyncIterable<ModelTransportEvent> {
  const decoder = new ResponsesProtocolDecoder(options);
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
      yield event;
    }
  }
  decoder.finish();
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

function responseIdentity(event: Readonly<Record<string, unknown>>): string {
  const response = requireObject(
    event.response,
    "responses_created_response_invalid",
  );
  return boundedNonEmpty(
    response.id,
    MAX_RESPONSE_ID_LENGTH,
    "responses_response_id_invalid",
  );
}

function requireCreated(
  responseId: string | null,
): asserts responseId is string {
  if (responseId === null) {
    throw protocolError("responses_created_missing");
  }
}

function terminalResponse(
  value: unknown,
  expectedId: string,
  code: string,
): Readonly<Record<string, unknown>> {
  const response = requireObject(value, code);
  if (
    boundedNonEmpty(
      response.id,
      MAX_RESPONSE_ID_LENGTH,
      "responses_response_id_invalid",
    ) !== expectedId
  ) {
    throw protocolError("responses_response_id_mismatch");
  }
  return response;
}

function parseUsage(value: unknown): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
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

function validateFinalOutput(value: unknown, streamed: string): void {
  if (!Array.isArray(value)) {
    throw protocolError("responses_output_invalid");
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

function parseStreamFailure(response: Readonly<Record<string, unknown>>): {
  code: string;
  retryable: boolean;
} {
  const error = requireObject(response.error, "responses_failed_error_invalid");
  return providerFailure(error.code);
}

function parseIncomplete(response: Readonly<Record<string, unknown>>): {
  code: string;
  retryable: boolean;
} {
  const details = requireObject(
    response.incomplete_details,
    "responses_incomplete_details_invalid",
  );
  const reason = safeProviderCode(details.reason);
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
    retryable: [
      "server_error",
      "rate_limit_exceeded",
      "temporarily_unavailable",
      "timeout",
      "websocket_connection_limit_reached",
    ].includes(providerCode),
  };
}

function safeProviderCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]{1,96}$/.test(value)
    ? value
    : "failed";
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
