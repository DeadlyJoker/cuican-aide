import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  remoteControlPairingFailurePanel,
  remoteControlPairingProgressPanel,
  remoteControlPairingResultPanel,
  remoteControlRevokeFailurePanel,
  remoteControlRevokeMissingClientPanel,
  remoteControlRevokeNotice,
  remoteControlStatusNotice,
  remoteControlToggleProgressPanel,
  remoteControlUpdateFailurePanel,
  type RemoteControlToggleAction,
} from "../settings/settingsCapabilityPanels";

export type RemoteControlAction = "pair" | "revoke" | RemoteControlToggleAction;

type RemoteControlStatus = {
  environmentId: string | null;
  status: string;
};

type RemoteControlPairingStartResponse = {
  environmentId: string;
  expiresAt: number;
  manualPairingCode: string | null;
  pairingCode: string;
};

type RemoteControlPairingStatusResponse = {
  claimed: boolean;
};

type RemoteControlClient = {
  disableRemoteControl(): Promise<RemoteControlStatus>;
  enableRemoteControl(): Promise<RemoteControlStatus>;
  getRemoteControlPairingStatus(
    pairingCode: string,
    manualPairingCode: string | null,
  ): Promise<RemoteControlPairingStatusResponse>;
  readRemoteControlStatus(): Promise<RemoteControlStatus>;
  revokeRemoteControlClient(
    environmentId: string,
    clientId: string,
  ): Promise<void>;
  startRemoteControlPairing(): Promise<RemoteControlPairingStartResponse>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type RemoteControlActionHandlersParams = {
  client: RemoteControlClient | null | undefined;
  fieldValue: (fieldId: string) => string;
  locale: Locale;
  refreshComputerControlSettingsPanel: () => Promise<void> | void;
  setCapabilityPanel: SetCapabilityPanel;
  setNotice: (notice: NoticeState) => void;
};

export function remoteControlActionForActionId(
  actionId: string,
): RemoteControlAction | null {
  switch (actionId) {
    case "enable-remote-control":
      return "enable";
    case "disable-remote-control":
      return "disable";
    case "start-remote-pairing":
      return "pair";
    case "revoke-remote-client":
      return "revoke";
    default:
      return null;
  }
}

export function createRemoteControlActionHandlers(
  params: RemoteControlActionHandlersParams,
): Record<RemoteControlAction, () => void> {
  return {
    disable: () => toggleRemoteControl(params, "disable"),
    enable: () => toggleRemoteControl(params, "enable"),
    pair: () => startRemotePairing(params),
    revoke: () => revokeRemoteClient(params),
  };
}

function toggleRemoteControl(
  params: RemoteControlActionHandlersParams,
  action: RemoteControlToggleAction,
) {
  const {
    client,
    locale,
    refreshComputerControlSettingsPanel,
    setCapabilityPanel,
    setNotice,
  } = params;

  void (async () => {
    setCapabilityPanel((currentPanel) =>
      remoteControlToggleProgressPanel(currentPanel, action, locale),
    );
    try {
      const response =
        action === "enable"
          ? await client?.enableRemoteControl()
          : await client?.disableRemoteControl();
      await refreshComputerControlSettingsPanel();
      setNotice(remoteControlStatusNotice(response?.status, locale));
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        remoteControlUpdateFailurePanel(currentPanel, error, locale),
      );
    }
  })();
}

function startRemotePairing(params: RemoteControlActionHandlersParams) {
  const { client, locale, setCapabilityPanel } = params;

  void (async () => {
    setCapabilityPanel((currentPanel) =>
      remoteControlPairingProgressPanel(currentPanel, locale),
    );
    try {
      const response = await client?.startRemoteControlPairing();
      const status = response
        ? await client?.getRemoteControlPairingStatus(
            response.pairingCode,
            response.manualPairingCode,
          )
        : null;
      setCapabilityPanel((currentPanel) =>
        remoteControlPairingResultPanel(currentPanel, {
          locale,
          response,
          status,
        }),
      );
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        remoteControlPairingFailurePanel(currentPanel, error, locale),
      );
    }
  })();
}

function revokeRemoteClient(params: RemoteControlActionHandlersParams) {
  const {
    client,
    fieldValue,
    locale,
    refreshComputerControlSettingsPanel,
    setCapabilityPanel,
    setNotice,
  } = params;

  void (async () => {
    const environmentId =
      (await client?.readRemoteControlStatus())?.environmentId ?? null;
    const clientId = fieldValue("remote-control-revoke-client");
    if (!environmentId || !clientId) {
      setCapabilityPanel((currentPanel) =>
        remoteControlRevokeMissingClientPanel(currentPanel, locale),
      );
      return;
    }

    try {
      await client?.revokeRemoteControlClient(environmentId, clientId);
      await refreshComputerControlSettingsPanel();
      setNotice(remoteControlRevokeNotice(clientId.trim(), locale));
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        remoteControlRevokeFailurePanel(currentPanel, error, locale),
      );
    }
  })();
}
