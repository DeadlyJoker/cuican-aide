import { describe, expect, it } from "vitest";

import type { AccountStatus } from "../shared/statusTypes";
import {
  accountAuthErrorPanel,
  accountChatGptLoginPanel,
  accountDeviceCodeLoginPanel,
  accountDisconnectedPanel,
  accountLoggedInPanel,
  accountLoggedOutPanel,
  accountLoadingPanel,
  accountOverviewPanel,
  accountReadErrorPanel,
  platformIdentityText,
} from "./accountSummaryText";

const chatGptAccount: AccountStatus = {
  account: {
    type: "chatgpt",
    email: "user@example.com",
    planType: "plus",
  },
  requiresOpenaiAuth: false,
};

/*
 * The panel showed only the ChatGPT/Codex credential under the title
 * "account", so CrewON looked as though it had no identity of its own. The
 * enterprise account from agent-platform now leads the panel.
 */
describe("enterprise identity", () => {
  it("leads with the enterprise account and labels the model credential", () => {
    expect(
      platformIdentityText(
        {
          id: 1,
          username: "admin",
          email: "admin@aicuican.com",
          role: "admin",
          display_name: "\u7ba1\u7406\u5458",
          linked_providers: ["wecom"],
        },
        "zh",
      ),
    ).toBe(
      ["\u4f01\u4e1a\u8d26\u53f7\uff1a\u7ba1\u7406\u5458", "admin@aicuican.com", "\u89d2\u8272\uff1aadmin", "\u4f01\u4e1a\u5fae\u4fe1\u5df2\u7ed1\u5b9a"].join("\n"),
    );
  });

  it("reports a signed-out enterprise account instead of staying silent", () => {
    expect(platformIdentityText(null, "en")).toBe(
      "Enterprise account: signed out",
    );
  });
});

describe("account summary panel helpers", () => {
  it("builds account overview and status panels", () => {
    expect(accountDisconnectedPanel("Offline", "en")).toEqual({
      title: "Account",
      subtitle: "Enterprise identity, model account, and usage",
      body: "Offline",
    });
    expect(accountLoadingPanel("zh")).toEqual({
      title: "账号",
      subtitle: "认证状态",
      body: "正在读取...",
    });
    expect(accountOverviewPanel(
      {
        account: null,
        authStatus: {
          authMethod: "chatgpt",
          authToken: null,
          requiresOpenaiAuth: false,
        },
        capabilities: "Models: 2",
        errors: ["usage failed"],
        fallbackAccount: chatGptAccount,
        platformUser: null,
        telemetry: "Usage\nLifetime tokens: 100",
      },
      "en",
    )).toEqual({
      title: "Account",
      subtitle: "Enterprise identity, model account, and usage",
      body: [
        "Enterprise account: signed out",
        "Model account\nuser@example.com\nplus",
        "Auth status\nMethod: chatgpt\nRequires model account auth: no",
        "Models: 2",
        "Usage\nLifetime tokens: 100",
        "Some reads failed\nusage failed",
      ].join("\n\n"),
      actions: [
        { id: "login-chatgpt", label: "Model login", tone: "primary" },
        { id: "login-device-code", label: "Device code" },
        {
          id: "logout-account",
          label: "Sign out of model account",
          tone: "danger",
        },
        { id: "refresh-account", label: "Refresh" },
      ],
    });
  });

  it("builds auth action panels", () => {
    expect(accountChatGptLoginPanel(
      {
        type: "chatgpt",
        authUrl: "https://auth.example",
        loginId: "login-1",
      },
      "en",
    )).toEqual({
      title: "Account",
      subtitle: "Model login",
      body: "Open this URL to finish login\nhttps://auth.example\nloginId: login-1",
      actions: [
        { id: "refresh-account", label: "Refresh status", tone: "primary" },
      ],
    });
    expect(accountDeviceCodeLoginPanel(
      {
        type: "chatgptDeviceCode",
        verificationUrl: "https://device.example",
        userCode: "ABCD-EFGH",
        loginId: "login-2",
      },
      "zh",
    )).toEqual({
      title: "账号",
      subtitle: "设备码登录",
      body: "访问链接并输入代码\nhttps://device.example\nABCD-EFGH\nloginId: login-2",
      actions: [{ id: "refresh-account", label: "刷新状态", tone: "primary" }],
    });
    expect(accountLoggedOutPanel(null, "en")).toEqual({
      title: "Account",
      subtitle: "Logged out",
      body: "Reading account status...",
    });
    expect(accountLoggedInPanel(chatGptAccount, "zh")).toEqual({
      title: "账号",
      subtitle: "已登录",
      body: "user@example.com\nplus",
    });
  });

  it("builds account error panels", () => {
    expect(accountReadErrorPanel(null, "en")).toEqual({
      title: "Account",
      subtitle: "Auth status",
      error: "Unable to read account",
    });
    expect(accountAuthErrorPanel(new Error("denied"), "zh")).toEqual({
      title: "账号",
      subtitle: "认证操作",
      error: "denied",
    });
  });
});
