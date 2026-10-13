import {
  projectConversationProxyPolicy,
  boundedProjectConversationProxyRequest,
  boundedProjectConversationProxyResponse,
  PROJECT_CONVERSATION_PROXY_DEADLINE_MS,
} from "./project-conversation-proxy-policy.ts";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

import type {
  WebIdentitySession,
  WebIdentitySessionPort,
} from "./identity-session-adapter.ts";
import type { PimControlSessions } from "./pim-control-sessions.ts";
import {
  boundedExtensionProxyResponse,
  extensionProxyPolicy,
  EXTENSION_PROXY_DEADLINE_MS,
} from "./extension-proxy-policy.ts";
import {
  boundedPluginProxyRequest,
  boundedPluginSourceUploadPartRequest,
  boundedPluginProxyResponse,
  pluginProxyPolicy,
  PLUGIN_PROXY_DEADLINE_MS,
} from "./plugin-proxy-policy.ts";
import {
  boundedCreativeProjectProxyRequest,
  boundedCreativeProjectProxyResponse,
  creativeProjectProxyPolicy,
  CREATIVE_PROJECT_PROXY_DEADLINE_MS,
} from "./creative-project-proxy-policy.ts";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const SESSION_PATH = "/control-api/session";
const LIVE_PATH = "/control-api/health/live";
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
  "vary",
  "x-request-id",
] as const;

export type WebBff = Readonly<{
  /** Original target supplied only by the HTTP adapter, never by a request header. */
  handle(
    request: Request,
    context?: Readonly<{ rawTarget: string }>,
  ): Promise<Response>;
}>;

