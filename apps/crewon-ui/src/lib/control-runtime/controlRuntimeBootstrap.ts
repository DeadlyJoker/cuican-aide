import { ControlApiClient } from "@crewon/control-client";

import { hasDesktopBridge } from "../platform";
import { requireDesktopBridge } from "../desktop/desktopBridge";
import { desktopBridgeFetch } from "../desktop/desktopFetch";
import { getAgentPlatformAccessToken } from "../agent-platform/agentPlatformClient";
import {
  getPimLaunchToken,
  isPimLaunchSession,
} from "../agent-platform/pimLaunchBridge";

const WEB_SESSION_PATH = "/control-api/session";
const BOOTSTRAP_TIMEOUT_MS = 5_000;
const MAX_SESSION_SECRET_BYTES = 8 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

type DesktopControlSession = Readonly<{
  baseUrl: string;
  csrfToken: string;
  origin: string;
  sessionToken: string;
}>;

type WebControlSession = Readonly<{
  baseUrl: string;
  csrfToken: string;
}>;

export type ControlRuntimeBootstrapDependencies = Readonly<{
  desktopFetch?: typeof globalThis.fetch;
  fetch?: typeof globalThis.fetch;
  pageOrigin?: string;
  readDesktopSession?: () => Promise<unknown>;
  readWebAccessToken?: () => Promise<string | null>;
  surface?: "desktop" | "web";
}>;

/**
 * Loads the short-lived Control session into renderer memory. Secrets are never
 * read from Vite variables, URLs, DOM attributes, or persistent browser
 * storage. Desktop receives them over typed IPC; Web receives only a CSRF token
 * while its BFF session remains in an HttpOnly same-origin cookie.
 */
export async function loadControlApiClient(
  dependencies: ControlRuntimeBootstrapDependencies = {},
): Promise<ControlApiClient | null> {
  const surface =
    dependencies.surface ?? (hasDesktopBridge() ? "desktop" : "web");
  try {
    if (surface === "desktop") {
      const session = parseDesktopSession(
        await withBootstrapDeadline(
          (dependencies.readDesktopSession ?? readDesktopSession)(),
        ),
      );
      return new ControlApiClient({
        accessToken: session.sessionToken,
        baseUrl: session.baseUrl,
        csrfToken: session.csrfToken,
        fetch: dependencies.desktopFetch ?? desktopBridgeFetch,
        origin: session.origin,
      });
    }

    const pageOrigin = dependencies.pageOrigin ?? globalThis.location.origin;
    const accessToken = await withBootstrapDeadline(
      (dependencies.readWebAccessToken ?? getAgentPlatformAccessToken)(),
    );
    if (!accessToken) {
      throw new Error("control_runtime_pim_session_unavailable");
    }
    const webFetch = dependencies.fetch ?? globalThis.fetch;
    const authenticatedFetch: typeof globalThis.fetch = (input, init) => {
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      );
      new Headers(init?.headers).forEach((value, key) => {
        headers.set(key, value);
      });
      headers.set("Authorization", `Bearer ${accessToken}`);
      if (isPimLaunchSession()) {
        const launchToken = getPimLaunchToken();
        if (launchToken) {
          headers.set("X-PIM-Launch-Token", launchToken);
        }
      }
      return webFetch(input, {
        ...init,
        credentials: init?.credentials ?? "same-origin",
        headers,
      });
    };
    const session = parseWebSession(
      await withBootstrapDeadline(
        readWebSession(authenticatedFetch, pageOrigin),
      ),
      pageOrigin,
    );
    return new ControlApiClient({
      baseUrl: session.baseUrl,
      csrfToken: session.csrfToken,
      origin: pageOrigin,
      fetch: authenticatedFetch,
    });
  } catch {
    return null;
  }
}

/**
 * Keeps the optional Control runtime from blocking the first React render.
 *
 * The desktop session travels over IPC. If that channel stalls, awaiting it at
 * module scope leaves the root element empty forever and the transparent desktop
 * window appears blank. Returning `null` after the deadline lets the existing
 * disconnected state render while the rest of the app remains usable.
 */
async function withBootstrapDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("control_runtime_bootstrap_timeout")),
      BOOTSTRAP_TIMEOUT_MS,
    );
  });
  pending.catch(() => {});
  try {
    return await Promise.race([pending, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

async function readDesktopSession(): Promise<unknown> {
  return requireDesktopBridge().runtime.bootstrap();
}

async function readWebSession(
  fetchImpl: typeof globalThis.fetch,
  pageOrigin: string,
): Promise<unknown> {
  const response = await fetchImpl(new URL(WEB_SESSION_PATH, pageOrigin), {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok || !isJson(response.headers.get("content-type"))) {
    throw new Error("control_runtime_session_unavailable");
  }
  return response.json();
}

function parseDesktopSession(value: unknown): DesktopControlSession {
  requireExactObject(value, ["baseUrl", "csrfToken", "origin", "sessionToken"]);
  const baseUrl = absoluteUrl(value.baseUrl);
  if (!LOOPBACK_HOSTS.has(baseUrl.hostname)) {
    throw new Error("control_runtime_desktop_origin_invalid");
  }
  return {
    baseUrl: baseUrl.toString(),
    csrfToken: sessionSecret(value.csrfToken),
    origin: webOrigin(value.origin),
    sessionToken: sessionSecret(value.sessionToken),
  };
}

function parseWebSession(
  value: unknown,
  pageOrigin: string,
): WebControlSession {
  requireExactObject(value, ["baseUrl", "csrfToken"]);
  const expectedOrigin = webOrigin(pageOrigin);
  const baseUrl = new URL(stringValue(value.baseUrl), expectedOrigin);
  if (baseUrl.origin !== expectedOrigin) {
    throw new Error("control_runtime_web_origin_invalid");
  }
  return {
    baseUrl: baseUrl.toString(),
    csrfToken: sessionSecret(value.csrfToken),
  };
}

function absoluteUrl(value: unknown): URL {
  const url = new URL(stringValue(value));
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("control_runtime_base_url_invalid");
  }
  return url;
}

function webOrigin(value: unknown): string {
  const url = absoluteUrl(value);
  if (url.origin !== stringValue(value) || url.pathname !== "/") {
    throw new Error("control_runtime_origin_invalid");
  }
  return url.origin;
}

function sessionSecret(value: unknown): string {
  const secret = stringValue(value);
  if (
    secret.length < 32 ||
    new TextEncoder().encode(secret).byteLength > MAX_SESSION_SECRET_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(secret)
  ) {
    throw new Error("control_runtime_secret_invalid");
  }
  return secret;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("control_runtime_session_invalid");
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
    throw new Error("control_runtime_session_invalid");
  }
}

function isJson(contentType: string | null): boolean {
  return /^application\/json(?:;|$)/iu.test(contentType ?? "");
}
