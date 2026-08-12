import {
  ModelTransportError,
  type ModelInputItem,
  type ModelRequest,
  type ModelTransportEvent,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  parseProviderCheckpoint,
  type ProviderCheckpoint,
} from "@crewon/contracts";

import {
  httpError,
  protocolError,
  transportError,
} from "./responses-errors.ts";
import {
  responsesProtocolEvents,
  type ResponsesSequencePolicy,
} from "./responses-protocol.ts";
import {
  isCyberPolicyBody,
  isContextWindowExceededBody,
  isUsageLimitReachedBody,
  parseResponsesRateLimitHeaders,
  readBoundedErrorBody,
} from "./responses-rate-limits.ts";
import { projectRetrievedResponse } from "./responses-retrieve.ts";
import {
  ResponsesTurnStateAuthority,
  TURN_STATE_HEADER,
  fetchTurnStateHeaders,
  parseTurnStateHeader,
} from "./turn-state.ts";

export type { ResponsesSequencePolicy } from "./responses-protocol.ts";

export type ResponsesRequestProfile = "standard" | "responsesLite";

const MAX_MODEL_LENGTH = 256;
const MAX_RESPONSE_ID_LENGTH = 512;
const MAX_INPUT_ITEMS = 512;
const MAX_CONTEXT_BYTES = 512 * 1024;
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

export type DirectResponsesTransportConfig = Readonly<{
  endpoint: string;
  apiKey?: string | null;
  model: string;
  storeResponses?: boolean;
  requestProfile?: ResponsesRequestProfile;
  idleTimeoutMs?: number;
  sequencePolicy?: ResponsesSequencePolicy;
}>;

export type ResponsesFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ResponsesTimerScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export type ResponsesTransportIdentity = Readonly<{
  adapterName: string;
  adapterVersion: string;
}>;

export class DirectResponsesTransport implements ModelTransportPort {
  get supportsResponseRetrieve(): boolean {
    return this.#storeResponses;
  }
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly modelId: string;
  readonly #endpoint: URL;
  readonly #apiKey: string | null;
  readonly #storeResponses: boolean;
  readonly #requestProfile: ResponsesRequestProfile;
  readonly #idleTimeoutMs: number;
  readonly #sequencePolicy: ResponsesSequencePolicy;
  readonly #fetch: ResponsesFetch;
  readonly #scheduler: ResponsesTimerScheduler;
  readonly #turnStates: ResponsesTurnStateAuthority;

