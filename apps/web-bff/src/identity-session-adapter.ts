export type WebIdentitySession = Readonly<{
  controlAccessToken: string;
  expiresAt: string;
  sessionId: string;
}>;

export interface WebIdentitySessionPort {
  resolve(input: {
    cookie: string | null;
    userAgent: string | null;
  }): Promise<WebIdentitySession | null>;
}

const MAX_COOKIE_BYTES = 16 * 1024;
const MAX_IDENTITY_RESPONSE_BYTES = 32 * 1024;
const MAX_SESSION_ID_BYTES = 512;
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const DEFAULT_MAX_SESSION_LIFETIME_MS = 10 * 60 * 1000;

export class HttpIdentitySessionAdapter implements WebIdentitySessionPort {
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxSessionLifetimeMs: number;
  readonly #now: () => number;
  readonly #serviceToken: string;
  readonly #timeoutMs: number;

  constructor(config: {
    endpoint: string;
    serviceToken: string;
    fetch?: typeof globalThis.fetch;
    maxSessionLifetimeMs?: number;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.#endpoint = requireHttpsEndpoint(config.endpoint);
    this.#serviceToken = requireSecret(
      config.serviceToken,
      "identity_service_token_invalid",
    );
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#maxSessionLifetimeMs = positiveSafeInteger(
      config.maxSessionLifetimeMs ?? DEFAULT_MAX_SESSION_LIFETIME_MS,
      "identity_max_session_lifetime_invalid",
    );
    this.#now = config.now ?? Date.now;
    this.#timeoutMs = positiveSafeInteger(
      config.timeoutMs ?? 5_000,
      "identity_timeout_invalid",
    );
  }

  async resolve(input: {
    cookie: string | null;
    userAgent: string | null;
  }): Promise<WebIdentitySession | null> {
    if (input.cookie === null || input.cookie.length === 0) {
      return null;
    }
    requireBoundedHeader(
      input.cookie,
      MAX_COOKIE_BYTES,
      "identity_cookie_invalid",
    );
    if (input.userAgent !== null) {
      requireBoundedHeader(
        input.userAgent,
        2 * 1024,
        "identity_user_agent_invalid",
      );
    }

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#serviceToken}`,
          cookie: input.cookie,
          ...(input.userAgent === null
            ? {}
            : { "user-agent": input.userAgent }),
        },
      });
    } catch {
      throw new Error("identity_session_unavailable");
    }

    if (response.status === 401 || response.status === 403) {
      return null;
    }
    if (!response.ok || !isJson(response.headers.get("content-type"))) {
      throw new Error("identity_session_unavailable");
    }

    const body = await readBoundedJson(response, MAX_IDENTITY_RESPONSE_BYTES);
    requireExactObject(body, ["controlAccessToken", "expiresAt", "sessionId"]);
    const sessionId = requireBoundedText(
      body.sessionId,
      32,
      MAX_SESSION_ID_BYTES,
      "identity_session_invalid",
    );
    const controlAccessToken = requireBoundedText(
      body.controlAccessToken,
      32,
      MAX_ACCESS_TOKEN_BYTES,
      "identity_session_invalid",
    );
    const expiresAt = requireBoundedText(
      body.expiresAt,
      20,
      64,
      "identity_session_invalid",
    );
    const expiresAtMs = Date.parse(expiresAt);
    const now = this.#now();
    if (
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= now ||
      expiresAtMs - now > this.#maxSessionLifetimeMs ||
      new Date(expiresAtMs).toISOString() !== expiresAt
    ) {
      throw new Error("identity_session_invalid");
    }
    return { controlAccessToken, expiresAt, sessionId };
  }
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (response.body === null) {
    throw new Error("identity_session_invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        throw new Error("identity_session_invalid");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("identity_session_invalid");
  }
}

function requireHttpsEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    throw new Error("identity_endpoint_invalid");
  }
  return endpoint;
}

function requireSecret(value: string, code: string): string {
  return requireBoundedText(value, 32, 16 * 1024, code);
}

function requireBoundedHeader(
  value: string,
  maxBytes: number,
  code: string,
): void {
  if (
    new TextEncoder().encode(value).byteLength > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(code);
  }
}

function requireBoundedText(
  value: unknown,
  minBytes: number,
  maxBytes: number,
  code: string,
): string {
  if (typeof value !== "string") {
    throw new Error(code);
  }
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (
    byteLength < minBytes ||
    byteLength > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function positiveSafeInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(code);
  }
  return value;
}

function requireExactObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    throw new Error("identity_session_invalid");
  }
}

function isJson(contentType: string | null): boolean {
  return /^application\/json(?:;|$)/iu.test(contentType ?? "");
}
