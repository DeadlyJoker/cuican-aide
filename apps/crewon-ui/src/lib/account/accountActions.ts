import type { ControlApiClient } from "@crewon/control-client";

import type { AgentPlatformUser } from "../agent-platform/agentPlatformSession";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import { accountReadErrorPanel } from "./accountSummaryText";

export type AccountAction = "refresh";

export type AccountActionHandlersParams = {
  refreshAccountPanel: () => Promise<void> | void;
};

export type RefreshAccountPanelActionParams = {
  controlClient?: Pick<
    ControlApiClient,
    "getAccountSnapshot" | "getLocalSettings"
  > | null;
  locale: Locale;
  platformUser: AgentPlatformUser | null;
  setCapabilityPanel: (panel: CapabilityPanel) => void;
};

export function accountActionForActionId(
  actionId: string,
): AccountAction | null {
  return actionId === "refresh-account" ? "refresh" : null;
}

export function createAccountActionHandlers(
  params: AccountActionHandlersParams,
): Record<AccountAction, () => void> {
  return {
    refresh: () => {
      void params.refreshAccountPanel();
    },
  };
}

export async function refreshAccountPanelAction({
  controlClient,
  locale,
  platformUser,
  setCapabilityPanel,
}: RefreshAccountPanelActionParams): Promise<void> {
  try {
    if (controlClient == null) {
      throw new Error(
        locale === "zh" ? "Control 账号不可用" : "Control account unavailable",
      );
    }
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
          ? "模型凭据在“模型接入”中管理。"
          : "Model credentials are managed under Model access.",
      ]
        .filter((line): line is string => line !== null)
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
}
