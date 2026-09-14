import {
  ModelTransportError,
  beginModelCall,
  type ModelTransportStreamOptions,
  type ModelInputItem,
  type ModelRequest,
  type ModelTransportEvent,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import { parseResponsesSse } from "@crewon/agent-responses";

const MAX_API_KEY_LENGTH = 8 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_HISTORY_MESSAGES = 256;
const EVENT_STREAM_MEDIA_TYPE = "text/event-stream";

export const CLOUD_AGENT_ADAPTER_NAME = "cloud-agent";
export const CLOUD_AGENT_ADAPTER_VERSION = "1";

export type CloudAgentTransportConfig = Readonly<{
  invocationUrl: string;
  apiKey: string;
  model: string;
  agentId: number;
  idleTimeoutMs: number;
}>;

export type CloudAgentFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Runs an Agent Platform cloud Agent through its Open API streaming endpoint.
 *
 * The cloud service owns the Agent's prompt, tools, and orchestration. This
 * transport only projects the bounded local conversation into the service's
 * `message` and `history` contract, then normalizes its SSE events for the
 * Agent kernel.
 */
export class CloudAgentTransport implements ModelTransportPort {
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly modelId: string;
  readonly #agentId: number;
  readonly #apiKey: string;
  readonly #fetch: CloudAgentFetch;
  readonly #idleTimeoutMs: number;
  readonly #invocationUrl: URL;

  constructor(
    config: CloudAgentTransportConfig,
    dependencies: Readonly<{
      fetch?: CloudAgentFetch;
    }> = {},
  ) {
    this.#invocationUrl = parseInvocationUrl(config.invocationUrl);
    this.#apiKey = bounded(
      config.apiKey,
      MAX_API_KEY_LENGTH,
      "cloud_agent_key_invalid",
    );
    this.modelId = bounded(config.model, 256, "cloud_agent_model_invalid");
    this.#agentId = positiveInteger(config.agentId, "cloud_agent_id_invalid");
    this.#idleTimeoutMs = positiveInteger(
      config.idleTimeoutMs,
      "cloud_agent_idle_timeout_invalid",
    );
    this.adapterName = CLOUD_AGENT_ADAPTER_NAME;
    this.adapterVersion = CLOUD_AGENT_ADAPTER_VERSION;
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    options?: ModelTransportStreamOptions,
  ): AsyncIterable<ModelTransportEvent> {
    const payload = requestPayload(request);
    const idle = new IdleWatch(this.#idleTimeoutMs, signal);
    let call: Awaited<ReturnType<typeof beginModelCall>> = null;
    let outcome: "completed" | "failed" | "canceled" | "interrupted" =
      "interrupted";
    try {
      call = await beginModelCall({
        options,
        identity: {
          adapterName: this.adapterName,
          adapterVersion: this.adapterVersion,
          modelId: this.modelId,
          agentVersionId: request.agentVersionId,
        },
        transport: "cloudAgent",
        operation: "generate",
        signal: idle.signal,
      });
      const response = await this.#fetch(this.#invocationUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          "Accept": "text/event-stream",
          "Content-Type": "application/json",
          "X-API-Key": this.#apiKey,
        },
        body: JSON.stringify(payload),
        signal: idle.signal,
      });
      idle.touch();
      if (!response.ok) {
        await cancelBody(response.body);
        throw cloudAgentHttpError(
          response.status,
          response.headers.get("retry-after"),
        );
      }
      if (responseMediaType(response) !== EVENT_STREAM_MEDIA_TYPE) {
        await cancelBody(response.body);
        throw transportError(
          "protocol",
          "cloud_agent_stream_content_type_invalid",
          false,
        );
      }
      if (response.body === null) {
        throw transportError(
          "protocol",
          "cloud_agent_stream_body_missing",
          false,
        );
      }

      let completed = false;
      for await (const frame of parseResponsesSse(response.body, {
        maxEventBytes: MAX_EVENT_BYTES,
        onActivity: () => idle.touch(),
      })) {
        if (frame.kind === "done") {
          if (!completed) {
            throw transportError(
              "incomplete",
              "cloud_agent_stream_incomplete",
              false,
            );
          }
          outcome = "completed";
          return;
        }
        const event = frame.value;
        const kind = event.event;
        if (kind === "message") {
          if (completed) {
            throw transportError(
              "protocol",
              "cloud_agent_event_after_done",
              false,
            );
          }
          const chunk = event.chunk;
          if (typeof chunk !== "string") {
            throw transportError(
              "protocol",
              "cloud_agent_message_invalid",
              false,
            );
          }
          if (chunk.length > 0) {
            const event = { type: "output.delta", delta: chunk } as const;
            yield call?.event(event) ?? event;
          }
          continue;
        }
        if (kind === "done") {
          if (completed) {
            throw transportError(
              "protocol",
              "cloud_agent_done_duplicate",
              false,
            );
          }
          completed = true;
          const usage = tokenUsage(event.token_usage);
          if (usage !== null) {
            const event = { type: "usage", ...usage } as const;
            yield call?.event(event) ?? event;
          }
          const completion = { type: "completed", checkpoint: null } as const;
          yield call?.event(completion) ?? completion;
          continue;
        }
        if (kind === "error") {
          if (completed) {
            throw transportError(
              "protocol",
              "cloud_agent_event_after_done",
              false,
            );
          }
          throw transportError("incomplete", "cloud_agent_stream_error", false);
        }
        if (completed) {
          throw transportError(
            "protocol",
            "cloud_agent_event_after_done",
            false,
          );
        }
      }
      if (!completed) {
        throw transportError(
          "incomplete",
          "cloud_agent_stream_incomplete",
          false,
        );
      }
      outcome = "completed";
    } catch (error) {
      outcome = signal.aborted ? "canceled" : "failed";
      if (signal.aborted) {
        throw transportError(
          "canceled",
          "cloud_agent_canceled",
          false,
          undefined,
          signal.reason,
        );
      }
      if (idle.expired) {
        throw transportError(
          "timeout",
          "cloud_agent_idle_timeout",
          false,
          undefined,
          error,
        );
      }
      if (error instanceof ModelTransportError) {
        throw error;
      }
      throw transportError(
        "unavailable",
        "cloud_agent_transport_unavailable",
        false,
        undefined,
        error,
      );
    } finally {
      idle.close();
      await call?.finish(
        outcome === "interrupted" && signal.aborted ? "canceled" : outcome,
      );
    }
  }

  /** Cloud Agent sessions are history-based and cannot retrieve provider responses. */
  get supportsResponseRetrieve(): boolean {
    return false;
  }
}

