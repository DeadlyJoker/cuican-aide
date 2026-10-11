import {
  MODEL_HTTP_NETWORK_CAUSE_CODES,
  type ModelHttpNetworkCauseCode,
  type ModelHttpResponseDiagnostics,
  type ModelHttpTerminationDiagnostics,
} from "@crewon/domain";

type ResponseHeaders = Readonly<{ get(name: string): string | null }>;

/** Select only response correlation headers, never enumerate request or response headers. */
export function modelHttpResponseDiagnostics(
  status: number,
  headers: ResponseHeaders,
): ModelHttpResponseDiagnostics | null {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599)
    return null;
  const selected: {
    status: number;
    contentType?: string;
    server?: string;
    cfRay?: string;
    oneApiRequestId?: string;
  } = { status };
  for (const [name, key, limit] of [
    ["content-type", "contentType", 256],
    ["server", "server", 128],
    ["cf-ray", "cfRay", 128],
    ["x-oneapi-request-id", "oneApiRequestId", 256],
  ] as const) {
    try {
      const value = headers.get(name)?.trim();
      if (
        value !== undefined &&
        value.length > 0 &&
        value.length <= limit &&
        /^[\u0020-\u007e]+$/u.test(value)
      )
        selected[key] = value;
    } catch {
      // Diagnostics must not introduce a new failure into a provider request.
    }
  }
  return selected;
}

export function modelHttpTerminationDiagnostics(input: {
  reason: ModelHttpTerminationDiagnostics["reason"];
  code?: string;
  cause?: unknown;
}): ModelHttpTerminationDiagnostics {
  const networkCode = boundedNetworkCauseCode(input.cause);
  return {
    reason: input.reason,
    ...(typeof input.code === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/u.test(input.code)
      ? { code: input.code }
      : {}),
    ...(networkCode === null ? {} : { networkCode }),
  };
}

/** Inspect bounded data properties only: no getters, messages, stacks, URLs, or raw causes. */
export function boundedNetworkCauseCode(
  value: unknown,
): ModelHttpNetworkCauseCode | null {
  const pending = [{ value, depth: 0 }];
  const visited = new Set<object>();
  for (
    let inspected = 0;
    pending.length > 0 && inspected < 16;
    inspected += 1
  ) {
    const current = pending.shift()!;
    if (
      typeof current.value !== "object" ||
      current.value === null ||
      visited.has(current.value)
    )
      continue;
    visited.add(current.value);
    const code = ownDataProperty(current.value, "code");
    if (
      typeof code === "string" &&
      (MODEL_HTTP_NETWORK_CAUSE_CODES as readonly string[]).includes(code)
    )
      return code as ModelHttpNetworkCauseCode;
    if (current.depth >= 4) continue;
    const depth = current.depth + 1;
    pending.push({ value: ownDataProperty(current.value, "cause"), depth });
    const errors = ownDataProperty(current.value, "errors");
    try {
      if (!Array.isArray(errors)) continue;
      const length = ownDataProperty(errors, "length");
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0
      )
        continue;
      for (let index = 0; index < Math.min(length, 4); index += 1)
        pending.push({ value: ownDataProperty(errors, String(index)), depth });
    } catch {
      // Even Array.isArray can throw for a revoked proxy. Preserve the original failure.
    }
  }
  return null;
}

function ownDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}
