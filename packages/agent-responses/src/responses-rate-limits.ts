import type {
  CreditsSnapshot,
  RateLimitSnapshot,
  RateLimitWindow,
} from "@crewon/contracts/runtime";

const MAX_ERROR_BODY_BYTES = 64 * 1024;

export function parseResponsesRateLimitHeaders(
  headers: Headers,
): RateLimitSnapshot | null {
  const activeLimit = parseActiveLimit(headers.get("x-codex-active-limit"));
  const headerLimit = activeLimit.replaceAll("_", "-");
  const prefix = `x-${headerLimit}`;
  const primary = parseWindow(headers, prefix, "primary");
  const secondary = parseWindow(headers, prefix, "secondary");
  const credits = parseCredits(headers);
  if (primary === null && secondary === null && credits === null) {
    return null;
  }
  return {
    limitId: activeLimit,
    limitName: boundedHeader(headers.get(`${prefix}-limit-name`), 256),
    primary,
    secondary,
    credits,
    individualLimit: null,
    planType: null,
    rateLimitReachedType: null,
  };
}

export async function readBoundedErrorBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<string | null> {
  if (body === null) {
    return null;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        result += decoder.decode();
        return result;
      }
      size += next.value.byteLength;
      if (size > MAX_ERROR_BODY_BYTES) {
        await reader.cancel("responses_error_body_too_large");
        return null;
      }
      result += decoder.decode(next.value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export function isUsageLimitReachedBody(body: string | null): boolean {
  if (body === null) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      isPlainObject(parsed) &&
      isPlainObject(parsed.error) &&
      parsed.error.type === "usage_limit_reached"
    );
  } catch {
    return false;
  }
}

export function isContextWindowExceededBody(body: string | null): boolean {
  if (body === null) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      isPlainObject(parsed) &&
      isPlainObject(parsed.error) &&
      (parsed.error.code === "context_length_exceeded" ||
        parsed.error.type === "context_length_exceeded")
    );
  } catch {
    return false;
  }
}

export function isCyberPolicyBody(body: string | null): boolean {
  if (body === null) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      isPlainObject(parsed) &&
      isPlainObject(parsed.error) &&
      parsed.error.code === "cyber_policy"
    );
  } catch {
    return false;
  }
}

function parseWindow(
  headers: Headers,
  prefix: string,
  name: "primary" | "secondary",
): RateLimitWindow | null {
  const usedPercent = finitePercentage(
    headers.get(`${prefix}-${name}-used-percent`),
  );
  if (usedPercent === null) {
    return null;
  }
  return {
    usedPercent,
    windowMinutes: nonNegativeInteger(
      headers.get(`${prefix}-${name}-window-minutes`),
    ),
    resetsAt: nonNegativeInteger(headers.get(`${prefix}-${name}-reset-at`)),
  };
}

function parseCredits(headers: Headers): CreditsSnapshot | null {
  const hasCredits = headerBoolean(headers.get("x-crewon-credits-has-credits"));
  const unlimited = headerBoolean(headers.get("x-crewon-credits-unlimited"));
  if (hasCredits === null || unlimited === null) {
    return null;
  }
  return {
    hasCredits,
    unlimited,
    balance: boundedHeader(headers.get("x-crewon-credits-balance"), 128),
  };
}

function parseActiveLimit(value: string | null): string {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  return normalized !== undefined && /^[a-z0-9_]{1,64}$/.test(normalized)
    ? normalized
    : "codex";
}

function finitePercentage(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : null;
}

function nonNegativeInteger(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function headerBoolean(value: string | null): boolean | null {
  if (value === "1" || value?.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value?.toLowerCase() === "false") {
    return false;
  }
  return null;
}

function boundedHeader(value: string | null, maxLength: number): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined &&
    trimmed.length > 0 &&
    trimmed.length <= maxLength
    ? trimmed
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
