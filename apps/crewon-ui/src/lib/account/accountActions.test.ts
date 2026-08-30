import type { Account } from "@crewon/app-server-protocol/v2/Account";
import { describe, expect, it } from "vitest";

import type { AccountStatus } from "../shared/statusTypes";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  accountActionForActionId,
  createAccountActionHandlers,
  refreshAccountPanelAction,
  type AccountActionHandlersParams,
  type RefreshAccountPanelActionParams,
} from "./accountActions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    email: "user@example.com",
    planType: "pro",
    ...overrides,
  } as Account;
}

function accountStatus(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    account: account(),
    requiresOpenaiAuth: false,
    ...overrides,
  };
}

function baseParams(
  overrides: Partial<AccountActionHandlersParams> = {},
): AccountActionHandlersParams {
  let panel: CapabilityPanel | null = null;
  let status: AccountStatus | null = null;
  return {
    client: {
      async getAccount() {
        return accountStatus();
      },
      async loginAccount() {
        return { type: "chatgptAuthTokens" };
      },
      async logoutAccount() {},
    },
    isConnected: true,
    locale: "en",
    refreshAccountPanel: () => {},
    setAccountStatus: (account) => {
      status = account;
    },
    setCapabilityPanel: (nextPanel) => {
      panel = nextPanel;
    },
    ...overrides,
  };
}

type RefreshClient = NonNullable<RefreshAccountPanelActionParams["client"]>;

function refreshClient(overrides: Partial<RefreshClient> = {}): RefreshClient {
  return {
    async getAccount() {
      return accountStatus();
    },
    async getAccountRateLimits() {
      return { rateLimits: null } as unknown as Awaited<
        ReturnType<RefreshClient["getAccountRateLimits"]>
      >;
    },
    async getAccountUsage() {
      return {
        dailyUsageBuckets: [],
        summary: {
          currentStreakDays: 0,
          lifetimeTokens: 1200,
          peakDailyTokens: 300,
        },
      } as unknown as Awaited<ReturnType<RefreshClient["getAccountUsage"]>>;
    },
    async getAuthStatus() {
      return {
        authMethod: "chatgpt",
        requiresOpenaiAuth: false,
      } as unknown as Awaited<ReturnType<RefreshClient["getAuthStatus"]>>;
    },
    async getModelProviderCapabilities() {
      return {
        imageGeneration: true,
        namespaceTools: false,
        webSearch: true,
      };
    },
    async listModels() {
      return {
        data: [
          {
            displayName: "GPT Test",
            id: "gpt-test",
            isDefault: true,
            model: "gpt-test",
          },
        ],
        nextCursor: null,
      } as Awaited<ReturnType<RefreshClient["listModels"]>>;
    },
    async listPermissionProfiles() {
      return {
        data: [{ description: "Default profile", id: "default" }],
        nextCursor: null,
      } as Awaited<ReturnType<RefreshClient["listPermissionProfiles"]>>;
    },
    ...overrides,
  };
}

function baseRefreshParams(
  overrides: Partial<RefreshAccountPanelActionParams> = {},
): RefreshAccountPanelActionParams {
  return {
    client: refreshClient(),
    connectionHint: "Offline",
    connectionState: "connected",
    fallbackAccount: null,
    isConnected: true,
    locale: "en",
    platformUser: null,
    resolveBackendCwd: async () => "/repo",
    setAccountStatus: () => {},
    setCapabilityPanel: () => {},
    ...overrides,
  };
}

