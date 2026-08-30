import { describe, expect, it } from "vitest";

import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createRemoteControlActionHandlers,
  remoteControlActionForActionId,
  type RemoteControlActionHandlersParams,
} from "./remoteControlActions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
}

function baseParams(
  overrides: Partial<RemoteControlActionHandlersParams> = {},
): RemoteControlActionHandlersParams {
  let panel: CapabilityPanel | null = {
    title: "Computer control",
    body: "Ready",
  };
  return {
    client: {
      async disableRemoteControl() {
        return {
          environmentId: null,
          status: "disabled",
        };
      },
      async enableRemoteControl() {
        return {
          environmentId: "env-1",
          status: "connected",
        };
      },
      async getRemoteControlPairingStatus() {
        return { claimed: false };
      },
      async readRemoteControlStatus() {
        return {
          environmentId: "env-1",
          status: "connected",
        };
      },
      async revokeRemoteControlClient() {},
      async startRemoteControlPairing() {
        return {
          environmentId: "env-1",
          expiresAt: 1_800_000_000,
          manualPairingCode: "manual-1",
          pairingCode: "pair-1",
        };
      },
    },
    fieldValue: () => "client-1",
    locale: "en",
    refreshComputerControlSettingsPanel: () => {},
    setCapabilityPanel: (updater) => {
      panel = updater(panel);
    },
    setNotice: () => {},
    ...overrides,
  };
}

describe("remote control actions", () => {
  it("maps remote control action ids", () => {
    expect(remoteControlActionForActionId("enable-remote-control")).toBe(
      "enable",
    );
    expect(remoteControlActionForActionId("disable-remote-control")).toBe(
      "disable",
    );
    expect(remoteControlActionForActionId("start-remote-pairing")).toBe("pair");
    expect(remoteControlActionForActionId("revoke-remote-client")).toBe(
      "revoke",
    );
    expect(remoteControlActionForActionId("refresh-account")).toBeNull();
  });

  it("toggles remote control and reports status", async () => {
    let panel: CapabilityPanel | null = {
      title: "Computer control",
      body: "Ready",
    };
    let notice: NoticeState | null = null;
    let refreshes = 0;
    const handlers = createRemoteControlActionHandlers(
      baseParams({
        refreshComputerControlSettingsPanel: () => {
          refreshes += 1;
        },
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
        setNotice: (nextNotice) => {
          notice = nextNotice;
        },
      }),
    );

    handlers.enable();
    expect(panel).toEqual({
      title: "Computer control",
      body: "Enabling remote control...",
      error: undefined,
    });

    await flushAsyncAction();

    expect(refreshes).toBe(1);
    expect(notice).toEqual({
      text: "Remote control: connected",
      tone: "success",
    });
  });

  it("creates a pairing panel", async () => {
    let panel: CapabilityPanel | null = {
      title: "Computer control",
      body: "Ready",
    };
    const handlers = createRemoteControlActionHandlers(
      baseParams({
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.pair();
    expect(panel).toMatchObject({
      body: "Creating pairing code...",
      error: undefined,
    });

    await flushAsyncAction();

    expect(panel).toMatchObject({
      title: "Computer control",
      subtitle: "Pairing code created",
      error: undefined,
    });
    expect(panel?.body).toContain("Pairing code: pair-1");
    expect(panel?.body).toContain("Manual pairing code: manual-1");
  });

  it("requires an environment id and client id before revoking", async () => {
    let panel: CapabilityPanel | null = {
      title: "Computer control",
      body: "Ready",
    };
    let revoked = false;
    const handlers = createRemoteControlActionHandlers(
      baseParams({
        client: {
          async disableRemoteControl() {
            return { environmentId: null, status: "disabled" };
          },
          async enableRemoteControl() {
            return { environmentId: null, status: "connected" };
          },
          async getRemoteControlPairingStatus() {
            return { claimed: false };
          },
          async readRemoteControlStatus() {
            return { environmentId: null, status: "connected" };
          },
          async revokeRemoteControlClient() {
            revoked = true;
          },
          async startRemoteControlPairing() {
            return {
              environmentId: "env-1",
              expiresAt: 1,
              manualPairingCode: null,
              pairingCode: "pair-1",
            };
          },
        },
        fieldValue: () => "",
        setCapabilityPanel: (updater) => {
          panel = updater(panel);
        },
      }),
    );

    handlers.revoke();
    await flushAsyncAction();

    expect(revoked).toBe(false);
    expect(panel).toEqual({
      title: "Computer control",
      body: "Ready",
      error: "Missing environment ID or client ID",
    });
  });

  it("revokes remote clients and refreshes computer control", async () => {
    const revoked: Array<{ clientId: string; environmentId: string }> = [];
    let notice: NoticeState | null = null;
    let refreshes = 0;
    const handlers = createRemoteControlActionHandlers(
      baseParams({
        client: {
          async disableRemoteControl() {
            return { environmentId: null, status: "disabled" };
          },
          async enableRemoteControl() {
            return { environmentId: "env-1", status: "connected" };
          },
          async getRemoteControlPairingStatus() {
            return { claimed: false };
          },
          async readRemoteControlStatus() {
            return { environmentId: "env-1", status: "connected" };
          },
          async revokeRemoteControlClient(environmentId, clientId) {
            revoked.push({ clientId, environmentId });
          },
          async startRemoteControlPairing() {
            return {
              environmentId: "env-1",
              expiresAt: 1,
              manualPairingCode: null,
              pairingCode: "pair-1",
            };
          },
        },
        fieldValue: () => "client-1",
        refreshComputerControlSettingsPanel: () => {
          refreshes += 1;
        },
        setNotice: (nextNotice) => {
          notice = nextNotice;
        },
      }),
    );

    handlers.revoke();
    await flushAsyncAction();

    expect(revoked).toEqual([{ clientId: "client-1", environmentId: "env-1" }]);
    expect(refreshes).toBe(1);
    expect(notice).toEqual({
      text: "Revoked client: client-1",
      tone: "success",
    });
  });
});
