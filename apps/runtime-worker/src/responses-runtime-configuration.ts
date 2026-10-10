import type { DirectResponsesTransportConfig } from "@crewon/agent-responses";

import {
  environmentOr,
  parseNonNegativeInteger,
  parsePositiveInteger,
  requiredEnvironment,
  type RuntimeEnvironment,
} from "./runtime-environment-values.ts";

export type ResolvedResponsesRuntimeConfiguration = Readonly<{
  config: Omit<DirectResponsesTransportConfig, "apiKey"> &
    Readonly<{
      storeResponses: boolean;
      requestProfile: "standard" | "responsesLite";
      idleTimeoutMs: number;
      sequencePolicy: "required" | "whenPresent";
      identityPolicy: "strict" | "terminalAuthoritative";
    }>;
  websocket: Readonly<{ connectTimeoutMs: number; maxRetries: number }> | null;
}>;

/** Resolves the effective profile without reading or retaining credentials. */
export function resolveResponsesRuntimeConfiguration(
  environment: RuntimeEnvironment,
  providerId?: string | null,
): ResolvedResponsesRuntimeConfiguration {
  const endpoint = environmentOr(
    "CREWON_RESPONSES_ENDPOINT",
    "https://api.openai.com/v1/responses",
    environment,
  );
  const compatibility = responsesCompatibilityProfile(providerId, endpoint);
  // Only replaying a persisted legacy bootstrap may opt into the old coalescer.
  // Live gateway output is forwarded immediately by default.
  const legacyFlushBytes =
    environment.CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES;
  if (
    legacyFlushBytes !== undefined &&
    (compatibility === null || legacyFlushBytes !== "1024")
  )
    throw new Error("CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES_invalid");
  const config = Object.freeze({
    endpoint,
    model: requiredEnvironment("CREWON_MODEL_ID", environment),
    ...(environment.CREWON_RESPONSES_MAX_OUTPUT_TOKENS === undefined
      ? {}
      : {
          maxOutputTokens: parsePositiveInteger(
            environment.CREWON_RESPONSES_MAX_OUTPUT_TOKENS,
            "CREWON_RESPONSES_MAX_OUTPUT_TOKENS_invalid",
          ),
        }),
    storeResponses: parseBoolean(
      compatibility === null
        ? (environment.CREWON_RESPONSES_STORE ?? "false")
        : "false",
      "CREWON_RESPONSES_STORE_invalid",
    ),
    requestProfile:
      compatibility?.requestProfile ??
      parseResponsesRequestProfile(
        environment.CREWON_RESPONSES_REQUEST_PROFILE ?? "standard",
      ),
    idleTimeoutMs: parsePositiveInteger(
      environment.CREWON_RESPONSES_IDLE_TIMEOUT_MS ?? "60000",
      "CREWON_RESPONSES_IDLE_TIMEOUT_MS_invalid",
    ),
    sequencePolicy:
      compatibility?.sequencePolicy ??
      parseSequencePolicy(
        environment.CREWON_RESPONSES_SEQUENCE_POLICY ?? "required",
      ),
    identityPolicy: compatibility === null ? "strict" : "terminalAuthoritative",
    ...(legacyFlushBytes === undefined ? {} : { outputDeltaFlushBytes: 1024 }),
  } as const);
  const websocket =
    compatibility === null &&
    parseBoolean(
      environment.CREWON_RESPONSES_WEBSOCKET_ENABLED ?? "false",
      "CREWON_RESPONSES_WEBSOCKET_ENABLED_invalid",
    )
      ? Object.freeze({
          connectTimeoutMs: parsePositiveInteger(
            environment.CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS ??
              "10000",
            "CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS_invalid",
          ),
          maxRetries: parseNonNegativeInteger(
            environment.CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES ?? "2",
            "CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES_invalid",
          ),
        })
      : null;
  return Object.freeze({ config, websocket });
}

/** Third-party gateways use the portable Responses subset and may omit event sequence numbers. */
export function responsesCompatibilityProfile(
  providerId: string | null | undefined,
  endpoint?: string,
): Readonly<{
  requestProfile: "responsesLite";
  sequencePolicy: "whenPresent";
}> | null {
  if (endpoint !== undefined) {
    try {
      const url = new URL(endpoint);
      return url.protocol === "https:" &&
        url.hostname === "api.openai.com" &&
        url.pathname.replace(/\/+$/u, "") === "/v1/responses"
        ? null
        : { requestProfile: "responsesLite", sequencePolicy: "whenPresent" };
    } catch {
      return { requestProfile: "responsesLite", sequencePolicy: "whenPresent" };
    }
  }
  return providerId === undefined ||
    providerId === null ||
    providerId === "openai" ||
    providerId === "openai-api"
    ? null
    : { requestProfile: "responsesLite", sequencePolicy: "whenPresent" };
}

function parseBoolean(value: string, code: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(code);
}

function parseSequencePolicy(value: string): "required" | "whenPresent" {
  if (value === "required" || value === "whenPresent") return value;
  throw new Error("CREWON_RESPONSES_SEQUENCE_POLICY_invalid");
}

function parseResponsesRequestProfile(
  value: string,
): "standard" | "responsesLite" {
  if (value === "standard" || value === "responsesLite") return value;
  throw new Error("CREWON_RESPONSES_REQUEST_PROFILE_invalid");
}
