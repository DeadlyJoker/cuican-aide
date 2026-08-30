import { createHash, timingSafeEqual } from "node:crypto";

import {
  type ActorContext,
  type AutomationAuthorizationPort,
  type AuthorizationDecision,
  type AuthorizationPort,
} from "@crewon/application";

export type ControlAuthorizationRequest =
  | Parameters<AuthorizationPort["authorize"]>[0]
  | Parameters<AutomationAuthorizationPort["authorize"]>[0];

import {
  ControlApiIdentityError,
  type ControlApiIdentityPort,
  type ControlApiRequestContext,
} from "./control-api-ports.ts";

export const PRODUCTION_BFF_AUTHORIZATION_HEADER = "x-crewon-bff-authorization";

const ACTOR_INJECTION_HEADERS = [
  "x-crewon-principal-id",
  "x-crewon-actor-id",
  "x-crewon-tenant-id",
  "x-crewon-space-id",
] as const;
const MAX_ACCESS_TOKEN_BYTES = 8 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_ISSUER_LENGTH = 2_048;
const MAX_AUDIENCE_LENGTH = 512;
const MAX_REASON_CODE_LENGTH = 128;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;
const MAX_ASSERTION_LIFETIME_MS = 60 * 60 * 1_000;

export type TrustedBffRequest = Readonly<{
  method: string;
  url: string;
  remoteAddress: string;
  origin: string | null;
  serviceAuthorization: string | null;
}>;

/** Authenticates the direct BFF peer independently from the end-user token. */
export interface TrustedBffRequestVerifierPort {
  verify(request: TrustedBffRequest): void | Promise<void>;
}

/** Verifies a user Control token and returns the bounded identity assertion. */
export interface ControlTokenVerifierPort {
  verify(input: { accessToken: string; signal: AbortSignal }): Promise<unknown>;
}

/** Evaluates a single authorization request against the production policy authority. */
export interface PolicyDecisionPort {
  decide(
    input: ControlAuthorizationRequest & {
      signal: AbortSignal;
    },
  ): Promise<unknown>;
}

/** Provides a bounded cancellation deadline for external security authorities. */
export interface SecurityDeadlinePort {
  run<T>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

export class AbortSecurityDeadline implements SecurityDeadlinePort {
  async run<T>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("security_authority_timeout"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

export class StaticTrustedBffRequestVerifier
  implements TrustedBffRequestVerifierPort
{
  readonly #serviceToken: string;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #allowedRemoteAddresses: ReadonlySet<string>;

  constructor(config: {
    serviceToken: string;
    allowedOrigins: readonly string[];
    allowedRemoteAddresses: readonly string[];
  }) {
    requireSecret(config.serviceToken, "bff_service_token_invalid");
    this.#allowedOrigins = requireBoundedSet(
      config.allowedOrigins,
      MAX_ISSUER_LENGTH,
      "bff_allowed_origins_invalid",
    );
    this.#allowedRemoteAddresses = requireBoundedSet(
      config.allowedRemoteAddresses,
      256,
      "bff_allowed_remote_addresses_invalid",
    );
    this.#serviceToken = config.serviceToken;
  }

  verify(request: TrustedBffRequest): void {
    requireBounded(request.method, 32, "bff_request_invalid");
    requireBounded(request.url, 8 * 1_024, "bff_request_invalid");
    if (!this.#allowedRemoteAddresses.has(request.remoteAddress)) {
      throw new ControlApiIdentityError(
        "authorization",
        "bff_peer_not_allowed",
      );
    }
    if (request.origin === null || !this.#allowedOrigins.has(request.origin)) {
      throw new ControlApiIdentityError(
        "authorization",
        "bff_origin_not_allowed",
      );
    }
    const serviceToken = parseBearer(
      request.serviceAuthorization,
      "bff_service_credential_invalid",
    );
    if (!safeEqual(serviceToken, this.#serviceToken)) {
      throw new ControlApiIdentityError(
        "authentication",
        "bff_service_credential_invalid",
      );
    }
  }
}

type IdentityCacheEntry = Readonly<{
  actor: ActorContext;
  expiresAtMs: number;
}>;

export class ProductionControlApiIdentity implements ControlApiIdentityPort {
  readonly #trustedBff: TrustedBffRequestVerifierPort;
  readonly #tokens: ControlTokenVerifierPort;
  readonly #deadline: SecurityDeadlinePort;
  readonly #expectedIssuer: string;
  readonly #expectedAudience: string;
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #cacheMaxEntries: number;
  readonly #maxAssertionLifetimeMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, IdentityCacheEntry>();

