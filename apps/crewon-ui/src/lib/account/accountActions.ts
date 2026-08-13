import type { GetAccountRateLimitsResponse } from "@crewon-protocol/v2/GetAccountRateLimitsResponse";
import type { GetAccountTokenUsageResponse } from "@crewon-protocol/v2/GetAccountTokenUsageResponse";
import type { GetAuthStatusResponse } from "@crewon-protocol/GetAuthStatusResponse";
import type { LoginAccountParams } from "@crewon-protocol/v2/LoginAccountParams";
import type { LoginAccountResponse } from "@crewon-protocol/v2/LoginAccountResponse";
import type { ModelListResponse } from "@crewon-protocol/v2/ModelListResponse";
import type { ModelProviderCapabilitiesReadResponse } from "@crewon-protocol/v2/ModelProviderCapabilitiesReadResponse";
import type { PermissionProfileListResponse } from "@crewon-protocol/v2/PermissionProfileListResponse";

import type { AgentPlatformUser } from "../agent-platform/agentPlatformSession";
import type { AccountStatus } from "../shared/statusTypes";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import type { ConnectionState } from "../shared/connectionState";
import type { ControlApiClient } from "@crewon/control-client";
import { settledErrorMessages, settledValue } from "../shared/settledResults";
import {
  accountAuthErrorPanel,
  accountChatGptLoginPanel,
  accountDisconnectedPanel,
  accountDeviceCodeLoginPanel,
  accountLoggedInPanel,
  accountLoggedOutPanel,
  accountLoadingPanel,
  accountOverviewPanel,
  accountReadErrorPanel,
  accountTelemetryText,
  workspaceCapabilitiesText,
} from "./accountSummaryText";

export type AccountAction =
  | "loginChatGpt"
  | "loginDeviceCode"
  | "logout"
  | "refresh";

type AccountClient = {
  getAccount(): Promise<AccountStatus>;
  loginAccount(params: LoginAccountParams): Promise<LoginAccountResponse>;
  logoutAccount(): Promise<unknown>;
};

type AccountRefreshClient = {
  getAccount(): Promise<AccountStatus>;
  getAccountRateLimits(): Promise<GetAccountRateLimitsResponse>;
  getAccountUsage(): Promise<GetAccountTokenUsageResponse>;
  getAuthStatus(): Promise<GetAuthStatusResponse>;
  getModelProviderCapabilities(): Promise<ModelProviderCapabilitiesReadResponse>;
  listModels(): Promise<ModelListResponse>;
  listPermissionProfiles(cwd?: string): Promise<PermissionProfileListResponse>;
};

export type AccountActionHandlersParams = {
  client: AccountClient | null | undefined;
  isConnected: boolean;
  locale: Locale;
  refreshAccountPanel: () => Promise<void> | void;
  setAccountStatus: (account: AccountStatus | null) => void;
  setCapabilityPanel: (panel: CapabilityPanel) => void;
};

export type RefreshAccountPanelActionParams = {
  controlClient?: Pick<
    ControlApiClient,
    "getAccountSnapshot" | "getLocalSettings"
  > | null;
  client: AccountRefreshClient | null | undefined;
  connectionHint: string;
  connectionState: ConnectionState;
  fallbackAccount: AccountStatus | null;
  isConnected: boolean;
  locale: Locale;
  platformUser: AgentPlatformUser | null;
  resolveBackendCwd: () => Promise<string | undefined>;
  setAccountStatus: (account: AccountStatus | null) => void;
  setCapabilityPanel: (panel: CapabilityPanel) => void;
};

export function accountActionForActionId(
  actionId: string,
): AccountAction | null {
  switch (actionId) {
    case "login-chatgpt":
      return "loginChatGpt";
    case "login-device-code":
      return "loginDeviceCode";
    case "logout-account":
      return "logout";
    case "refresh-account":
      return "refresh";
    default:
      return null;
  }
}

export function createAccountActionHandlers(
  params: AccountActionHandlersParams,
): Record<AccountAction, () => void> {
  return {
    loginChatGpt: () => startAccountLogin(params, { type: "chatgpt" }),
    loginDeviceCode: () =>
      startAccountLogin(params, { type: "chatgptDeviceCode" }),
    logout: () => logoutAccount(params),
    refresh: () => {
      void params.refreshAccountPanel();
    },
  };
}