function requestPayload(request: ModelRequest): Readonly<{
  message: string;
  history: readonly Readonly<{ role: "user" | "assistant"; content: string }>[];
}> {
  if (request.reconcileCheckpoint !== undefined) {
    throw transportError(
      "invalidRequest",
      "cloud_agent_retrieve_unsupported",
      false,
    );
  }
  if (request.providerTurnState !== undefined) {
    throw transportError(
      "invalidRequest",
      "cloud_agent_turn_state_unsupported",
      false,
    );
  }
  if (request.instructions !== null) {
    throw transportError(
      "invalidRequest",
      "cloud_agent_instructions_unsupported",
      false,
    );
  }
  if (request.tools.length !== 0) {
    throw transportError(
      "invalidRequest",
      "cloud_agent_tools_unsupported",
      false,
    );
  }
  if (request.input.strategy !== "manual") {
    throw transportError(
      "invalidRequest",
      "cloud_agent_provider_checkpoint_unsupported",
      false,
    );
  }
  const messages = request.input.items.map(projectHistoryMessage);
  const currentIndex = findCurrentUserMessage(messages);
  if (currentIndex === -1) {
    throw transportError(
      "invalidRequest",
      "cloud_agent_user_message_missing",
      false,
    );
  }
  if (currentIndex !== messages.length - 1) {
    throw transportError(
      "invalidRequest",
      "cloud_agent_current_message_invalid",
      false,
    );
  }
  const current = messages[currentIndex]!;
  const history = messages
    .slice(0, currentIndex)
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content }) => ({ role, content }));
  return { message: current.content, history };
}

