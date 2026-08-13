import { describe, expect, it, vi } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  accountActionForActionId,
  createAccountActionHandlers,
  refreshAccountPanelAction,
} from "./accountActions";

function controlClient() {
  return {
    async getAccountSnapshot() {
      return {
        account: {
          identity: {
            principalId: "principal-1",
            actorId: "actor-1",
            tenantId: "tenant-1",
            spaceId: "space-1",
          },
          authentication: {
            status: "authenticated" as const,
            authority: "control" as const,
          },
          usage: { status: "unavailable" as const, reason: "notOwned" as const },
          rateLimits: {
            status: "unavailable" as const,
            reason: "notOwned" as const,
          },
        },
      };
    },
    async getLocalSettings() {
      return {
        settings: {
          locale: "en" as const,
          theme: "dark" as const,
          revision: 1,
          updatedAt: null,
        },
      };
    },
  };
}

describe("account actions", () => {
  it("exposes only the Control-backed refresh action", () => {
    expect(accountActionForActionId("refresh-account")).toBe("refresh");
    expect(accountActionForActionId("login-chatgpt")).toBeNull();
    expect(accountActionForActionId("login-device-code")).toBeNull();
    expect(accountActionForActionId("logout-account")).toBeNull();
  });

  it("delegates refresh to the supplied refresh handler", () => {
    const refreshAccountPanel = vi.fn();
    createAccountActionHandlers({ refreshAccountPanel }).refresh();
    expect(refreshAccountPanel).toHaveBeenCalledOnce();
  });

  it("renders authenticated Control identity and unavailable telemetry", async () => {
    let panel: CapabilityPanel | null = null;
    await refreshAccountPanelAction({
      controlClient: controlClient(),
      locale: "en",
      platformUser: {
        id: 1,
        username: "crew-user",
        email: "user@example.com",
        display_name: "Crew User",
        role: "member",
      },
      setCapabilityPanel: (nextPanel) => {
        panel = nextPanel;
      },
    });

    expect(panel).toMatchInlineSnapshot(`
      {
        "actions": [
          {
            "id": "refresh-account",
            "label": "Refresh",
          },
        ],
        "body": "Control identity: principal-1
      Actor: actor-1
      Tenant / space: tenant-1 / space-1
      Authentication: authenticated (control)
      Enterprise profile: Crew User
      Email: user@example.com
      Language: en
      Theme: dark
      Account usage: unavailable (not owned by Control)
      Account rate limits: unavailable (not owned by Control)
      Model credentials are managed under Model access.",
        "subtitle": "CrewON identity and local preferences",
        "title": "Account",
      }
    `);
  });

  it("fails closed when the Control account is unavailable", async () => {
    let panel: CapabilityPanel | null = null;
    await refreshAccountPanelAction({
      controlClient: null,
      locale: "en",
      platformUser: null,
      setCapabilityPanel: (nextPanel) => {
        panel = nextPanel;
      },
    });
    expect(panel).toEqual({
      title: "Account",
      subtitle: "Auth status",
      error: "Control account unavailable",
    });
  });

  it("surfaces Control read failures without a legacy retry", async () => {
    let panel: CapabilityPanel | null = null;
    await refreshAccountPanelAction({
      controlClient: {
        ...controlClient(),
        async getAccountSnapshot() {
          throw new Error("identity unavailable");
        },
      },
      locale: "en",
      platformUser: null,
      setCapabilityPanel: (nextPanel) => {
        panel = nextPanel;
      },
    });
    expect(panel).toEqual({
      title: "Account",
      subtitle: "Auth status",
      error: "identity unavailable",
    });
  });
});
