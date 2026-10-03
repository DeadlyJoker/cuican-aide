import {
  AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
  agentPlatformAuthorizedSessionFetch,
  agentPlatformBaseUrl,
  assertAgentPlatformSessionCurrent,
  beginAgentPlatformInteractiveSession,
  captureAgentPlatformSession,
  clearAgentPlatformBffSession,
  clearAgentPlatformSession,
  crewonUnifiedSsoEnabled,
  getAgentPlatformAccessSession,
  getAgentPlatformBffUserSnapshot,
  publishAgentPlatformSession,
  type AgentPlatformSessionSnapshot,
} from "./agentPlatformClient";
import { isPimLaunchSession } from "./pimLaunchBridge";

export type AgentPlatformUser = {
  id: number;
  username: string;
  email: string;
  role: string;
  nickname?: string;
  display_name?: string;
  wecom_display_name?: string;
  approval_status?: string;
  password_login_enabled?: boolean;
  linked_providers?: string[];
};

export type AgentPlatformRegistration = AgentPlatformUser & {
  access_token?: string | null;
  refresh_token?: string | null;
  email_verification_sent?: boolean;
};

export type WeComLoginConfig = {
  enabled: boolean;
  provider: "wecom";
  label: string;
  reason?: string | null;
};

const AUTH_UNAVAILABLE_MESSAGE = "账号服务暂时不可用，请稍后重试。";
const AUTH_TRANSIENT_RETRY_DELAY_MS = 250;
const AUTH_TRANSIENT_STATUSES = new Set([502, 503, 504]);

async function responseError(
  response: Response,
  fallback: string,
  session: AgentPlatformSessionSnapshot,
): Promise<Error> {
  await assertResponseSessionCurrent(response, session);
  if (AUTH_TRANSIENT_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => {});
    assertAgentPlatformSessionCurrent(session);
    return new Error(AUTH_UNAVAILABLE_MESSAGE);
  }
  try {
    const body = (await response.json()) as {
      detail?: string | Array<{ msg?: string }>;
      message?: string;
    };
    assertAgentPlatformSessionCurrent(session);
    const detail = Array.isArray(body.detail)
      ? [...new Set(body.detail.map((item) => item.msg).filter(Boolean))].join(
          "；",
        )
      : body.detail;
    return new Error(detail || body.message || fallback);
  } catch {
    assertAgentPlatformSessionCurrent(session);
    return new Error(fallback);
  }
}

async function sessionFetch(
  path: string,
  init: RequestInit,
  session: AgentPlatformSessionSnapshot,
): Promise<Response> {
  assertAgentPlatformSessionCurrent(session);
  let response: Response;
  try {
    response = await fetch(`${agentPlatformBaseUrl()}${path}`, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, session.signal])
        : session.signal,
    });
  } catch (error) {
    assertAgentPlatformSessionCurrent(session);
    throw error;
  }
  try {
    assertAgentPlatformSessionCurrent(session);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  return response;
}

async function sessionBody<T>(
  response: Response,
  session: AgentPlatformSessionSnapshot,
): Promise<T> {
  await assertResponseSessionCurrent(response, session);
  try {
    const value = (await response.json()) as T;
    assertAgentPlatformSessionCurrent(session);
    return value;
  } catch (error) {
    assertAgentPlatformSessionCurrent(session);
    throw error;
  }
}

async function assertResponseSessionCurrent(
  response: Response,
  session: AgentPlatformSessionSnapshot,
): Promise<void> {
  try {
    assertAgentPlatformSessionCurrent(session);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
}

async function loginRetryDelay(session: AgentPlatformSessionSnapshot) {
  assertAgentPlatformSessionCurrent(session);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(session.signal.reason);
    };
    const timer = setTimeout(() => {
      session.signal.removeEventListener("abort", abort);
      resolve();
    }, AUTH_TRANSIENT_RETRY_DELAY_MS);
    session.signal.addEventListener("abort", abort, { once: true });
  });
  assertAgentPlatformSessionCurrent(session);
}

async function loginRequest(
  form: URLSearchParams,
  session: AgentPlatformSessionSnapshot,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertAgentPlatformSessionCurrent(session);
    try {
      const response = await sessionFetch(
        "/api/v1/auth/login",
        {
          method: "POST",
          body: form,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        },
        session,
      );
      if (!AUTH_TRANSIENT_STATUSES.has(response.status) || attempt === 1) {
        return response;
      }
      await response.body?.cancel();
      assertAgentPlatformSessionCurrent(session);
    } catch (error) {
      assertAgentPlatformSessionCurrent(session);
      if (attempt === 1) {
        throw new Error(AUTH_UNAVAILABLE_MESSAGE, { cause: error });
      }
    }
    await loginRetryDelay(session);
  }
  throw new Error(AUTH_UNAVAILABLE_MESSAGE);
}