  constructor(
    config: DirectResponsesTransportConfig,
    dependencies: {
      fetch?: ResponsesFetch;
      scheduler?: ResponsesTimerScheduler;
      identity?: ResponsesTransportIdentity;
      turnStates?: ResponsesTurnStateAuthority;
    } = {},
  ) {
    const requestProfile = parseResponsesRequestProfile(
      config.requestProfile ?? "standard",
    );
    this.adapterName = boundedNonEmpty(
      dependencies.identity?.adapterName ?? "direct-responses",
      128,
      "responses_adapter_name_invalid",
    );
    this.adapterVersion = profiledAdapterVersion(
      dependencies.identity?.adapterVersion ?? "1",
      requestProfile,
    );
    this.#endpoint = parseResponsesEndpoint(config.endpoint);
    this.modelId = boundedNonEmpty(
      config.model,
      MAX_MODEL_LENGTH,
      "responses_model_invalid",
    );
    this.#apiKey = parseResponsesApiKey(config.apiKey ?? null);
    if (
      config.storeResponses !== undefined &&
      typeof config.storeResponses !== "boolean"
    ) {
      throw protocolError("responses_store_invalid");
    }
    this.#storeResponses = config.storeResponses ?? false;
    this.#requestProfile = requestProfile;
    this.#idleTimeoutMs = positiveInteger(
      config.idleTimeoutMs ?? 60_000,
      "responses_idle_timeout_invalid",
    );
    this.#sequencePolicy = config.sequencePolicy ?? "required";
    if (
      this.#sequencePolicy !== "required" &&
      this.#sequencePolicy !== "whenPresent"
    ) {
      throw protocolError("responses_sequence_policy_invalid");
    }
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.#scheduler = dependencies.scheduler ?? systemScheduler;
    this.#turnStates =
      dependencies.turnStates ?? new ResponsesTurnStateAuthority();
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelTransportEvent> {
    validateResponsesRequest(request);
    this.#turnStates.seed(request.runId, request.providerTurnState ?? null);
    if (request.reconcileCheckpoint !== undefined) {
      if (!this.#storeResponses) {
        throw transportError(
          "invalidRequest",
          "responses_retrieve_requires_storage",
          false,
        );
      }
      yield* this.#retrieve(request.reconcileCheckpoint, signal);
      return;
    }
    const previousResponseId =
      request.input.strategy === "providerCheckpoint"
        ? responseIdFromResponsesCheckpoint(
            request.input.checkpoint,
            this.modelIdentity(),
          )
        : null;
    if (
      request.input.strategy === "providerCheckpoint" &&
      !this.#storeResponses
    ) {
      throw transportError(
        "invalidRequest",
        "responses_previous_response_requires_storage",
        false,
      );
    }
    const idle = new IdleWatch(this.#idleTimeoutMs, this.#scheduler, signal);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: responsesHeaders(
          this.#apiKey,
          "text/event-stream",
          this.#turnStates.get(request.runId),
        ),
        body: JSON.stringify(
          responsesRequestBody({
            request,
            previousResponseId,
            modelId: this.modelId,
            storeResponses: this.#storeResponses,
            requestProfile: this.#requestProfile,
          }),
        ),
        signal: idle.signal,
      });
      idle.touch();
      if (!response.ok) {
        const rateLimit = parseResponsesRateLimitHeaders(response.headers);
        let errorBody: string | null = null;
        if (response.status === 400 || response.status === 429) {
          errorBody = await readBoundedErrorBody(response.body);
        } else {
          await cancelBody(response.body);
        }
        if (rateLimit !== null) {
          yield { type: "rate_limit", snapshot: rateLimit };
        }
        throw httpError(response.status, response.headers.get("retry-after"), {
          usageLimitReached: isUsageLimitReachedBody(errorBody),
          contextWindowExceeded: isContextWindowExceededBody(errorBody),
          cyberPolicy: isCyberPolicyBody(errorBody),
        });
      }
      this.#turnStates.observe(
        request.runId,
        fetchTurnStateHeaders(response.headers),
      );
      const contentType = response.headers.get("content-type");
      if (contentType?.toLowerCase().startsWith("text/event-stream") !== true) {
        await cancelBody(response.body);
        throw protocolError("responses_content_type_invalid");
      }
      if (response.body === null) {
        throw protocolError("responses_body_missing");
      }
      const events = responsesProtocolEvents(response.body, {
        sequencePolicy: this.#sequencePolicy,
        onActivity: () => idle.touch(),
        completedCheckpoint: (responseId) =>
          this.#storeResponses
            ? responsesCheckpoint(responseId, this.modelIdentity())
            : null,
        createdCheckpoint: (responseId) =>
          this.#storeResponses
            ? responsesCheckpoint(responseId, this.modelIdentity())
            : null,
      });
      for await (const event of events) {
        if (event.type === "completed") {
          const providerTurnState = this.#turnStates.get(request.runId);
          yield providerTurnState === null
            ? event
            : { ...event, providerTurnState };
        } else {
          yield event;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        throw transportError(
          "canceled",
          "segment_canceled",
          false,
          undefined,
          signal.reason,
        );
      }
      if (idle.expired) {
        throw transportError(
          "timeout",
          "responses_idle_timeout",
          true,
          undefined,
          error,
        );
      }
      if (error instanceof ModelTransportError) {
        throw error;
      }
      throw transportError(
        "unavailable",
        "responses_transport_unavailable",
        true,
        undefined,
        error,
      );
    } finally {
      idle.close();
    }
  }

  releaseRun(runId: string): void {
    this.#turnStates.release(runId);
  }

  async *#retrieve(
    checkpoint: ProviderCheckpoint,
    signal: AbortSignal,
  ): AsyncIterable<ModelTransportEvent> {
    const responseId = responseIdFromResponsesCheckpoint(
      checkpoint,
      this.modelIdentity(),
    );
    const url = new URL(
      `${this.#endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(responseId)}`,
      this.#endpoint,
    );
    const idle = new IdleWatch(this.#idleTimeoutMs, this.#scheduler, signal);
    try {
      const response = await this.#fetch(url, {
        method: "GET",
        headers: responsesHeaders(this.#apiKey, "application/json"),
        signal: idle.signal,
      });
      idle.touch();
      if (!response.ok) {
        await cancelBody(response.body);
        throw httpError(response.status, response.headers.get("retry-after"));
      }
      const value = await readBoundedJson(response, 512 * 1024, () =>
        idle.touch(),
      );
      const projected = projectRetrievedResponse(value, responseId, checkpoint);
      if (projected.status === "pending") {
        throw transportError(
          "unavailable",
          "responses_reconcile_pending",
          true,
        );
      }
      yield* projected.events;
    } catch (error) {
      if (signal.aborted) {
        throw transportError(
          "canceled",
          "segment_canceled",
          false,
          undefined,
          signal.reason,
        );
      }
      if (idle.expired) {
        throw transportError(
          "timeout",
          "responses_idle_timeout",
          true,
          undefined,
          error,
        );
      }
      if (error instanceof ModelTransportError) throw error;
      throw transportError(
        "unavailable",
        "responses_transport_unavailable",
        true,
        undefined,
        error,
      );
    } finally {
      idle.close();
    }
  }

  modelIdentity(): Readonly<{
    adapterName: string;
    adapterVersion: string;
    modelId: string;
  }> {
    return {
      adapterName: this.adapterName,
      adapterVersion: this.adapterVersion,
      modelId: this.modelId,
    };
  }
}

