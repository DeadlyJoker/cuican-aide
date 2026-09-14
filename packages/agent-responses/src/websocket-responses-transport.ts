import {
  ModelTransportError,
  beginModelCall,
  type ModelInputItem,
  type ModelRequest,
  type ModelTransportStreamOptions,
  type ModelTransportEvent,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import type { ClientRequest, IncomingMessage } from "node:http";
import WebSocket, { type ClientOptions } from "ws";
import { WebSocketMessageQueue } from "./websocket-message-queue.ts";

import {
  DirectResponsesTransport,
  type DirectResponsesTransportConfig,
  type ResponsesRequestProfile,
  type ResponsesFetch,
  type ResponsesTimerScheduler,
  type ResponsesTransportIdentity,
  parseResponsesApiKey,
  parseResponsesEndpoint,
  parseResponsesRequestProfile,
  responseIdFromResponsesCheckpoint,
  responsesCheckpoint,
  responsesHeaders,
  responsesRequestBody,
  validateResponsesRequest,
} from "./direct-responses-transport.ts";
import { protocolError, transportError } from "./responses-errors.ts";
import { recoverResponsesContinuation } from "./responses-continuation-recovery.ts";
import { ResponsesProtocolDecoder } from "./responses-protocol.ts";
import {
  parseTurnStateHeader,
  ResponsesTurnStateAuthority,
  TURN_STATE_HEADER,
} from "./turn-state.ts";

const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_WEBSOCKET_RETRIES = 2;
const WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const HYBRID_IDENTITY: ResponsesTransportIdentity = {
  adapterName: "direct-responses",
  adapterVersion: "2",
};

export type WebSocketResponsesTransportConfig = DirectResponsesTransportConfig &
  Readonly<{
    connectTimeoutMs?: number;
    maxMessageBytes?: number;
  }>;

export type WebSocketFactory = (url: URL, options: ClientOptions) => WebSocket;

export class WebSocketResponsesTransport implements ModelTransportPort {
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly modelId: string;
  readonly #endpoint: URL;
  readonly #apiKey: string | null;
  readonly #storeResponses: boolean;
  readonly #requestProfile: ResponsesRequestProfile;
  readonly #idleTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #sequencePolicy: "required" | "whenPresent";
  readonly #factory: WebSocketFactory;
  readonly #scheduler: ResponsesTimerScheduler;
  readonly #turnStates: ResponsesTurnStateAuthority;
  #socket: WebSocket | null = null;
  #socketRunId: string | null = null;
  #baseline: IncrementalBaseline | null = null;
  #active = false;

  constructor(
    config: WebSocketResponsesTransportConfig,
    dependencies: {
      factory?: WebSocketFactory;
      scheduler?: ResponsesTimerScheduler;
      identity?: ResponsesTransportIdentity;
      turnStates?: ResponsesTurnStateAuthority;
    } = {},
  ) {
    const requestProfile = parseResponsesRequestProfile(
      config.requestProfile ?? "standard",
    );
    const identity = dependencies.identity ?? HYBRID_IDENTITY;
    this.adapterName = requireNonEmpty(
      identity.adapterName,
      "responses_adapter_name_invalid",
    );
    this.adapterVersion = requireNonEmpty(
      requestProfile === "standard"
        ? identity.adapterVersion
        : `${identity.adapterVersion}+responses-lite`,
      "responses_adapter_version_invalid",
    );
    this.modelId = boundedNonEmpty(
      config.model,
      256,
      "responses_model_invalid",
    );
    this.#endpoint = websocketEndpoint(parseResponsesEndpoint(config.endpoint));
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
    this.#connectTimeoutMs = positiveInteger(
      config.connectTimeoutMs ?? 10_000,
      "responses_websocket_connect_timeout_invalid",
    );
    this.#maxMessageBytes = positiveInteger(
      config.maxMessageBytes ?? MAX_WEBSOCKET_MESSAGE_BYTES,
      "responses_websocket_message_limit_invalid",
    );
    this.#sequencePolicy = config.sequencePolicy ?? "required";
    if (
      this.#sequencePolicy !== "required" &&
      this.#sequencePolicy !== "whenPresent"
    ) {
      throw protocolError("responses_sequence_policy_invalid");
    }
    this.#factory =
      dependencies.factory ?? ((url, options) => new WebSocket(url, options));
    this.#scheduler = dependencies.scheduler ?? systemScheduler;
    this.#turnStates =
      dependencies.turnStates ?? new ResponsesTurnStateAuthority();
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    options?: ModelTransportStreamOptions,
  ): AsyncIterable<ModelTransportEvent> {
    if (this.#active) {
      throw protocolError("responses_websocket_concurrent_stream");
    }
    this.#active = true;
    let reusablePrefix = false;
    try {
      yield* recoverResponsesContinuation({
        request,
        signal,
        transport: "websocket",
        canReplay: () => reusablePrefix,
        stream: (next) =>
          this.#streamOnce(next, signal, options, (plan) => {
            reusablePrefix =
              plan.previousResponseId !== null &&
              plan.inputItems.length < next.input.items.length;
          }),
        beforeReplay: () => this.#dropSocket(this.#socket),
      });
    } finally {
      this.#active = false;
    }
  }

  async *#streamOnce(
    request: ModelRequest,
    signal: AbortSignal,
    options: ModelTransportStreamOptions | undefined,
    onRequestPlan: (plan: RequestPlan) => void,
  ): AsyncIterable<ModelTransportEvent> {
    validateResponsesRequest(request);
    if (request.providerTurnState !== undefined) {
      this.#dropSocket(this.#socket);
    }
    this.#turnStates.seed(request.runId, request.providerTurnState ?? null);
    let controlSinkFailure: Readonly<{ failed: boolean; value: unknown }> = {
      failed: false,
      value: undefined,
    };
    try {
      const socket = await this.#connection(request.runId, signal, {
        controlSink:
          options?.controlSink === undefined
            ? undefined
            : {
                providerTurnStateObserved: async (providerTurnState) => {
                  try {
                    await options.controlSink?.providerTurnStateObserved(
                      providerTurnState,
                    );
                  } catch (error) {
                    controlSinkFailure = { failed: true, value: error };
                    throw error;
                  }
                },
              },
      });
      const plan = this.#requestPlan(request, socket);
      let call: Awaited<ReturnType<typeof beginModelCall>> = null;
      const decoder = new ResponsesProtocolDecoder({
        sequencePolicy: this.#sequencePolicy,
        onResponseIdentity: (id) => call?.responseIdentity(id),
        completedCheckpoint: (responseId) => {
          return this.#storeResponses
            ? responsesCheckpoint(responseId, this.modelIdentity())
            : null;
        },
      });
      const queue = new WebSocketMessageQueue({
        socket,
        signal,
        idleTimeoutMs: this.#idleTimeoutMs,
        maxMessageBytes: this.#maxMessageBytes,
        scheduler: this.#scheduler,
      });
      let completed = false;
      let outcome: "completed" | "failed" | "canceled" | "interrupted" =
        "interrupted";
      try {
        onRequestPlan(plan);
        call = await beginModelCall({
          options,
          identity: {
            ...this.modelIdentity(),
            agentVersionId: request.agentVersionId,
          },
          transport: "websocket",
          operation: "generate",
          signal,
        });
        await sendFrame(
          socket,
          JSON.stringify({
            type: "response.create",
            ...responsesRequestBody({
              request,
              previousResponseId: plan.previousResponseId,
              modelId: this.modelId,
              storeResponses: this.#storeResponses,
              requestProfile: this.#requestProfile,
              inputItems: plan.inputItems,
            }),
          }),
        );
        while (!decoder.terminal) {
          const value = await queue.next();
          for (const event of decoder.accept(value)) {
            if (
              event.type === "failed" &&
              event.code ===
                "responses_provider_websocket_connection_limit_reached"
            ) {
              this.#dropSocket(socket);
            }
            if (event.type === "completed") {
              completed = true;
              const providerTurnState = this.#turnStates.get(request.runId);
              const terminal =
                providerTurnState === null
                  ? event
                  : { ...event, providerTurnState };
              yield call?.event(terminal) ?? terminal;
              continue;
            }
            yield call?.event(event) ?? event;
          }
        }
        decoder.finish();
        if (queue.pendingCount > 0) {
          throw protocolError("responses_event_after_terminal");
        }
        if (completed && decoder.completedResponseId !== null) {
          this.#baseline = {
            socket,
            runId: request.runId,
            responseId: decoder.completedResponseId,
            history: [
              ...request.input.items.map(cloneInputItem),
              ...decoder.completedHistoryItems.map(cloneInputItem),
            ],
            toolsFingerprint: JSON.stringify(request.tools),
          };
        } else {
          this.#baseline = null;
        }
        outcome = "completed";
      } catch (error) {
        outcome = signal.aborted ? "canceled" : "failed";
        throw error;
      } finally {
        queue.close();
        if (!decoder.terminal) {
          this.#dropSocket(socket);
        }
        await call?.finish(
          outcome === "interrupted" && signal.aborted ? "canceled" : outcome,
        );
      }
    } catch (error) {
      this.#dropSocket(this.#socket);
      if (controlSinkFailure.failed) throw controlSinkFailure.value;
      if (signal.aborted) {
        throw transportError(
          "canceled",
          "segment_canceled",
          false,
          undefined,
          signal.reason,
        );
      }
      if (error instanceof ModelTransportError) {
        throw error;
      }
      throw transportError(
        "unavailable",
        "responses_websocket_unavailable",
        true,
        undefined,
        error,
      );
    }
  }

  releaseRun(runId: string): void {
    this.#turnStates.release(runId);
    if (this.#socketRunId === runId) this.#dropSocket(this.#socket);
  }

  async prewarm(signal: AbortSignal): Promise<void> {
    await this.#connection(null, signal);
  }

  async close(): Promise<void> {
    this.#dropSocket(this.#socket);
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

  async #connection(
    runId: string | null,
    signal: AbortSignal,
    options?: ModelTransportStreamOptions,
  ): Promise<WebSocket> {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      if (runId === null || this.#socketRunId === runId) {
        return this.#socket;
      }
      if (this.#socketRunId === null && this.#turnStates.get(runId) === null) {
        this.#socketRunId = runId;
        return this.#socket;
      }
    }
    this.#dropSocket(this.#socket);
    const headers: Record<string, string> = {};
    responsesHeaders(this.#apiKey, "application/json").forEach(
      (value, name) => {
        headers[name] = value;
      },
    );
    headers["OpenAI-Beta"] = WEBSOCKET_BETA;
    const turnState = runId === null ? null : this.#turnStates.get(runId);
    if (turnState !== null) headers[TURN_STATE_HEADER] = turnState;
    const socket = this.#factory(this.#endpoint, {
      headers,
      handshakeTimeout: this.#connectTimeoutMs,
      maxPayload: this.#maxMessageBytes,
      perMessageDeflate: false,
      followRedirects: false,
    });
    let unscopedTurnState = false;
    try {
      const response = await waitForOpen(socket, signal);
      const values = incomingHeaderValues(response, TURN_STATE_HEADER);
      if (runId === null && values.length > 0) {
        parseTurnStateHeader(values);
        unscopedTurnState = true;
      }
      if (runId !== null) {
        await this.#turnStates.observe(
          runId,
          values,
          options?.controlSink?.providerTurnStateObserved,
        );
      }
    } catch (error) {
      this.#dropSocket(socket);
      throw error;
    }
    this.#socket = socket;
    this.#socketRunId = runId;
    this.#baseline = null;
    socket.on("error", () => this.#dropSocket(socket));
    socket.on("close", () => this.#dropSocket(socket));
    if (unscopedTurnState) this.#dropSocket(socket);
    return socket;
  }

  #requestPlan(request: ModelRequest, socket: WebSocket): RequestPlan {
    if (request.input.strategy === "providerCheckpoint") {
      return {
        previousResponseId: responseIdFromResponsesCheckpoint(
          request.input.checkpoint,
          this.modelIdentity(),
        ),
        inputItems: request.input.items.slice(
          request.input.newHistoryStartIndex,
        ),
      };
    }
    if (
      this.#baseline !== null &&
      this.#baseline.socket === socket &&
      this.#baseline.runId === request.runId &&
      this.#baseline.toolsFingerprint === JSON.stringify(request.tools) &&
      historyHasPrefix(request.input.items, this.#baseline.history)
    ) {
      return {
        previousResponseId: this.#baseline.responseId,
        inputItems: request.input.items.slice(this.#baseline.history.length),
      };
    }
    return { previousResponseId: null, inputItems: request.input.items };
  }

  #dropSocket(socket: WebSocket | null): void {
    if (socket === null) {
      return;
    }
    if (this.#socket === socket) {
      this.#socket = null;
      this.#socketRunId = null;
      this.#baseline = null;
    }
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.once("error", () => undefined);
      }
      socket.terminate();
    }
  }
}

