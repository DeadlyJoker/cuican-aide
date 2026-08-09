import type { AuthorizationPort } from "@crewon/application";

import type {
  ControlTokenVerifierPort,
  PolicyDecisionPort,
} from "./production-security-adapters.ts";

const MAX_SECURITY_RESPONSE_BYTES = 16 * 1_024;
const MAX_URL_LENGTH = 2_048;

type FetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class HttpControlTokenVerifier implements ControlTokenVerifierPort {
  readonly #url: URL;
  readonly #serviceToken: string;
  readonly #fetch: FetchPort;

  constructor(config: {
    url: string;
    serviceToken: string;
    fetch?: FetchPort;
  }) {
    this.#url = parseHttpsUrl(config.url, "identity_verify_url_invalid");
    requireSecret(config.serviceToken, "identity_service_token_invalid");
    this.#serviceToken = config.serviceToken;
    this.#fetch = config.fetch ?? fetch;
  }

  async verify(input: {
    accessToken: string;
    signal: AbortSignal;
  }): Promise<unknown> {
    return postJson(
      this.#fetch,
      this.#url,
      this.#serviceToken,
      { accessToken: input.accessToken },
      input.signal,
      "identity_authority_unavailable",
    );
  }
}

export class HttpPolicyDecisionPort implements PolicyDecisionPort {
  readonly #url: URL;
  readonly #serviceToken: string;
  readonly #fetch: FetchPort;

  constructor(config: {
    url: string;
    serviceToken: string;
    fetch?: FetchPort;
  }) {
    this.#url = parseHttpsUrl(config.url, "policy_decision_url_invalid");
    requireSecret(config.serviceToken, "policy_service_token_invalid");
    this.#serviceToken = config.serviceToken;
    this.#fetch = config.fetch ?? fetch;
  }

  async decide(
    input: Parameters<PolicyDecisionPort["decide"]>[0],
  ): Promise<unknown> {
    const request: Parameters<AuthorizationPort["authorize"]>[0] = {
      actor: input.actor,
      action: input.action,
      resource: input.resource,
    };
    return postJson(
      this.#fetch,
      this.#url,
      this.#serviceToken,
      request,
      input.signal,
      "policy_authority_unavailable",
    );
  }
}

async function postJson(
  fetchPort: FetchPort,
  url: URL,
  serviceToken: string,
  body: unknown,
  signal: AbortSignal,
  errorCode: string,
): Promise<unknown> {
  const response = await fetchPort(url, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "authorization": `Bearer ${serviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal,
  });
  if (
    response.status !== 200 ||
    !isJson(response.headers.get("content-type"))
  ) {
    await response.body?.cancel();
    throw new Error(errorCode);
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > MAX_SECURITY_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error(errorCode);
  }
  const bytes = await readBoundedBody(response, errorCode);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(errorCode, { cause });
  }
}

async function readBoundedBody(
  response: Response,
  errorCode: string,
): Promise<Uint8Array> {
  if (response.body === null) {
    throw new Error(errorCode);
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
      if (total > MAX_SECURITY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(errorCode);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseHttpsUrl(value: string, code: string): URL {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new Error(code);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(code, { cause });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== ""
  ) {
    throw new Error(code);
  }
  return url;
}

function requireSecret(value: string, code: string): void {
  const length = Buffer.byteLength(value);
  if (length < 32 || length > 8 * 1_024) {
    throw new Error(code);
  }
}

function isJson(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || mediaType?.endsWith("+json") === true
  );
}