class IdleWatch {
  readonly #timeoutMs: number;
  readonly #scheduler: ResponsesTimerScheduler;
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  #cancelTimer: (() => void) | null = null;
  expired = false;

  constructor(
    timeoutMs: number,
    scheduler: ResponsesTimerScheduler,
    externalSignal: AbortSignal,
  ) {
    this.#timeoutMs = timeoutMs;
    this.#scheduler = scheduler;
    this.signal = AbortSignal.any([externalSignal, this.#controller.signal]);
    this.touch();
  }

  touch(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = this.#scheduler.schedule(() => {
      this.expired = true;
      this.#controller.abort("responses_idle_timeout");
    }, this.#timeoutMs);
  }

  close(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }
}

const systemScheduler: ResponsesTimerScheduler = {
  schedule: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

export function validateResponsesRequest(request: ModelRequest): void {
  if (
    !isPlainObject(request) ||
    request.schemaVersion !== "crewon.model-request.v0" ||
    !sameKeys(request, [
      "agentVersionId",
      "input",
      "instructions",
      "maxOutputBytes",
      "runId",
      "schemaVersion",
      "segmentId",
      "tools",
      ...(request.reconcileCheckpoint === undefined
        ? []
        : ["reconcileCheckpoint"]),
      ...(request.providerTurnState === undefined ? [] : ["providerTurnState"]),
    ])
  ) {
    throw protocolError("responses_request_invalid");
  }
  if (request.reconcileCheckpoint !== undefined) {
    parseProviderCheckpoint(request.reconcileCheckpoint);
  }
  if (request.providerTurnState !== undefined) {
    parseTurnStateHeader([request.providerTurnState]);
  }
  boundedNonEmpty(request.runId, 512, "responses_run_id_invalid");
  boundedNonEmpty(request.segmentId, 512, "responses_segment_id_invalid");
  boundedNonEmpty(
    request.agentVersionId,
    512,
    "responses_agent_version_id_invalid",
  );
  if (request.instructions !== null) {
    boundedUtf8NonEmpty(
      request.instructions,
      MAX_INSTRUCTIONS_BYTES,
      "responses_instructions_invalid",
    );
  }
  positiveInteger(request.maxOutputBytes, "responses_output_budget_invalid");
  if (!Array.isArray(request.tools) || request.tools.length > 128) {
    throw protocolError("responses_tools_invalid");
  }
  for (const definition of request.tools) {
    validateToolDefinition(definition);
  }
  const input = request.input;
  if (!isPlainObject(input) || !Array.isArray(input.items)) {
    throw protocolError("responses_input_invalid");
  }
  const expectedInputKeys =
    input.strategy === "manual"
      ? ["items", "strategy"]
      : ["checkpoint", "items", "newHistoryStartIndex", "strategy"];
  if (
    (input.strategy !== "manual" && input.strategy !== "providerCheckpoint") ||
    !sameKeys(input, expectedInputKeys) ||
    input.items.length < 1 ||
    input.items.length > MAX_INPUT_ITEMS
  ) {
    throw protocolError("responses_input_invalid");
  }
  if (input.strategy === "providerCheckpoint") {
    if (
      !Number.isSafeInteger(input.newHistoryStartIndex) ||
      input.newHistoryStartIndex < 0 ||
      input.newHistoryStartIndex > input.items.length
    ) {
      throw protocolError("responses_new_history_start_invalid");
    }
    try {
      parseProviderCheckpoint(input.checkpoint);
    } catch (error) {
      throw protocolError("responses_provider_checkpoint_invalid", error);
    }
  }
  let contextBytes = 0;
  for (const item of input.items) {
    validateInputItem(item);
    contextBytes += new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (contextBytes > MAX_CONTEXT_BYTES) {
      throw protocolError("responses_context_too_large");
    }
  }
}

export function responsesCheckpoint(
  responseId: string,
  identity: Readonly<{
    adapterName: string;
    adapterVersion: string;
    modelId: string;
  }>,
): ProviderCheckpoint {
  return parseProviderCheckpoint({
    schemaVersion: "crewon.provider-checkpoint.v0",
    ...identity,
    opaquePayload: { responseId },
  });
}

export function responseIdFromResponsesCheckpoint(
  checkpoint: ProviderCheckpoint,
  identity: Readonly<{
    adapterName: string;
    adapterVersion: string;
    modelId: string;
  }>,
): string {
  parseProviderCheckpoint(checkpoint);
  if (
    checkpoint.adapterName !== identity.adapterName ||
    checkpoint.adapterVersion !== identity.adapterVersion ||
    checkpoint.modelId !== identity.modelId ||
    !sameKeys(checkpoint.opaquePayload, ["responseId"])
  ) {
    throw protocolError("responses_provider_checkpoint_incompatible");
  }
  return boundedNonEmpty(
    checkpoint.opaquePayload.responseId,
    MAX_RESPONSE_ID_LENGTH,
    "responses_previous_response_id_invalid",
  );
}

function validateInputItem(item: ModelInputItem): void {
  if (!isPlainObject(item)) {
    throw protocolError("responses_input_item_invalid");
  }
  switch (item.type) {
    case "message":
      if (
        !sameKeys(item, ["content", "role", "type"]) ||
        (item.role !== "user" &&
          item.role !== "assistant" &&
          item.role !== "developer" &&
          item.role !== "system")
      ) {
        throw protocolError("responses_message_invalid");
      }
      boundedNonEmpty(
        item.content,
        MAX_CONTEXT_BYTES,
        "responses_message_content_invalid",
      );
      return;
    case "tool_call":
      if (!sameKeys(item, ["callId", "input", "kind", "name", "type"])) {
        throw protocolError("responses_tool_call_invalid");
      }
      validateToolIdentity(item);
      boundedString(item.input, 64 * 1024, "responses_tool_input_invalid");
      return;
    case "tool_result":
      if (!sameKeys(item, ["callId", "kind", "output", "type"])) {
        throw protocolError("responses_tool_result_invalid");
      }
      validateToolIdentity(item);
      boundedString(item.output, 256 * 1024, "responses_tool_output_invalid");
      return;
    default:
      throw protocolError("responses_input_item_invalid");
  }
}

function validateToolIdentity(item: {
  callId: unknown;
  kind: unknown;
  name?: unknown;
}): void {
  boundedNonEmpty(item.callId, 512, "responses_tool_call_id_invalid");
  if (item.kind !== "function" && item.kind !== "custom") {
    throw protocolError("responses_tool_kind_invalid");
  }
  if (item.name !== undefined) {
    boundedNonEmpty(item.name, 128, "responses_tool_name_invalid");
  }
}

function validateToolDefinition(
  definition: ModelRequest["tools"][number],
): void {
  if (
    !isPlainObject(definition) ||
    definition.schemaVersion !== "crewon.tool-definition.v0"
  ) {
    throw protocolError("responses_tool_definition_invalid");
  }
  boundedNonEmpty(definition.name, 128, "responses_tool_name_invalid");
  boundedNonEmpty(
    definition.description,
    2_048,
    "responses_tool_description_invalid",
  );
  if (
    definition.execution !== "serial" &&
    definition.execution !== "parallel"
  ) {
    throw protocolError("responses_tool_execution_policy_invalid");
  }
  if (definition.kind === "function") {
    if (
      !sameKeys(definition, [
        "description",
        "execution",
        "inputSchema",
        "kind",
        "name",
        "schemaVersion",
      ]) ||
      !isPlainObject(definition.inputSchema)
    ) {
      throw protocolError("responses_tool_definition_invalid");
    }
    boundedJson(
      definition.inputSchema,
      32 * 1024,
      "responses_tool_schema_invalid",
    );
    return;
  }
  if (
    definition.kind !== "custom" ||
    definition.inputFormat !== "text" ||
    !sameKeys(definition, [
      "description",
      "execution",
      "inputFormat",
      "kind",
      "name",
      "schemaVersion",
    ])
  ) {
    throw protocolError("responses_tool_definition_invalid");
  }
}

export function toResponsesInputItem(
  item: ModelInputItem,
): Readonly<Record<string, unknown>> {
  switch (item.type) {
    case "message":
      return { role: item.role, content: item.content };
    case "tool_call":
      return item.kind === "function"
        ? {
            type: "function_call",
            call_id: item.callId,
            name: item.name,
            arguments: item.input,
          }
        : {
            type: "custom_tool_call",
            call_id: item.callId,
            name: item.name,
            input: item.input,
          };
    case "tool_result":
      return {
        type:
          item.kind === "function"
            ? "function_call_output"
            : "custom_tool_call_output",
        call_id: item.callId,
        output: item.output,
      };
  }
}

export function toResponsesToolDefinition(
  definition: ModelRequest["tools"][number],
): Readonly<Record<string, unknown>> {
  return definition.kind === "function"
    ? {
        type: "function",
        name: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
      }
    : {
        type: "custom",
        name: definition.name,
        description: definition.description,
        format: { type: "text" },
      };
}

function boundedString(value: unknown, maxBytes: number, code: string): string {
  if (typeof value !== "string") {
    throw protocolError(code);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw protocolError(code);
  }
  return value;
}

function boundedJson(value: unknown, maxBytes: number, code: string): void {
  if (!isJsonValue(value, new WeakSet<object>(), 0)) {
    throw protocolError(code);
  }
  try {
    const encoded = JSON.stringify(value);
    if (
      encoded === undefined ||
      new TextEncoder().encode(encoded).byteLength > maxBytes
    ) {
      throw protocolError(code);
    }
  } catch (error) {
    if (error instanceof ModelTransportError) {
      throw error;
    }
    throw protocolError(code, error);
  }
}

function isJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): boolean {
  if (depth > 32) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors, depth + 1))
    : isPlainObject(value) &&
      Object.values(value).every((item) =>
        isJsonValue(item, ancestors, depth + 1),
      );
  ancestors.delete(value);
  return valid;
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Preserve the classified HTTP/protocol error if body cancellation races.
  }
}

