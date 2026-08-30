import {
  agentPlatformBaseUrl,
  getAgentPlatformAccessToken,
} from "../agent-platform/agentPlatformClient";

export const PRINCIPAL_SESSION_SUBPROTOCOL = "crewon.principal-session.v1";
const MAX_TOKEN_BYTES = 16 * 1024;

type PrincipalSessionResponse = {
  token: string;
  expiresAt: number;
};

export class PrincipalSessionConnectionError extends Error {
  constructor() {
    super("Principal session connection failed");
    this.name = "PrincipalSessionConnectionError";
  }
}

export function principalSessionFrontendEnabled(
  value: string | undefined = import.meta.env
    .VITE_CREWON_PRINCIPAL_SESSION_ENABLED,
): boolean {
  if (value === undefined || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new PrincipalSessionConnectionError();
}

export async function createPrincipalSessionProtocols(
  serverUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    readAccessToken?: () => Promise<string | null>;
  } = {},
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const accessToken = await (
    options.readAccessToken ?? getAgentPlatformAccessToken
  )();
  if (!accessToken) {
    throw new PrincipalSessionConnectionError();
  }

  const bootstrap = await postJson(
    fetchImpl,
    `${agentPlatformBaseUrl()}/identity/v1/principal-bootstrap:issue`,
    {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  );
  const bootstrapSession = parseSessionResponse(bootstrap);
  const exchanged = await postJson(
    fetchImpl,
    principalSessionExchangeUrl(serverUrl),
    {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    JSON.stringify({ bootstrapToken: bootstrapSession.token }),
  );
  const principalSession = parseSessionResponse(exchanged);
  return [PRINCIPAL_SESSION_SUBPROTOCOL, principalSession.token];
}

export function principalSessionExchangeUrl(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new PrincipalSessionConnectionError();
  }
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else {
    throw new PrincipalSessionConnectionError();
  }
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/principal-session/exchange`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new PrincipalSessionConnectionError();
  }
  if (!response.ok) {
    throw new PrincipalSessionConnectionError();
  }
  try {
    return await response.json();
  } catch {
    throw new PrincipalSessionConnectionError();
  }
}

function parseSessionResponse(value: unknown): PrincipalSessionResponse {
  if (!isRecord(value)) {
    throw new PrincipalSessionConnectionError();
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "expiresAt" || keys[1] !== "token") {
    throw new PrincipalSessionConnectionError();
  }
  const token = value.token;
  const expiresAt = value.expiresAt;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(token) ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0
  ) {
    throw new PrincipalSessionConnectionError();
  }
  return { token, expiresAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
