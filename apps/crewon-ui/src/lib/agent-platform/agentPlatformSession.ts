import {
  AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
  agentPlatformAuthorizedFetch,
  agentPlatformBaseUrl,
  clearAgentPlatformBffSession,
  clearAgentPlatformSession,
  crewonUnifiedSsoEnabled,
  getAgentPlatformAccessToken,
  getAgentPlatformBffUserSnapshot,
  storeAgentPlatformSession,
} from "./agentPlatformClient";
import { clearPimLaunchToken, isPimLaunchSession } from "./pimLaunchBridge";

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

async function responseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  try {
    const body = (await response.json()) as {
      detail?: string | Array<{ msg?: string }>;
      message?: string;
    };
    const detail = Array.isArray(body.detail)
      ? [...new Set(body.detail.map((item) => item.msg).filter(Boolean))].join(
          "；",
        )
      : body.detail;
    return new Error(detail || body.message || fallback);
  } catch {
    return new Error(fallback);
  }
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
    const token = await getAgentPlatformAccessToken();
    if (!token) return null;
    const snapshot = getAgentPlatformBffUserSnapshot();
    if (
      snapshot
      && typeof snapshot.id === "number"
      && typeof snapshot.username === "string"
      && typeof snapshot.email === "string"
      && typeof snapshot.role === "string"
    ) {
      return snapshot as AgentPlatformUser;
    }
  }
  const response = await agentPlatformAuthorizedFetch("/api/v1/auth/me");
  if (response.status === 401) {
    clearAgentPlatformSession();
    return null;
  }
  if (!response.ok) {
    throw await responseError(response, "无法读取账号信息");
  }
  return (await response.json()) as AgentPlatformUser;
}

export async function loginAgentPlatform(
  username: string,
  password: string,
): Promise<AgentPlatformUser> {
  const form = new URLSearchParams({ username, password });
  const response = await fetch(`${agentPlatformBaseUrl()}/api/v1/auth/login`, {
    method: "POST",
    body: form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!response.ok) {
    throw await responseError(response, "登录失败，请检查账号和密码");
  }
  const session = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
  };
  storeAgentPlatformSession(session.access_token, session.refresh_token);
  const user = await readAgentPlatformCurrentUser();
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
  const response = await fetch(
    `${agentPlatformBaseUrl()}/api/v1/auth/register`,
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!response.ok) {
    throw await responseError(response, "注册失败，请稍后重试");
  }
  const registration = (await response.json()) as AgentPlatformRegistration;
  if (registration.access_token) {
    storeAgentPlatformSession(
      registration.access_token,
      registration.refresh_token,
    );
  }
  return registration;
}

export async function readWeComLoginConfig(): Promise<WeComLoginConfig> {
  if (crewonUnifiedSsoEnabled()) {
    return {
      enabled: true,
      provider: "wecom",
      label: "企业统一登录",
    };
  }
  const response = await fetch(
    `${agentPlatformBaseUrl()}/api/v1/auth/wecom/config`,
  );
  if (!response.ok) {
    return {
      enabled: false,
      provider: "wecom",
      label: "企业微信",
      reason: "企业微信登录服务不可用",
    };
  }
  return (await response.json()) as WeComLoginConfig;
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
  const response = await fetch(
    `${agentPlatformBaseUrl()}/api/v1/auth/wecom/exchange`,
    {
      method: "POST",
      body: JSON.stringify({ ticket }),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!response.ok) {
    throw await responseError(response, "企业微信登录失败");
  }
  const session = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
  };
  storeAgentPlatformSession(session.access_token, session.refresh_token);
  const user = await readAgentPlatformCurrentUser();
  if (!user) {
    throw new Error("企业微信登录成功，但未能读取账号信息");
  }
  return user;
}

export async function setAgentPlatformPassword(
  newPassword: string,
): Promise<void> {
  const response = await agentPlatformAuthorizedFetch(
    "/api/v1/auth/set-password",
    {
      method: "POST",
      body: JSON.stringify({ new_password: newPassword }),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!response.ok) {
    throw await responseError(response, "设置登录密码失败");
  }
}

export async function logoutAgentPlatform(): Promise<void> {
  if (crewonUnifiedSsoEnabled()) {
    await clearAgentPlatformBffSession({ global: true });
    return;
  }
  clearAgentPlatformSession();
}
