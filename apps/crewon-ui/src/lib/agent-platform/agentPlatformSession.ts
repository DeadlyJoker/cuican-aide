import {
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
  agentPlatformAuthorizedFetch,
  agentPlatformBaseUrl,
  clearAgentPlatformSession,
  storeAgentPlatformSession,
} from "./agentPlatformClient";

export type AgentPlatformUser = {
  id: number;
  username: string;
  email: string;
  role: string;
  nickname?: string;
  approval_status?: string;
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
      detail?: string;
      message?: string;
    };
    return new Error(body.detail || body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function readAgentPlatformCurrentUser(): Promise<AgentPlatformUser | null> {
  if (!localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)) {
    return null;
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
  const response = await fetch(
    `${agentPlatformBaseUrl()}/api/v1/auth/wecom/authorize`,
  );
  if (!response.ok) {
    throw await responseError(response, "企业微信登录尚未配置");
  }
  const payload = (await response.json()) as { auth_url: string };
  return payload.auth_url;
}

export async function completeWeComLogin(
  code: string,
  state: string,
): Promise<AgentPlatformUser> {
  const response = await fetch(
    `${agentPlatformBaseUrl()}/api/v1/auth/wecom/callback`,
    {
      method: "POST",
      body: JSON.stringify({ code, state }),
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

export function logoutAgentPlatform(): void {
  clearAgentPlatformSession();
}