export class ResilientResponsesTransport implements ModelTransportPort {
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly modelId: string;
  readonly #websocket: WebSocketResponsesTransport;
  readonly #http: DirectResponsesTransport;
  readonly #turnStates = new ResponsesTurnStateAuthority();
  readonly #websocketMaxRetries: number;
  #websocketFailures = 0;
  #httpOnly = false;
  #pendingFallbackCode: string | null = null;

  constructor(
    config: WebSocketResponsesTransportConfig & {
      websocketMaxRetries?: number;
    },
    dependencies: {
      fetch?: ResponsesFetch;
      factory?: WebSocketFactory;
      scheduler?: ResponsesTimerScheduler;
    } = {},
  ) {
    this.modelId = config.model;
    this.#websocketMaxRetries = nonNegativeInteger(
      config.websocketMaxRetries ?? DEFAULT_WEBSOCKET_RETRIES,
      "responses_websocket_retries_invalid",
    );
    this.#http = new DirectResponsesTransport(config, {
      fetch: dependencies.fetch,
      scheduler: dependencies.scheduler,
      identity: HYBRID_IDENTITY,
      turnStates: this.#turnStates,
    });
    this.#websocket = new WebSocketResponsesTransport(config, {
      factory: dependencies.factory,
      scheduler: dependencies.scheduler,
      identity: HYBRID_IDENTITY,
      turnStates: this.#turnStates,
    });
    if (
      this.#http.adapterName !== this.#websocket.adapterName ||
      this.#http.adapterVersion !== this.#websocket.adapterVersion
    ) {
      throw protocolError("responses_hybrid_identity_mismatch");
    }
    this.adapterName = this.#websocket.adapterName;
    this.adapterVersion = this.#websocket.adapterVersion;
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    options?: ModelTransportStreamOptions,
  ): AsyncIterable<ModelTransportEvent> {
    if (this.#httpOnly) {
      if (this.#pendingFallbackCode !== null) {
        yield {
          type: "transport.fallback",
          fromTransport: "websocket",
          toTransport: "http",
          code: this.#pendingFallbackCode,
          discardedOutput: false,
        };
        this.#pendingFallbackCode = null;
      }
      yield* this.#http.stream(request, signal, options);
      return;
    }
    let emittedObservation = false;
    try {
      for await (const event of this.#websocket.stream(
        request,
        signal,
        options,
      )) {
        if (
          event.type === "transport.fallback" &&
          event.inputStrategy === "manual"
        ) {
          request = {
            ...request,
            input: { strategy: "manual", items: request.input.items },
          };
        }
        if (
          event.type === "output.delta" ||
          event.type === "reasoning.delta" ||
          event.type === "reasoning.part.added"
        ) {
          emittedObservation = true;
        }
        if (event.type === "failed" && event.retryable) {
          throw transportError("unavailable", event.code, true);
        }
        yield event;
      }
      this.#websocketFailures = 0;
      return;
    } catch (error) {
      if (!(error instanceof ModelTransportError) || !error.retryable) {
        if (
          error instanceof ModelTransportError &&
          error.code === "responses_websocket_upgrade_required"
        ) {
          yield* this.#fallback(
            request,
            signal,
            error.code,
            emittedObservation,
            options,
          );
          return;
        }
        throw error;
      }
      this.#websocketFailures += 1;
      if (this.#websocketFailures <= this.#websocketMaxRetries) {
        throw error;
      }
      yield* this.#fallback(
        request,
        signal,
        error.code,
        emittedObservation,
        options,
      );
    }
  }

  async prewarm(signal: AbortSignal): Promise<void> {
    try {
      await this.#websocket.prewarm(signal);
    } catch (error) {
      if (
        error instanceof ModelTransportError &&
        error.code === "responses_websocket_upgrade_required"
      ) {
        this.#httpOnly = true;
        this.#pendingFallbackCode = error.code;
        await this.#websocket.close();
        return;
      }
      if (!(error instanceof ModelTransportError) || !error.retryable) {
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    await this.#websocket.close();
  }

  releaseRun(runId: string): void {
    this.#turnStates.release(runId);
    this.#websocket.releaseRun(runId);
    this.#http.releaseRun(runId);
  }

  async *#fallback(
    request: ModelRequest,
    signal: AbortSignal,
    code: string,
    discardedOutput: boolean,
    options?: ModelTransportStreamOptions,
  ): AsyncIterable<ModelTransportEvent> {
    this.#httpOnly = true;
    await this.#websocket.close();
    yield {
      type: "transport.fallback",
      fromTransport: "websocket",
      toTransport: "http",
      code,
      discardedOutput,
    };
    yield* this.#http.stream(request, signal, options);
  }
}

