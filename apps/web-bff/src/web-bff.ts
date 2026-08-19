import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  WebIdentitySession,
  WebIdentitySessionPort,
} from "./identity-session-adapter.ts";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const SESSION_PATH = "/control-api/session";
const LIVE_PATH = "/control-api/health/live";
const READY_PATH = "/control-api/health/ready";
const API_PREFIX = "/api/v1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const REQUEST_HEADER_ALLOWLIST = [
  "accept",
  "content-type",
  "idempotency-key",
  "if-none-match",
  "last-event-id",
  "range",
] as const;
const RESPONSE_HEADER_ALLOWLIST = [
  "accept-ranges",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "retry-after",
  "x-request-id",
] as const;

export type WebBff = Readonly<{
  handle(request: Request): Promise<Response>;
}>;

export function createWebBff(config: {
  controlBffToken: string;
  controlCsrfToken: string;
  controlTarget: string;
  csrfSecret: string;
  fetch?: typeof globalThis.fetch;
  identity: WebIdentitySessionPort;
  publicOrigin: string;
}): WebBff {
  const publicOrigin = requirePublicOrigin(config.publicOrigin);
  const controlTarget = requireLoopbackControlTarget(config.controlTarget);
  const controlBffToken = requireSecret(
    config.controlBffToken,
    "control_bff_token_invalid",
  );
  const controlCsrfToken = requireSecret(
    config.controlCsrfToken,
    "control_csrf_token_invalid",
  );
  const csrfSecret = requireSecret(
    config.csrfSecret,
    "web_csrf_secret_invalid",
  );
  const fetchImpl = config.fetch ?? globalThis.fetch;

  return {
    async handle(request): Promise<Response> {
      const requestUrl = new URL(request.url);
      if (requestUrl.origin !== publicOrigin) {
        return errorResponse(400, "request_origin_invalid");
      }
      if (requestUrl.pathname === LIVE_PATH && requestUrl.search === "") {
        return request.method === "GET"
          ? jsonResponse(200, { status: "ok" })
          : errorResponse(405, "method_not_allowed");
      }
      if (requestUrl.pathname === READY_PATH && requestUrl.search === "") {
        if (request.method !== "GET") {
          return errorResponse(405, "method_not_allowed");
        }
        try {
          return proxyResponse(
            await fetchImpl(new URL("/api/v1/health/ready", controlTarget), {
              method: "GET",
              redirect: "manual",
              signal: request.signal,
            }),
          );
        } catch {
          return errorResponse(503, "control_api_unavailable");
        }
      }
      if (requestUrl.pathname === SESSION_PATH && requestUrl.search === "") {
        if (request.method !== "GET") {
          return errorResponse(405, "method_not_allowed");
        }
        const session = await resolveSession(config.identity, request);
        if (session instanceof Response) {
          return session;
        }
        return jsonResponse(200, {
          baseUrl: "/",
          csrfToken: browserCsrf(session, publicOrigin, csrfSecret),
        });
      }
      if (!isApiPath(requestUrl.pathname)) {
        return errorResponse(404, "route_not_found");
      }
      if (request.method === "OPTIONS" || request.method === "CONNECT") {
        return errorResponse(405, "method_not_allowed");
      }

      const session = await resolveSession(config.identity, request);
      if (session instanceof Response) {
        return session;
      }
      if (isMutation(request.method)) {
        const origin = request.headers.get("origin");
        const csrf = request.headers.get("x-csrf-token");
        const expectedCsrf = browserCsrf(session, publicOrigin, csrfSecret);
        if (
          origin !== publicOrigin ||
          csrf === null ||
          !safeEqual(csrf, expectedCsrf)
        ) {
          return errorResponse(403, "browser_csrf_invalid");
        }
      }

      const requestBody = await boundedRequestBody(request);
      if (requestBody instanceof Response) {
        return requestBody;
      }
      const headers = proxyRequestHeaders(request.headers);
      headers.set("authorization", `Bearer ${session.controlAccessToken}`);
      headers.set("origin", publicOrigin);
      headers.set("x-crewon-bff-authorization", `Bearer ${controlBffToken}`);
      if (isMutation(request.method)) {
        headers.set("x-csrf-token", controlCsrfToken);
      }

      const upstreamUrl = new URL(
        `${requestUrl.pathname}${requestUrl.search}`,
        controlTarget,
      );
      let upstream: Response;
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method: request.method,
          headers,
          redirect: "manual",
          signal: request.signal,
          ...(requestBody === null ? {} : { body: requestBody }),
        });
      } catch {
        return errorResponse(502, "control_api_unavailable");
      }
      return proxyResponse(upstream);
    },
  };
}

async function resolveSession(
  identity: WebIdentitySessionPort,
  request: Request,
): Promise<WebIdentitySession | Response> {
  try {
    const session = await identity.resolve({
      cookie: request.headers.get("cookie"),
      userAgent: request.headers.get("user-agent"),
    });
    return session ?? errorResponse(401, "identity_session_required");
  } catch {
    return errorResponse(503, "identity_session_unavailable");
  }
}

function browserCsrf(
  session: WebIdentitySession,
  publicOrigin: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update("crewon.web-csrf.v0\0")
    .update(session.sessionId)
    .update("\0")
    .update(publicOrigin)
    .digest("base64url");
}

async function boundedRequestBody(
  request: Request,
): Promise<ArrayBuffer | null | Response> {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 0 ||
      parsed > MAX_REQUEST_BODY_BYTES
    ) {
      return errorResponse(413, "request_body_too_large");
    }
  }
  const body = await request.arrayBuffer();
  return body.byteLength > MAX_REQUEST_BODY_BYTES
    ? errorResponse(413, "request_body_too_large")
    : body;
}

function proxyRequestHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = source.get(name);
    if (value !== null) {
      requireHeaderValue(value);
      headers.set(name, value);
    }
  }
  return headers;
}

function proxyResponse(upstream: Response): Response {
  const headers = secureHeaders();
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  const headers = secureHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { error: { code } });
}

function secureHeaders(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  });
}

function requirePublicOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("web_public_origin_invalid");
  }
  return url.origin;
}

function requireLoopbackControlTarget(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("control_target_invalid");
  }
  return url;
}

function requireSecret(value: string, code: string): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (
    bytes < 32 ||
    bytes > MAX_HEADER_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function requireHeaderValue(value: string): void {
  if (
    new TextEncoder().encode(value).byteLength > MAX_HEADER_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("request_header_invalid");
  }
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}