export function parseResponsesEndpoint(value: unknown): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(
      boundedNonEmpty(value, 4_096, "responses_endpoint_invalid"),
    );
  } catch (error) {
    if (error instanceof ModelTransportError) {
      throw error;
    }
    throw protocolError("responses_endpoint_invalid", error);
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0 ||
    endpoint.search.length > 0
  ) {
    throw protocolError("responses_endpoint_invalid");
  }
  return endpoint;
}

export function parseResponsesApiKey(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return boundedNonEmpty(value, 4_096, "responses_api_key_invalid");
}

export function responsesHeaders(
  apiKey: string | null,
  accept: string,
  turnState: string | null = null,
): Headers {
  const headers = new Headers({ accept, "content-type": "application/json" });
  if (apiKey !== null) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  if (turnState !== null) {
    headers.set(TURN_STATE_HEADER, turnState);
  }
  return headers;
}

export function responsesRequestBody(options: {
  request: ModelRequest;
  previousResponseId: string | null;
  modelId: string;
  storeResponses: boolean;
  requestProfile?: ResponsesRequestProfile;
  inputItems?: readonly ModelInputItem[];
}): Readonly<Record<string, unknown>> {
  const inputItems =
    options.inputItems ??
    (options.request.input.strategy === "providerCheckpoint"
      ? options.request.input.items.slice(
          options.request.input.newHistoryStartIndex,
        )
      : options.request.input.items);
  const body: Record<string, unknown> = {
    model: options.modelId,
    stream: true,
    store: options.storeResponses,
    input: inputItems.map(toResponsesInputItem),
    tools: options.request.tools.map(toResponsesToolDefinition),
  };
  if (options.request.instructions !== null) {
    body.instructions = options.request.instructions;
  }
  if ((options.requestProfile ?? "standard") === "responsesLite") {
    body.reasoning = { context: "all_turns" };
    body.parallel_tool_calls = false;
  }
  if (options.previousResponseId !== null) {
    body.previous_response_id = options.previousResponseId;
  }
  return body;
}

export function parseResponsesRequestProfile(
  value: unknown,
): ResponsesRequestProfile {
  if (value === "standard" || value === "responsesLite") {
    return value;
  }
  throw protocolError("responses_request_profile_invalid");
}

function profiledAdapterVersion(
  baseVersion: string,
  profile: ResponsesRequestProfile,
): string {
  return boundedNonEmpty(
    profile === "standard" ? baseVersion : `${baseVersion}+responses-lite`,
    128,
    "responses_adapter_version_invalid",
  );
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

function boundedUtf8NonEmpty(
  value: unknown,
  maxBytes: number,
  code: string,
): string {
  const parsed = boundedNonEmpty(value, maxBytes, code);
  if (new TextEncoder().encode(parsed).byteLength > maxBytes) {
    throw protocolError(code);
  }
  return parsed;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw protocolError(code);
  }
  return Number(value);
}

function sameKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  onActivity: () => void,
): Promise<unknown> {
  if (response.body === null)
    throw protocolError("responses_retrieve_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      size += value.byteLength;
      if (size > maxBytes)
        throw protocolError("responses_retrieve_body_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw protocolError("responses_retrieve_body_invalid", error);
  }
}