  constructor(config: {
    trustedBff: TrustedBffRequestVerifierPort;
    tokens: ControlTokenVerifierPort;
    expectedIssuer: string;
    expectedAudience: string;
    timeoutMs: number;
    cacheTtlMs?: number;
    cacheMaxEntries?: number;
    maxAssertionLifetimeMs?: number;
    deadline?: SecurityDeadlinePort;
    now?: () => number;
  }) {
    requirePort(config.trustedBff, "trusted_bff_verifier_required");
    requirePort(config.tokens, "control_token_verifier_required");
    requireBounded(
      config.expectedIssuer,
      MAX_ISSUER_LENGTH,
      "identity_expected_issuer_invalid",
    );
    requireBounded(
      config.expectedAudience,
      MAX_AUDIENCE_LENGTH,
      "identity_expected_audience_invalid",
    );
    requireIntegerBetween(
      config.timeoutMs,
      1,
      MAX_TIMEOUT_MS,
      "identity_timeout_invalid",
    );
    const cacheTtlMs = config.cacheTtlMs ?? 0;
    requireIntegerBetween(
      cacheTtlMs,
      0,
      MAX_CACHE_TTL_MS,
      "identity_cache_ttl_invalid",
    );
    const cacheMaxEntries = config.cacheMaxEntries ?? 1_000;
    requireIntegerBetween(
      cacheMaxEntries,
      1,
      MAX_CACHE_ENTRIES,
      "identity_cache_entries_invalid",
    );
    const maxAssertionLifetimeMs =
      config.maxAssertionLifetimeMs ?? 15 * 60 * 1_000;
    requireIntegerBetween(
      maxAssertionLifetimeMs,
      1,
      MAX_ASSERTION_LIFETIME_MS,
      "identity_assertion_lifetime_invalid",
    );
    this.#trustedBff = config.trustedBff;
    this.#tokens = config.tokens;
    this.#deadline = config.deadline ?? new AbortSecurityDeadline();
    this.#expectedIssuer = config.expectedIssuer;
    this.#expectedAudience = config.expectedAudience;
    this.#timeoutMs = config.timeoutMs;
    this.#cacheTtlMs = cacheTtlMs;
    this.#cacheMaxEntries = cacheMaxEntries;
    this.#maxAssertionLifetimeMs = maxAssertionLifetimeMs;
    this.#now = config.now ?? Date.now;
  }

  async resolveActor(request: ControlApiRequestContext): Promise<ActorContext> {
    await this.#trustedBff.verify({
      method: request.method,
      url: request.url,
      remoteAddress: request.remoteAddress,
      origin: singleHeader(request.headers.origin),
      serviceAuthorization: singleHeader(
        request.headers[PRODUCTION_BFF_AUTHORIZATION_HEADER],
      ),
    });
    for (const header of ACTOR_INJECTION_HEADERS) {
      if (request.headers[header] !== undefined) {
        throw new ControlApiIdentityError(
          "authorization",
          "actor_header_forbidden",
        );
      }
    }
    const accessToken = parseBearer(
      singleHeader(request.headers.authorization),
      "control_token_invalid",
    );
    if (Buffer.byteLength(accessToken) > MAX_ACCESS_TOKEN_BYTES) {
      throw new ControlApiIdentityError(
        "authentication",
        "control_token_invalid",
      );
    }
    const now = this.#now();
    const cacheKey = createHash("sha256").update(accessToken).digest("hex");
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) {
      if (cached.expiresAtMs > now) {
        this.#cache.delete(cacheKey);
        this.#cache.set(cacheKey, cached);
        return structuredClone(cached.actor);
      }
      this.#cache.delete(cacheKey);
    }

