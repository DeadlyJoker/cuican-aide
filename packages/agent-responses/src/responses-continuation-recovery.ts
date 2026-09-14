import {
  ModelTransportError,
  type ModelRequest,
  type ModelTransportEvent,
} from "@crewon/agent-kernel";

export const PREVIOUS_RESPONSE_REJECTED =
  "responses_previous_response_not_found";

/** Match a request rejection, never a provider's free-form message or a generic 404. */
export function isPreviousResponseRejected(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.error)) return false;
  return (
    value.error.code === "previous_response_not_found" &&
    (value.error.param === undefined ||
      value.error.param === "previous_response_id") &&
    (value.status === undefined || value.status === 400 || value.status === 404)
  );
}

export function isPreviousResponseRejectedBody(body: string | null): boolean {
  if (body === null) return false;
  try {
    return isPreviousResponseRejected(JSON.parse(body));
  } catch {
    return false;
  }
}

/** One replacement request; its errors propagate to the caller's existing retry budget. */
export async function* recoverResponsesContinuation(options: {
  request: ModelRequest;
  signal: AbortSignal;
  transport: "http" | "websocket";
  canReplay: () => boolean;
  stream: (request: ModelRequest) => AsyncIterable<ModelTransportEvent>;
  beforeReplay?: () => void;
}): AsyncIterable<ModelTransportEvent> {
  let observedResponse = false;
  let rejected = false;
  const canRecover = () =>
    !observedResponse &&
    !options.signal.aborted &&
    options.request.reconcileCheckpoint === undefined &&
    options.canReplay();
  try {
    for await (const event of options.stream(options.request)) {
      if (
        event.type === "failed" &&
        event.code === PREVIOUS_RESPONSE_REJECTED &&
        canRecover()
      ) {
        rejected = true;
        break;
      }
      if (event.type !== "rate_limit") observedResponse = true;
      yield event;
    }
  } catch (error) {
    if (
      !(error instanceof ModelTransportError) ||
      error.code !== PREVIOUS_RESPONSE_REJECTED ||
      !canRecover()
    )
      throw error;
    rejected = true;
  }
  if (!rejected) return;
  yield {
    type: "transport.fallback",
    fromTransport: options.transport,
    toTransport: options.transport,
    code: PREVIOUS_RESPONSE_REJECTED,
    discardedOutput: false,
    inputStrategy: "manual",
  };
  // Yield permits the Worker to persist the audit and observe cancellation first.
  if (options.signal.aborted) {
    throw new ModelTransportError({
      category: "canceled",
      code: "segment_canceled",
      retryable: false,
    });
  }
  options.beforeReplay?.();
  yield* options.stream({
    ...options.request,
    input: { strategy: "manual", items: options.request.input.items },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