export async function refreshAccountPanelAction({
  controlClient,
  client,
  connectionHint,
  connectionState,
  fallbackAccount,
  isConnected,
  locale,
  platformUser,
  resolveBackendCwd,
  setAccountStatus,
  setCapabilityPanel,
}: RefreshAccountPanelActionParams) {
  if (controlClient != null) {
    try {
      const [{ account }, { settings }] = await Promise.all([
        controlClient.getAccountSnapshot(),
        controlClient.getLocalSettings(),
      ]);
      setCapabilityPanel({
        title: locale === "zh" ? "账号" : "Account",
        subtitle:
          locale === "zh"
            ? "CrewON 身份与本机偏好"
            : "CrewON identity and local preferences",
        body: [
          `${locale === "zh" ? "Control 身份" : "Control identity"}: ${account.identity.principalId}`,
          `${locale === "zh" ? "执行主体" : "Actor"}: ${account.identity.actorId}`,
          `${locale === "zh" ? "租户 / 空间" : "Tenant / space"}: ${account.identity.tenantId} / ${account.identity.spaceId}`,
          `${locale === "zh" ? "认证状态" : "Authentication"}: ${account.authentication.status} (${account.authentication.authority})`,
          platformUser
            ? `${locale === "zh" ? "企业资料" : "Enterprise profile"}: ${
                platformUser.display_name ??
                platformUser.nickname ??
                platformUser.username
              }`
            : null,
          platformUser?.email
            ? `${locale === "zh" ? "邮箱" : "Email"}: ${platformUser.email}`
            : null,
          `${locale === "zh" ? "语言" : "Language"}: ${settings.locale}`,
          `${locale === "zh" ? "主题" : "Theme"}: ${settings.theme}`,
          locale === "zh"
            ? "账户使用量：不可用（Control 没有该数据权威）"
            : "Account usage: unavailable (not owned by Control)",
          locale === "zh"
            ? "账户限流：不可用（Control 没有该数据权威）"
            : "Account rate limits: unavailable (not owned by Control)",
          locale === "zh"
            ? "本页不再连接 App Server；模型凭据在“模型接入”中管理。"
            : "This page no longer connects to App Server; model credentials are managed under Model access.",
        ]
          .filter(Boolean)
          .join("\n"),
        actions: [
          {
            id: "refresh-account",
            label: locale === "zh" ? "刷新" : "Refresh",
          },
        ],
      });
    } catch (error) {
      setCapabilityPanel(accountReadErrorPanel(error, locale));
    }
    return;
  }
  if (!isConnected) {
    setCapabilityPanel(
      accountDisconnectedPanel(
        connectionState === "connecting"
          ? locale === "zh"
            ? "正在连接本地 app-server..."
            : "Connecting to local app-server..."
          : connectionHint,
        locale,
      ),
    );
    return;
  }

  setCapabilityPanel(accountLoadingPanel(locale));

  try {
    const cwd = await resolveBackendCwd();
    const [
      accountResult,
      authStatusResult,
      rateLimitsResult,
      usageResult,
      modelsResult,
      permissionProfilesResult,
      providerCapabilitiesResult,
    ] = await Promise.allSettled([
      client?.getAccount(),
      client?.getAuthStatus(),
      client?.getAccountRateLimits(),
      client?.getAccountUsage(),
      client?.listModels(),
      client?.listPermissionProfiles(cwd),
      client?.getModelProviderCapabilities(),
    ]);
    const account = settledValue(accountResult, null);
    const authStatus = settledValue(authStatusResult, null);
    const rateLimits = settledValue(rateLimitsResult, null);
    const usage = settledValue(usageResult, null);
    const models = settledValue(modelsResult, null);
    const permissionProfiles = settledValue(permissionProfilesResult, null);
    const providerCapabilities = settledValue(providerCapabilitiesResult, null);
    const errors = settledErrorMessages([
      accountResult,
      authStatusResult,
      rateLimitsResult,
      usageResult,
      modelsResult,
      permissionProfilesResult,
      providerCapabilitiesResult,
    ]);

    if (account) {
      setAccountStatus(account);
    }
    const telemetry = accountTelemetryText(rateLimits, usage, locale);
    const capabilities = workspaceCapabilitiesText(
      models,
      permissionProfiles,
      providerCapabilities,
      locale,
    );
    setCapabilityPanel(
      accountOverviewPanel(
        {
          account,
          authStatus,
          capabilities,
          errors,
          fallbackAccount,
          platformUser,
          telemetry,
        },
        locale,
      ),
    );
  } catch (error) {
    setCapabilityPanel(accountReadErrorPanel(error, locale));
  }
}

function startAccountLogin(
  params: AccountActionHandlersParams,
  loginParams: LoginAccountParams,
) {
  if (!params.isConnected) {
    return;
  }

  void startAccountLoginWithBackend(params, loginParams);
}

async function startAccountLoginWithBackend(
  params: AccountActionHandlersParams,
  loginParams: LoginAccountParams,
) {
  const { client, locale, setAccountStatus, setCapabilityPanel } = params;

  try {
    const response = await client?.loginAccount(loginParams);
    if (!response) {
      return;
    }

    if (response.type === "chatgpt") {
      setCapabilityPanel(accountChatGptLoginPanel(response, locale));
      return;
    }

    if (response.type === "chatgptDeviceCode") {
      setCapabilityPanel(accountDeviceCodeLoginPanel(response, locale));
      return;
    }

    const account = await client?.getAccount();
    setAccountStatus(account ?? null);
    setCapabilityPanel(accountLoggedInPanel(account ?? null, locale));
  } catch (error) {
    setCapabilityPanel(accountAuthErrorPanel(error, locale));
  }
}

function logoutAccount(params: AccountActionHandlersParams) {
  if (!params.isConnected) {
    return;
  }

  void logoutAccountWithBackend(params);
}

async function logoutAccountWithBackend(params: AccountActionHandlersParams) {
  const { client, locale, setAccountStatus, setCapabilityPanel } = params;

  try {
    await client?.logoutAccount();
    const account = await client?.getAccount();
    setAccountStatus(account ?? null);
    setCapabilityPanel(accountLoggedOutPanel(account ?? null, locale));
  } catch (error) {
    setCapabilityPanel(accountAuthErrorPanel(error, locale));
  }
}