type IncrementalBaseline = Readonly<{
  socket: WebSocket;
  runId: string;
  responseId: string;
  history: readonly ModelInputItem[];
  toolsFingerprint: string;
}>;

type RequestPlan = Readonly<{
  previousResponseId: string | null;
  inputItems: readonly ModelInputItem[];
}>;

async function waitForOpen(
  socket: WebSocket,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return await new Promise<IncomingMessage>((resolve, reject) => {
    let upgradeResponse: IncomingMessage | null = null;
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("upgrade", onUpgrade);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("unexpected-response", onUnexpectedResponse);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void) => {
      cleanup();
      callback();
    };
    const onUpgrade = (response: IncomingMessage) => {
      upgradeResponse = response;
    };
    const onOpen = () =>
      settle(() =>
        upgradeResponse === null
          ? reject(protocolError("responses_websocket_headers_missing"))
          : resolve(upgradeResponse),
      );
    const onError = (error: Error) =>
      settle(() =>
        reject(
          transportError(
            "unavailable",
            "responses_websocket_unavailable",
            true,
            undefined,
            error,
          ),
        ),
      );
    const onClose = () =>
      settle(() =>
        reject(
          transportError("unavailable", "responses_websocket_closed", true),
        ),
      );
    const onUnexpectedResponse = (
      _request: ClientRequest,
      response: IncomingMessage,
    ) => {
      response.resume();
      settle(() =>
        reject(
          response.statusCode === 426
            ? transportError(
                "unavailable",
                "responses_websocket_upgrade_required",
                false,
              )
            : transportError(
                "unavailable",
                "responses_websocket_handshake_failed",
                true,
              ),
        ),
      );
    };
    const onAbort = () =>
      settle(() =>
        reject(
          transportError(
            "canceled",
            "segment_canceled",
            false,
            undefined,
            signal.reason,
          ),
        ),
      );
    socket.once("open", onOpen);
    socket.once("upgrade", onUpgrade);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("unexpected-response", onUnexpectedResponse);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function incomingHeaderValues(
  response: IncomingMessage,
  name: string,
): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index]!.toLowerCase() === name) {
      values.push(response.rawHeaders[index + 1]!);
    }
  }
  return values;
}

async function sendFrame(socket: WebSocket, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(payload, (error) => {
      if (error === undefined || error === null) {
        resolve();
        return;
      }
      reject(
        transportError(
          "unavailable",
          "responses_websocket_send_failed",
          true,
          undefined,
          error,
        ),
      );
    });
  });
}

function websocketEndpoint(endpoint: URL): URL {
  const websocket = new URL(endpoint);
  websocket.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return websocket;
}

function historyHasPrefix(
  history: readonly ModelInputItem[],
  prefix: readonly ModelInputItem[],
): boolean {
  return (
    history.length >= prefix.length &&
    prefix.every(
      (item, index) => JSON.stringify(item) === JSON.stringify(history[index]),
    )
  );
}

function cloneInputItem(item: ModelInputItem): ModelInputItem {
  return { ...item };
}

function requireNonEmpty(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw protocolError(code);
  }
  return value;
}

function boundedNonEmpty(
  value: unknown,
  maxLength: number,
  code: string,
): string {
  const parsed = requireNonEmpty(value, code);
  if (parsed.length > maxLength) {
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

function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw protocolError(code);
  }
  return Number(value);
}

const systemScheduler: ResponsesTimerScheduler = {
  schedule: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};
