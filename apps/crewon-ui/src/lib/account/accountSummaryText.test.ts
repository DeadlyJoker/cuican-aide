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
} from "./accountSummaryText";

const chatGptAccount: AccountStatus = {
  account: {
    type: "chatgpt",
    email: "user@example.com",
    planType: "plus",
  },
  requiresOpenaiAuth: false,
};

describe("account summary panel helpers", () => {
  it("builds account overview and status panels", () => {
    expect(accountDisconnectedPanel("Offline", "en")).toEqual({
      title: "Account",
      subtitle: "Auth, models, permissions, and usage",
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
        telemetry: "Usage\nLifetime tokens: 100",
      },
      "en",
    )).toEqual({
      title: "Account",
      subtitle: "Auth, models, permissions, and usage",
      body: [
        "user@example.com\nplus",
        "Auth status\nMethod: chatgpt\nRequires model account auth: no",
        "Models: 2",
        "Usage\nLifetime tokens: 100",
        "Some reads failed\nusage failed",
      ].join("\n\n"),
      actions: [
        { id: "login-chatgpt", label: "Model login", tone: "primary" },
        { id: "login-device-code", label: "Device code" },
        { id: "logout-account", label: "Logout", tone: "danger" },
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