function projectHistoryMessage(
  item: ModelInputItem,
): Readonly<{ role: "user" | "assistant"; content: string }> {
  if (
    item.type !== "message" ||
    (item.role !== "user" && item.role !== "assistant") ||
    item.content.trim().length === 0
  ) {
    throw transportError(
      "invalidRequest",
      "cloud_agent_history_item_unsupported",
      false,
    );
  }
  return { role: item.role, content: item.content };
}

function findCurrentUserMessage(
  messages: readonly Readonly<{
    role: "user" | "assistant";
    content: string;
  }>[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function tokenUsage(value: unknown): Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const inputTokens = nonNegativeInteger(value.prompt_tokens);
  const outputTokens = nonNegativeInteger(value.completion_tokens);
  const totalTokens = nonNegativeInteger(value.total_tokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    return null;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function parseInvocationUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw transportError(
      "invalidRequest",
      "cloud_agent_invocation_url_invalid",
      false,
      undefined,
      error,
    );
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
  ) {
    throw transportError(
      "invalidRequest",
      "cloud_agent_invocation_url_invalid",
      false,
    );
  }
  return url;
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function cloudAgentHttpError(
  status: number,
  retryAfter: string | null,
): ModelTransportError {
  const retryAfterMs = retryAfterMilliseconds(retryAfter);
  if (status === 401) {
    return transportError(
      "authentication",
      "cloud_agent_authentication_failed",
      false,
    );
  }
  if (status === 403) {
    return transportError("permission", "cloud_agent_permission_denied", false);
  }
  if (status === 404) {
    return transportError("notFound", "cloud_agent_endpoint_not_found", false);
  }
  if (status === 408) {
    return transportError(
      "timeout",
      "cloud_agent_request_timeout",
      false,
      retryAfterMs,
    );
  }
  if (status === 429) {
    return transportError(
      "rateLimit",
      "cloud_agent_rate_limited",
      false,
      retryAfterMs,
    );
  }
  if (status >= 400 && status < 500) {
    return transportError(
      "invalidRequest",
      "cloud_agent_request_rejected",
      false,
    );
  }
  if (status >= 500 && status < 600) {
    return transportError(
      "unavailable",
      "cloud_agent_unavailable",
      false,
      retryAfterMs,
    );
  }
  return transportError("protocol", "cloud_agent_http_status_invalid", false);
}

function responseMediaType(response: Response): string | null {
  const value = response.headers.get("content-type");
  if (value === null) return null;
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(Math.ceil(seconds * 1_000), 24 * 60 * 60 * 1_000)
    : undefined;
}

function bounded(value: unknown, maxLength: number, code: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw transportError("invalidRequest", code, false);
  }
  return value;
}

function positiveInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw transportError("invalidRequest", code, false);
  }
  return value;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function transportError(
  category: ModelTransportError["category"],
  code: string,
  retryable: boolean,
  retryAfterMs?: number,
  cause?: unknown,
): ModelTransportError {
  return new ModelTransportError({
    category,
    code,
    retryable,
    retryAfterMs,
    cause,
  });
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The body can already be closed by fetch.
  }
}

class IdleWatch {
  readonly #controller = new AbortController();
  readonly #onAbort = () => this.#controller.abort(this.#parent.reason);
  readonly #parent: AbortSignal;
  readonly #timeoutMs: number;
  #expired = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(timeoutMs: number, parent: AbortSignal) {
    this.#parent = parent;
    this.#timeoutMs = timeoutMs;
    if (parent.aborted) {
      this.#onAbort();
    } else {
      parent.addEventListener("abort", this.#onAbort, { once: true });
    }
    this.#schedule();
  }

  get expired(): boolean {
    return this.#expired;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  touch(): void {
    if (!this.#expired && !this.#controller.signal.aborted) {
      this.#schedule();
    }
  }

  close(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#parent.removeEventListener("abort", this.#onAbort);
  }

  #schedule(timeoutMs?: number): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
    const delay = timeoutMs ?? this.#timeoutMs;
    this.#timer = setTimeout(() => {
      this.#expired = true;
      this.#controller.abort(new Error("cloud_agent_idle_timeout"));
    }, delay);
  }
}
