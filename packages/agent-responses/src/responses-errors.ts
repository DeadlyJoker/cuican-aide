import {
  ModelTransportError,
  type ModelTransportErrorCategory,
} from "@crewon/agent-kernel/runtime";

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

export function httpError(
  status: number,
  retryAfter: string | null,
  classification: Readonly<{
    usageLimitReached: boolean;
    contextWindowExceeded: boolean;
    cyberPolicy: boolean;
  }> = {
    usageLimitReached: false,
    contextWindowExceeded: false,
    cyberPolicy: false,
  },
): ModelTransportError {
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (status === 401) {
    return transportError(
      "authentication",
      "responses_authentication_failed",
      false,
    );
  }
  if (status === 403) {
    return transportError("permission", "responses_permission_denied", false);
  }
  if (status === 404) {
    return transportError("notFound", "responses_endpoint_not_found", false);
  }
  if (status === 408) {
    return transportError(
      "timeout",
      "responses_request_timeout",
      true,
      retryAfterMs,
    );
  }
  if (status === 409 || status === 429) {
    if (status === 429 && classification.usageLimitReached) {
      return transportError(
        "rateLimit",
        "responses_usage_limit_reached",
        false,
      );
    }
    return transportError(
      status === 429 ? "rateLimit" : "unavailable",
      status === 429 ? "responses_rate_limited" : "responses_conflict",
      true,
      retryAfterMs,
    );
  }
  if (status === 400 && classification.cyberPolicy) {
    return transportError(
      "permission",
      "responses_provider_cyber_policy",
      false,
    );
  }
  if (status === 400 && classification.contextWindowExceeded) {
    return transportError(
      "invalidRequest",
      "responses_provider_context_length_exceeded",
      false,
    );
  }
  if (status >= 400 && status < 500) {
    return transportError(
      "invalidRequest",
      "responses_request_rejected",
      false,
    );
  }
  if (status >= 500 && status < 600) {
    return transportError(
      "unavailable",
      "responses_provider_unavailable",
      true,
      retryAfterMs,
    );
  }
  return transportError("protocol", "responses_http_status_invalid", false);
}

export function protocolError(
  code: string,
  cause?: unknown,
): ModelTransportError {
  return transportError("protocol", code, false, undefined, cause);
}

export function transportError(
  category: ModelTransportErrorCategory,
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

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1_000), MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}