describe("account actions", () => {
  it("maps account action ids", () => {
    expect(accountActionForActionId("refresh-account")).toBe("refresh");
    expect(accountActionForActionId("login-chatgpt")).toBe("loginChatGpt");
    expect(accountActionForActionId("login-device-code")).toBe(
      "loginDeviceCode",
    );
    expect(accountActionForActionId("logout-account")).toBe("logout");
    expect(accountActionForActionId("search-files")).toBeNull();
  });

  it("delegates refresh to the supplied refresh handler", () => {
    let refreshed = false;
    const handlers = createAccountActionHandlers(
      baseParams({
        refreshAccountPanel: () => {
          refreshed = true;
        },
      }),
    );

    handlers.refresh();

    expect(refreshed).toBe(true);
  });

  it("starts ChatGPT browser login", async () => {
    let panel: CapabilityPanel | null = null;
    const loginParams: unknown[] = [];
    const handlers = createAccountActionHandlers(
      baseParams({
        client: {
          async getAccount() {
            return accountStatus();
          },
          async loginAccount(params) {
            loginParams.push(params);
            return {
              type: "chatgpt",
              authUrl: "https://login.example",
              loginId: "login-1",
            };
          },
          async logoutAccount() {},
        },
        setCapabilityPanel: (nextPanel) => {
          panel = nextPanel;
        },
      }),
    );

    handlers.loginChatGpt();
    await flushAsyncAction();

    expect(loginParams).toEqual([{ type: "chatgpt" }]);
    expect(panel).toMatchObject({
      body: "Open this URL to finish login\nhttps://login.example\nloginId: login-1",
      subtitle: "Model login",
    });
  });

  it("starts device code login", async () => {
    let panel: CapabilityPanel | null = null;
    const loginParams: unknown[] = [];
    const handlers = createAccountActionHandlers(
      baseParams({
        client: {
          async getAccount() {
            return accountStatus();
          },
          async loginAccount(params) {
            loginParams.push(params);
            return {
              type: "chatgptDeviceCode",
              verificationUrl: "https://device.example",
              userCode: "ABCD",
              loginId: "login-2",
            };
          },
          async logoutAccount() {},
        },
        setCapabilityPanel: (nextPanel) => {
          panel = nextPanel;
        },
      }),
    );

    handlers.loginDeviceCode();
    await flushAsyncAction();

    expect(loginParams).toEqual([{ type: "chatgptDeviceCode" }]);
    expect(panel).toMatchObject({
      body: "Open the URL and enter the code\nhttps://device.example\nABCD\nloginId: login-2",
      subtitle: "Device code login",
    });
  });

  it("updates account status after completed login", async () => {
    let panel: CapabilityPanel | null = null;
    const statuses: AccountStatus[] = [];
    const handlers = createAccountActionHandlers(
      baseParams({
        client: {
          async getAccount() {
            return accountStatus({ account: account({ email: "new@example.com" }) });
          },
          async loginAccount() {
            return { type: "chatgptAuthTokens" };
          },
          async logoutAccount() {},
        },
        setAccountStatus: (account) => {
          if (account) {
            statuses.push(account);
          }
        },
        setCapabilityPanel: (nextPanel) => {
          panel = nextPanel;
        },
      }),
    );

    handlers.loginChatGpt();
    await flushAsyncAction();

    expect(statuses[0]).toMatchObject({
      account: { email: "new@example.com" },
    });
    expect(panel).toMatchObject({ subtitle: "Logged in" });
  });

  it("logs out and refreshes account status", async () => {
    let panel: CapabilityPanel | null = null;
    let status: AccountStatus | null = null;
    let loggedOut = false;
    const handlers = createAccountActionHandlers(
      baseParams({
        client: {
          async getAccount() {
            return accountStatus({ account: null });
          },
          async loginAccount() {
            return { type: "chatgptAuthTokens" };
          },
          async logoutAccount() {
            loggedOut = true;
          },
        },
        setAccountStatus: (account) => {
          status = account;
        },
        setCapabilityPanel: (nextPanel) => {
          panel = nextPanel;
        },
      }),
    );

    handlers.logout();
    await flushAsyncAction();

    expect(loggedOut).toBe(true);
    expect(status).toEqual(accountStatus({ account: null }));
    expect(panel).toMatchObject({ subtitle: "Logged out" });
  });

  it("shows auth errors", async () => {
    let panel: CapabilityPanel | null = null;
    const handlers = createAccountActionHandlers(
      baseParams({
        client: {
          async getAccount() {
            return accountStatus();
          },
          async loginAccount() {
            throw new Error("denied");
          },
          async logoutAccount() {},
        },
        setCapabilityPanel: (nextPanel) => {
          panel = nextPanel;
        },
      }),
    );

    handlers.loginChatGpt();
    await flushAsyncAction();

    expect(panel).toMatchObject({
      error: "denied",
      subtitle: "Auth action",
    });
  });

  it("shows a disconnected refresh panel without backend reads", async () => {
    let panel: CapabilityPanel | null = null;
    let read = false;

    await refreshAccountPanelAction(
      baseRefreshParams({
        client: refreshClient({
          async getAccount() {
            read = true;
            return accountStatus();
          },
        }),
        connectionState: "connecting",
        isConnected: false,
        setCapabilityPanel: (nextPanel) => {
          panel = nextPanel;
        },
      }),
    );

    expect(read).toBe(false);
    expect(panel).toEqual({
      title: "Account",
      subtitle: "Enterprise identity, model account, and usage",
      body: "Connecting to local app-server...",
    });
  });

  it("loads account overview data and updates account status", async () => {
    let panel: CapabilityPanel | null = null;
    let status: AccountStatus | null = null;
    const permissionCwds: Array<string | undefined> = [];

    await refreshAccountPanelAction(
      baseRefreshParams({
        client: refreshClient({
          async listPermissionProfiles(cwd) {
            permissionCwds.push(cwd);
            return {
              data: [{ description: "Default profile", id: "default" }],
              nextCursor: null,
            } as Awaited<ReturnType<RefreshClient["listPermissionProfiles"]>>;
          },
        }),
        setAccountStatus: (account) => {
          status = account;
        },
        setCapabilityPanel: (nextPanel) => {
          panel = nextPanel;
        },
      }),
    );

    expect(permissionCwds).toEqual(["/repo"]);
    expect(status).toEqual(accountStatus());
    expect(panel).toMatchObject({
      title: "Account",
      subtitle: "Enterprise identity, model account, and usage",
      body: expect.stringContaining("GPT Test"),
    });
    const panelBody = (panel as CapabilityPanel | null)?.body ?? "";
    expect(panelBody).toContain("Permission profiles: default");
    expect(panelBody).toContain("Lifetime tokens: 1200");
  });

  it("keeps partial account overview data when one refresh read fails", async () => {
    let panel: CapabilityPanel | null = null;

    await refreshAccountPanelAction(
      baseRefreshParams({
        client: refreshClient({
          async listModels() {
            throw new Error("models unavailable");
          },
        }),
        setCapabilityPanel: (nextPanel) => {
          panel = nextPanel;
        },
      }),
    );

    expect(panel).toMatchObject({
      title: "Account",
      body: expect.stringContaining("Some reads failed\nmodels unavailable"),
    });
    const panelBody = (panel as CapabilityPanel | null)?.body ?? "";
    expect(panelBody).toContain("Permission profiles: default");
  });

  it("shows account read errors when preparing refresh fails", async () => {
    let panel: CapabilityPanel | null = null;

    await refreshAccountPanelAction(
      baseRefreshParams({
        resolveBackendCwd: async () => {
          throw new Error("cwd failed");
        },
        setCapabilityPanel: (nextPanel) => {
          panel = nextPanel;
        },
      }),
    );

    expect(panel).toMatchObject({
      error: "cwd failed",
      subtitle: "Auth status",
      title: "Account",
    });
  });
});
