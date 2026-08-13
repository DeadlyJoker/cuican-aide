import { describe, expect, it } from "vitest";

import type {
  RemoteControlClient,
  RemoteControlStatusResponse,
} from "../app-server/appServer";
import {
  computerControlDisconnectedPanel,
  computerControlErrorPanel,
  computerControlLoadingPanel,
  computerControlPanel,
  remoteControlPairingFailureMessage,
  remoteControlPairingFailurePanel,
  remoteControlPairingPanel,
  remoteControlPairingProgressBody,
  remoteControlPairingProgressPanel,
  remoteControlPairingResultPanel,
  remoteControlRevokeFailureMessage,
  remoteControlRevokeFailurePanel,
  remoteControlRevokeMissingClientMessage,
  remoteControlRevokeMissingClientPanel,
  remoteControlRevokeNotice,
  remoteControlRevokeNoticeText,
  remoteControlStatusNotice,
  remoteControlStatusNoticeText,
  remoteControlToggleProgressBody,
  remoteControlToggleProgressPanel,
  remoteControlUpdateFailureMessage,
  remoteControlUpdateFailurePanel,
} from "./settingsCapabilityPanels";
function remoteControlStatus(
  overrides: Partial<RemoteControlStatusResponse> = {},
): RemoteControlStatusResponse {
  return {
    status: "connected",
    serverName: "server",
    installationId: "installation-1",
    environmentId: "env-1",
    ...overrides,
  };
}

function remoteControlClient(
  overrides: Partial<RemoteControlClient> = {},
): RemoteControlClient {
  return {
    clientId: "client-1",
    displayName: "MacBook",
    deviceType: "desktop",
    platform: "macos",
    osVersion: "15.0",
    deviceModel: "Mac",
    appVersion: "1.0.0",
    lastSeenAt: 1_700_000_000,
    ...overrides,
  };
}