    let assertion: unknown;
    try {
      assertion = await this.#deadline.run(this.#timeoutMs, (signal) =>
        this.#tokens.verify({ accessToken, signal }),
      );
    } catch (error) {
      throw new ControlApiIdentityError(
        "authentication",
        "identity_verification_failed",
        { cause: error },
      );
    }
    let verified: ReturnType<typeof parseIdentityAssertion>;
    try {
      verified = parseIdentityAssertion(assertion, {
        expectedIssuer: this.#expectedIssuer,
        expectedAudience: this.#expectedAudience,
        now,
        maxAssertionLifetimeMs: this.#maxAssertionLifetimeMs,
      });
    } catch (error) {
      if (error instanceof ControlApiIdentityError) {
        throw error;
      }
      throw new ControlApiIdentityError(
        "authentication",
        "identity_assertion_invalid",
        { cause: error },
      );
    }
    if (this.#cacheTtlMs > 0) {
      this.#cache.set(cacheKey, {
        actor: structuredClone(verified.actor),
        expiresAtMs: Math.min(verified.expiresAtMs, now + this.#cacheTtlMs),
      });
      while (this.#cache.size > this.#cacheMaxEntries) {
        const oldest = this.#cache.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.#cache.delete(oldest);
      }
    }
    return structuredClone(verified.actor);
  }
}

export class DynamicPolicyAuthorization
  implements AuthorizationPort, AutomationAuthorizationPort
{
  readonly #policy: PolicyDecisionPort;
  readonly #deadline: SecurityDeadlinePort;
  readonly #timeoutMs: number;

  constructor(config: {
    policy: PolicyDecisionPort;
    timeoutMs: number;
    deadline?: SecurityDeadlinePort;
  }) {
    requirePort(config.policy, "policy_decision_port_required");
    requireIntegerBetween(
      config.timeoutMs,
      1,
      MAX_TIMEOUT_MS,
      "policy_timeout_invalid",
    );
    this.#policy = config.policy;
    this.#deadline = config.deadline ?? new AbortSecurityDeadline();
    this.#timeoutMs = config.timeoutMs;
  }

  async authorize(
    request: ControlAuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    validateActor(request.actor);
    validatePolicyRequest(request);
    if (
      request.actor.tenantId !== request.resource.tenantId ||
      request.actor.spaceId !== request.resource.spaceId
    ) {
      return { outcome: "deny", reasonCode: "actor_scope_mismatch" };
    }
    const response = await this.#deadline.run(this.#timeoutMs, (signal) =>
      this.#policy.decide({ ...request, signal }),
    );
    return parsePolicyDecision(response);
  }
}

function parseIdentityAssertion(
  value: unknown,
  expected: {
    expectedIssuer: string;
    expectedAudience: string;
    now: number;
    maxAssertionLifetimeMs: number;
  },
): { actor: ActorContext; expiresAtMs: number } {
  const record = exactRecord(
    value,
    [
      "issuer",
      "audience",
      "principalId",
      "actorId",
      "tenantId",
      "spaceId",
      "issuedAt",
      "expiresAt",
    ],
    "identity_assertion_invalid",
  );
  const issuer = boundedString(
    record.issuer,
    MAX_ISSUER_LENGTH,
    "identity_assertion_invalid",
  );
  if (Array.isArray(record.audience) && record.audience.length > 8) {
    throw new ControlApiIdentityError(
      "authentication",
      "identity_assertion_invalid",
    );
  }
  const audiences = Array.isArray(record.audience)
    ? record.audience.map((audience) =>
        boundedString(
          audience,
          MAX_AUDIENCE_LENGTH,
          "identity_assertion_invalid",
        ),
      )
    : [
        boundedString(
          record.audience,
          MAX_AUDIENCE_LENGTH,
          "identity_assertion_invalid",
        ),
      ];
  if (
    issuer !== expected.expectedIssuer ||
    audiences.length === 0 ||
    !audiences.includes(expected.expectedAudience)
  ) {
    throw new ControlApiIdentityError(
      "authentication",
      "identity_assertion_invalid",
    );
  }
  const issuedAtMs = parseTimestamp(record.issuedAt);
  const expiresAtMs = parseTimestamp(record.expiresAt);
  if (
    issuedAtMs > expected.now + 30_000 ||
    expiresAtMs <= expected.now ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > expected.maxAssertionLifetimeMs
  ) {
    throw new ControlApiIdentityError(
      "authentication",
      "identity_assertion_invalid",
    );
  }
  const actor = {
    principalId: boundedString(
      record.principalId,
      MAX_IDENTIFIER_LENGTH,
      "identity_assertion_invalid",
    ),
    actorId: boundedString(
      record.actorId,
      MAX_IDENTIFIER_LENGTH,
      "identity_assertion_invalid",
    ),
    tenantId: boundedString(
      record.tenantId,
      MAX_IDENTIFIER_LENGTH,
      "identity_assertion_invalid",
    ),
    spaceId: boundedString(
      record.spaceId,
      MAX_IDENTIFIER_LENGTH,
      "identity_assertion_invalid",
    ),
  } satisfies ActorContext;
  return { actor, expiresAtMs };
}