export function createWebBff(config: {
  controlBffToken: string;
  controlCsrfToken: string;
  controlTarget: string;
  csrfSecret: string;
  fetch?: typeof globalThis.fetch;
  identity: WebIdentitySessionPort;
  /** Explicit PIM mode only; the legacy Identity Center cookie contract is unchanged. */
  accountExchange?: Pick<PimControlSessions, "exchange">;
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
    async handle(request, context): Promise<Response> {
      const requestUrl = new URL(request.url);
      if (requestUrl.origin !== publicOrigin) {
        return errorResponse(400, "request_origin_invalid");
      }
      const rawTarget = context?.rawTarget;
      const queryOffset = rawTarget?.indexOf("?") ?? -1;
      const policyInput = {
        pathname:
          rawTarget === undefined
            ? requestUrl.pathname
            : queryOffset < 0
              ? rawTarget
              : rawTarget.slice(0, queryOffset),
        search:
          rawTarget === undefined
            ? requestUrl.search
            : queryOffset < 0
              ? ""
              : rawTarget.slice(queryOffset),
        method: request.method,
      };
      const pluginPolicy = pluginProxyPolicy(policyInput);
      if (pluginPolicy?.outcome === "deny") {
        return errorResponse(pluginPolicy.status, pluginPolicy.code);
      }
      const conversationPolicy = projectConversationProxyPolicy(policyInput);
      if (conversationPolicy?.outcome === "deny")
        return errorResponse(
          conversationPolicy.status,
          conversationPolicy.code,
        );
      const projectPolicy = creativeProjectProxyPolicy(policyInput);
      if (projectPolicy?.outcome === "deny") {
        return errorResponse(projectPolicy.status, projectPolicy.code);
      }
      if (requestUrl.pathname === LIVE_PATH && requestUrl.search === "") {
        return request.method === "GET"
          ? jsonResponse(200, { status: "ok" })
          : errorResponse(405, "method_not_allowed");
      }
      if (requestUrl.pathname === SESSION_PATH && requestUrl.search === "") {
        if (request.method === "POST" && config.accountExchange !== undefined) {
          if (request.headers.get("origin") !== publicOrigin)
            return errorResponse(403, "browser_origin_invalid");
          const credential = pimBearer(request);
          if (credential === null)
            return errorResponse(401, "pim_account_required");
          const body = await boundedRequestBody(request);
          if (body instanceof Response) return body;
          if (body !== null && body.byteLength !== 0)
            return errorResponse(400, "pim_account_exchange_body_invalid");
          try {
            const result = await config.accountExchange.exchange(
              credential,
              request.signal,
            );
            const response = jsonResponse(200, {
              baseUrl: "/",
              csrfToken: browserCsrf(result.session, publicOrigin, csrfSecret),
            });
            response.headers.set("set-cookie", result.setCookie);
            return response;
          } catch (error) {
            return errorResponse(
              error instanceof Error &&
                /^(pim_account_denied|pim_account_token_invalid|pim_account_inactive_or_changed|pim_control_profile_denied|web_plugin_profile_revoked)$/u.test(
                  error.message,
                )
                ? 401
                : 503,
              "pim_account_exchange_unavailable",
            );
          }
        }
        if (request.method !== "GET") {
          return errorResponse(405, "method_not_allowed");
        }
        const session = await resolveSession(
          config.identity,
          request,
          config.accountExchange !== undefined
            ? "pimAccount"
            : "identityCenter",
        );
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

      const session = await resolveSession(
        config.identity,
        request,
        config.accountExchange === undefined
          ? "identityCenter"
          : pluginPolicy?.outcome === "allow" &&
              pluginPolicy.responseKind === "asset" &&
              request.method === "GET"
            ? "publicPluginAsset"
            : "pimAccount",
      );
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
          const response = errorResponse(403, "browser_csrf_invalid");
          // Same-origin, already authenticated PIM callers can synchronize the
          // shared Cookie's CSRF after another tab renews it. Never forward here.
          if (
            config.accountExchange &&
            origin === publicOrigin &&
            csrf !== null
          )
            response.headers.set("x-crewon-account-exchange", "required");
          return response;
        }
      }

      const extensionPolicy = extensionProxyPolicy({
        pathname: requestUrl.pathname,
        search: requestUrl.search,
        method: request.method,
      });
      if (extensionPolicy?.outcome === "deny") {
        return errorResponse(extensionPolicy.status, extensionPolicy.code);
      }
      const upstreamSignal =
        conversationPolicy !== null ||
        pluginPolicy !== null ||
        extensionPolicy !== null ||
        projectPolicy !== null
          ? AbortSignal.any([
              request.signal,
              AbortSignal.timeout(
                conversationPolicy !== null
                  ? PROJECT_CONVERSATION_PROXY_DEADLINE_MS
                  : pluginPolicy !== null
                    ? PLUGIN_PROXY_DEADLINE_MS
                    : projectPolicy !== null
                      ? CREATIVE_PROJECT_PROXY_DEADLINE_MS
                      : EXTENSION_PROXY_DEADLINE_MS,
              ),
            ])
          : request.signal;

      let requestBody: ArrayBuffer | Uint8Array<ArrayBuffer> | null | Response;
      try {
        requestBody =
          conversationPolicy !== null
            ? await boundedProjectConversationProxyRequest(
                request,
                upstreamSignal,
                conversationPolicy,
              )
            : projectPolicy !== null
              ? await boundedCreativeProjectProxyRequest(
                  request,
                  upstreamSignal,
                )
              : pluginPolicy === null
                ? await boundedRequestBody(request)
                : pluginPolicy.outcome === "allow" &&
                    pluginPolicy.requestKind === "sourceUploadPart"
                  ? await boundedPluginSourceUploadPartRequest(
                      request,
                      upstreamSignal,
                    )
                  : await boundedPluginProxyRequest(request, upstreamSignal);
      } catch (error) {
        return errorResponse(
          error instanceof Error &&
            (error.message === "plugin_body_too_large" ||
              error.message === "creative_project_body_too_large")
            ? 413
            : 400,
          conversationPolicy !== null
            ? "project_conversation_request_invalid"
            : projectPolicy !== null
              ? "creative_project_request_invalid"
              : "plugin_request_invalid",
        );
      }
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
          signal: upstreamSignal,
          ...(requestBody === null ? {} : { body: requestBody }),
        });
      } catch {
        return errorResponse(502, "control_api_unavailable");
      }
      if (conversationPolicy !== null) {
        try {
          upstream = await boundedProjectConversationProxyResponse({
            upstream,
            signal: upstreamSignal,
          });
        } catch {
          return errorResponse(502, "control_api_response_invalid");
        }
      } else if (pluginPolicy !== null) {
        try {
          upstream = await boundedPluginProxyResponse({
            upstream,
            signal: upstreamSignal,
            policy: pluginPolicy,
          });
        } catch {
          return errorResponse(502, "control_api_response_invalid");
        }
      } else if (projectPolicy !== null) {
        try {
          upstream = await boundedCreativeProjectProxyResponse({
            upstream,
            signal: upstreamSignal,
            maximumBytes: projectPolicy.responseMaxBytes,
          });
        } catch {
          return errorResponse(502, "control_api_response_invalid");
        }
      } else if (extensionPolicy !== null) {
        try {
          upstream = await boundedExtensionProxyResponse({
            upstream,
            signal: upstreamSignal,
            maximumBytes: extensionPolicy.responseMaxBytes,
          });
        } catch {
          return errorResponse(502, "control_api_response_invalid");
        }
      }
      return proxyResponse(upstream);
    },
  };
}

async function resolveSession(
  identity: WebIdentitySessionPort,
  request: Request,
  mode: "identityCenter" | "pimAccount" | "publicPluginAsset",
): Promise<WebIdentitySession | Response> {
  try {
    const session =
      mode === "publicPluginAsset"
        ? ((await identity.resolvePublicPluginAsset?.({
            cookie: request.headers.get("cookie"),
            signal: request.signal,
          })) ?? null)
        : await identity.resolve({
            cookie: request.headers.get("cookie"),
            userAgent: request.headers.get("user-agent"),
            ...(mode === "pimAccount"
              ? { pimAccessToken: pimBearer(request) }
              : {}),
          });
    if (session !== null) return session;
    const response = errorResponse(401, "identity_session_required");
    // Not forwarded from Control: clients may renew only a request rejected before dispatch.
    if (mode === "pimAccount")
      response.headers.set("x-crewon-account-exchange", "required");
    return response;
  } catch {
    return errorResponse(503, "identity_session_unavailable");
  }
}

function pimBearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (value === null || Buffer.byteLength(value) > 8 * 1024) return null;
  return (
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(
      value,
    )?.[1] ?? null
  );
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
  const category =
    status === 401
      ? "authentication"
      : status === 403
        ? "authorization"
        : status === 404
          ? "notFound"
          : status === 429
            ? "rateLimit"
            : status >= 500
              ? "providerUnavailable"
              : "validation";
  return jsonResponse(status, {
    error: { code, category, message: code, requestId: randomUUID() },
  });
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