describe("settings panel text helpers", () => {
  it("builds computer control panels", () => {
    expect(computerControlDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Computer control",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(computerControlLoadingPanel("zh")).toEqual({
      title: "电脑操控",
      subtitle: "远程控制与配对设备",
      body: "正在读取电脑操控状态...",
    });
    expect(
      computerControlPanel({
        clientError: null,
        clients: [remoteControlClient()],
        locale: "en",
        status: remoteControlStatus(),
      }),
    ).toMatchObject({
      title: "Computer control",
      subtitle: "connected · 1 clients",
      body: expect.stringContaining("Computer control"),
      fields: [
        {
          id: "remote-control-revoke-client",
          label: "Client ID to revoke",
          value: "client-1",
        },
      ],
      actions: [
        { id: "refresh-computer-control", label: "Refresh computer control" },
        {
          id: "disable-remote-control",
          label: "Disable remote control",
          tone: "danger",
        },
        { id: "start-remote-pairing", label: "Start pairing" },
        { id: "revoke-remote-client", label: "Revoke client", tone: "danger" },
      ],
    });
    expect(
      computerControlPanel({
        clientError: "client list failed",
        clients: [],
        locale: "en",
        status: remoteControlStatus({
          status: "disabled",
          environmentId: null,
        }),
      }).actions?.[1],
    ).toEqual({
      id: "enable-remote-control",
      label: "Enable remote control",
      tone: "primary",
    });
    expect(computerControlErrorPanel(null, "en")).toEqual({
      title: "Computer control",
      subtitle: "Remote control and paired clients",
      error: "Unable to read computer control",
    });
    expect(computerControlErrorPanel(new Error("denied"), "zh")).toEqual({
      title: "电脑操控",
      subtitle: "远程控制与配对设备",
      error: "denied",
    });
  });

  it("builds remote control action feedback", () => {
    expect(remoteControlToggleProgressBody("enable", "en")).toBe(
      "Enabling remote control...",
    );
    expect(remoteControlToggleProgressBody("disable", "zh")).toBe(
      "正在停用远程控制...",
    );
    expect(
      remoteControlToggleProgressPanel(
        { title: "Computer control", body: "Ready", error: "old error" },
        "enable",
        "en",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Enabling remote control...",
      error: undefined,
    });
    expect(remoteControlStatusNoticeText("connected", "en")).toBe(
      "Remote control: connected",
    );
    expect(remoteControlStatusNotice("errored", "en")).toEqual({
      text: "Remote control: errored",
      tone: "warning",
    });
    expect(remoteControlStatusNotice(null, "zh")).toEqual({
      text: "远程控制状态：unknown",
      tone: "success",
    });
    expect(remoteControlUpdateFailureMessage(null, "zh")).toBe(
      "更新远程控制状态失败",
    );
    expect(
      remoteControlUpdateFailurePanel(
        { title: "Computer control", body: "Updating" },
        null,
        "zh",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Updating",
      error: "更新远程控制状态失败",
    });
    expect(remoteControlPairingProgressBody("en")).toBe(
      "Creating pairing code...",
    );
    expect(
      remoteControlPairingProgressPanel(
        { title: "Computer control", body: "Ready", error: "old error" },
        "en",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Creating pairing code...",
      error: undefined,
    });
    expect(
      remoteControlPairingPanel({
        locale: "en",
        response: null,
        status: null,
      }),
    ).toEqual({
      title: "Computer control",
      subtitle: "Pairing code created",
      body: [
        "Remote control pairing",
        "Pairing code: ",
        "Environment ID: ",
        "Claimed: no",
      ].join("\n"),
      actions: [
        {
          id: "refresh-computer-control",
          label: "Back to computer control",
        },
      ],
      fields: undefined,
      error: undefined,
    });
    expect(
      remoteControlPairingResultPanel(
        { title: "Existing", body: "Old", error: "old error" },
        { locale: "en", response: null, status: null },
      ),
    ).toEqual({
      title: "Computer control",
      subtitle: "Pairing code created",
      body: [
        "Remote control pairing",
        "Pairing code: ",
        "Environment ID: ",
        "Claimed: no",
      ].join("\n"),
      actions: [
        {
          id: "refresh-computer-control",
          label: "Back to computer control",
        },
      ],
      fields: undefined,
      error: undefined,
    });
    expect(remoteControlPairingFailureMessage(null, "zh")).toBe(
      "创建配对码失败",
    );
    expect(
      remoteControlPairingFailurePanel(
        { title: "Computer control", body: "Creating" },
        null,
        "zh",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Creating",
      error: "创建配对码失败",
    });
    expect(remoteControlRevokeMissingClientMessage("en")).toBe(
      "Missing environment ID or client ID",
    );
    expect(
      remoteControlRevokeMissingClientPanel(
        { title: "Computer control", body: "Ready" },
        "en",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Ready",
      error: "Missing environment ID or client ID",
    });
    expect(remoteControlRevokeNoticeText("client-1", "zh")).toBe(
      "已撤销设备：client-1",
    );
    expect(remoteControlRevokeNotice("client-1", "en")).toEqual({
      text: "Revoked client: client-1",
      tone: "success",
    });
    expect(remoteControlRevokeFailureMessage(new Error("denied"), "en")).toBe(
      "denied",
    );
    expect(
      remoteControlRevokeFailurePanel(
        { title: "Computer control", body: "Ready" },
        null,
        "en",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Ready",
      error: "Unable to revoke client",
    });
    expect(remoteControlToggleProgressPanel(null, "disable", "en")).toBeNull();
    expect(remoteControlUpdateFailurePanel(null, null, "en")).toBeNull();
    expect(remoteControlPairingProgressPanel(null, "en")).toBeNull();
    expect(
      remoteControlPairingResultPanel(null, {
        locale: "en",
        response: null,
        status: null,
      }),
    ).toBeNull();
    expect(remoteControlPairingFailurePanel(null, null, "en")).toBeNull();
    expect(remoteControlRevokeMissingClientPanel(null, "en")).toBeNull();
    expect(remoteControlRevokeFailurePanel(null, null, "en")).toBeNull();
  });
});