function parsePolicyDecision(value: unknown): AuthorizationDecision {
  if (!isRecord(value) || typeof value.outcome !== "string") {
    throw new Error("policy_decision_invalid");
  }
  if (value.outcome === "allow") {
    exactRecord(value, ["outcome"], "policy_decision_invalid");
    return { outcome: "allow" };
  }
  if (value.outcome === "deny") {
    const record = exactRecord(
      value,
      ["outcome", "reasonCode"],
      "policy_decision_invalid",
    );
    return {
      outcome: "deny",
      reasonCode: boundedReasonCode(record.reasonCode),
    };
  }
  throw new Error("policy_decision_invalid");
}

function validateActor(actor: ActorContext): void {
  requireBounded(actor.principalId, MAX_IDENTIFIER_LENGTH, "actor_invalid");
  requireBounded(actor.actorId, MAX_IDENTIFIER_LENGTH, "actor_invalid");
  requireBounded(actor.tenantId, MAX_IDENTIFIER_LENGTH, "actor_invalid");
  requireBounded(actor.spaceId, MAX_IDENTIFIER_LENGTH, "actor_invalid");
}

function validatePolicyRequest(request: ControlAuthorizationRequest): void {
  requireBounded(request.action, 128, "policy_request_invalid");
  for (const value of Object.values(request.resource)) {
    if (typeof value === "string") {
      requireBounded(value, MAX_IDENTIFIER_LENGTH, "policy_request_invalid");
    } else if (value !== null) {
      throw new Error("policy_request_invalid");
    }
  }
}

function parseBearer(value: string | null, code: string): string {
  if (
    value === null ||
    Buffer.byteLength(value) > MAX_HEADER_BYTES ||
    !value.startsWith("Bearer ")
  ) {
    throw new ControlApiIdentityError("authentication", code);
  }
  const token = value.slice("Bearer ".length);
  if (token.length === 0 || /\s/u.test(token)) {
    throw new ControlApiIdentityError("authentication", code);
  }
  return token;
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function requireSecret(value: string, code: string): void {
  if (Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 8 * 1_024) {
    throw new Error(code);
  }
}

function requireBoundedSet(
  values: readonly string[],
  maxLength: number,
  code: string,
): ReadonlySet<string> {
  if (values.length === 0 || values.length > 64) {
    throw new Error(code);
  }
  const result = new Set<string>();
  for (const value of values) {
    requireBounded(value, maxLength, code);
    result.add(value);
  }
  if (result.size !== values.length) {
    throw new Error(code);
  }
  return result;
}

function boundedString(
  value: unknown,
  maxLength: number,
  code: string,
): string {
  requireBounded(value, maxLength, code);
  return value;
}

function requireBounded(
  value: unknown,
  maxLength: number,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > maxLength
  ) {
    throw new Error(code);
  }
}

function requirePort(value: unknown, code: string): void {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new Error(code);
  }
}

function requireIntegerBetween(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(code);
  }
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== "string" || value.length > 64) {
    throw new ControlApiIdentityError(
      "authentication",
      "identity_assertion_invalid",
    );
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new ControlApiIdentityError(
      "authentication",
      "identity_assertion_invalid",
    );
  }
  return timestamp;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(code);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(code);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function boundedReasonCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_REASON_CODE_LENGTH ||
    !/^[a-z][a-z0-9_:-]*$/u.test(value)
  ) {
    throw new Error("policy_decision_invalid");
  }
  return value;
}