export async function readAgentPlatformCurrentUser(): Promise<AgentPlatformUser | null> {
  // When launched from PIM, the launch token IS the credential — don't
  // require a locally stored access token.
  if (
    !isPimLaunchSession() &&
    !crewonUnifiedSsoEnabled() &&
    !localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY) &&
    !localStorage.getItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY)
  ) {
    return null;
  }
  if (!isPimLaunchSession() && crewonUnifiedSsoEnabled()) {
    const access = await getAgentPlatformAccessSession();
    assertAgentPlatformSessionCurrent(access.session);
    if (!access.accessToken) return null;
    const snapshot = getAgentPlatformBffUserSnapshot();
    if (
      snapshot &&
      typeof snapshot.id === "number" &&
      typeof snapshot.username === "string" &&
      typeof snapshot.email === "string" &&
      typeof snapshot.role === "string"
    ) {
      return snapshot as AgentPlatformUser;
    }
  }
  const { response, session } = await agentPlatformAuthorizedSessionFetch({
    path: "/api/v1/auth/me",
  });
  assertAgentPlatformSessionCurrent(session);
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    assertAgentPlatformSessionCurrent(session);
    clearAgentPlatformSession();
    return null;
  }
  if (!response.ok) {
    const error = await responseError(response, "无法读取账号信息", session);
    assertAgentPlatformSessionCurrent(session);
    throw error;
  }
  const user = await sessionBody<AgentPlatformUser>(response, session);
  assertAgentPlatformSessionCurrent(session);
  return user;
}

export async function loginAgentPlatform(
  username: string,
  password: string,
): Promise<AgentPlatformUser> {
  const current = beginAgentPlatformInteractiveSession();
  const form = new URLSearchParams({ username, password });
  const response = await loginRequest(form, current);
  if (!response.ok) {
    const error = await responseError(
      response,
      "登录失败，请检查账号和密码",
      current,
    );
    assertAgentPlatformSessionCurrent(current);
    throw error;
  }
  const credentials = await sessionBody<{
    access_token: string;
    refresh_token?: string;
  }>(response, current);
  const session = publishAgentPlatformSession({
    session: current,
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token,
  });
  const user = await readAgentPlatformCurrentUser();
  assertAgentPlatformSessionCurrent(session);
  if (!user) {
    throw new Error("登录成功，但未能读取账号信息");
  }
  return user;
}

export async function registerAgentPlatform(input: {
  username: string;
  email: string;
  password: string;
}): Promise<AgentPlatformRegistration> {
  const current = beginAgentPlatformInteractiveSession();
  const response = await sessionFetch(
    "/api/v1/auth/register",
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
    },
    current,
  );
  if (!response.ok) {
    const error = await responseError(
      response,
      "注册失败，请稍后重试",
      current,
    );
    assertAgentPlatformSessionCurrent(current);
    throw error;
  }
  const registration = await sessionBody<AgentPlatformRegistration>(
    response,
    current,
  );
  assertAgentPlatformSessionCurrent(current);
  if (registration.access_token) {
    publishAgentPlatformSession({
      session: current,
      accessToken: registration.access_token,
      refreshToken: registration.refresh_token,
    });
  }
  return registration;
}

export async function readWeComLoginConfig(): Promise<WeComLoginConfig> {
  const session = captureAgentPlatformSession();
  if (crewonUnifiedSsoEnabled()) {
    return {
      enabled: true,
      provider: "wecom",
      label: "企业统一登录",
    };
  }
  const response = await sessionFetch("/api/v1/auth/wecom/config", {}, session);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    assertAgentPlatformSessionCurrent(session);
    return {
      enabled: false,
      provider: "wecom",
      label: "企业微信",
      reason: "企业微信登录服务不可用",
    };
  }
  const config = await sessionBody<WeComLoginConfig>(response, session);
  assertAgentPlatformSessionCurrent(session);
  return config;
}

export async function beginWeComLogin(): Promise<string> {
  if (crewonUnifiedSsoEnabled()) {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    return `${agentPlatformBaseUrl()}/sso/client/crewon/start?${new URLSearchParams({ return_to: returnTo })}`;
  }
  return `${agentPlatformBaseUrl()}/api/v1/auth/wecom/authorize`;
}

export async function completeWeComLogin(
  ticket: string,
): Promise<AgentPlatformUser> {
  const current = beginAgentPlatformInteractiveSession();
  const response = await sessionFetch(
    "/api/v1/auth/wecom/exchange",
    {
      method: "POST",
      body: JSON.stringify({ ticket }),
      headers: { "Content-Type": "application/json" },
    },
    current,
  );
  if (!response.ok) {
    const error = await responseError(response, "企业微信登录失败", current);
    assertAgentPlatformSessionCurrent(current);
    throw error;
  }
  const credentials = await sessionBody<{
    access_token: string;
    refresh_token?: string;
  }>(response, current);
  const session = publishAgentPlatformSession({
    session: current,
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token,
  });
  const user = await readAgentPlatformCurrentUser();
  assertAgentPlatformSessionCurrent(session);
  if (!user) {
    throw new Error("企业微信登录成功，但未能读取账号信息");
  }
  return user;
}

export async function setAgentPlatformPassword(
  newPassword: string,
): Promise<void> {
  const { response, session } = await agentPlatformAuthorizedSessionFetch({
    path: "/api/v1/auth/set-password",
    init: {
      method: "POST",
      body: JSON.stringify({ new_password: newPassword }),
      headers: { "Content-Type": "application/json" },
    },
  });
  assertAgentPlatformSessionCurrent(session);
  if (!response.ok) {
    const error = await responseError(response, "设置登录密码失败", session);
    assertAgentPlatformSessionCurrent(session);
    throw error;
  }
  await response.body?.cancel().catch(() => {});
  assertAgentPlatformSessionCurrent(session);
}

export async function logoutAgentPlatform(): Promise<void> {
  if (crewonUnifiedSsoEnabled()) {
    await clearAgentPlatformBffSession({ global: true });
    return;
  }
  clearAgentPlatformSession();
}
