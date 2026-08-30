import type { ConnectionState } from "../shared/connectionState";

export function selectThreadRuntimeAuthority<Control>(input: {
  controlClientConfigured: boolean;
  controlConnected: boolean;
  controlConnectionState: ConnectionState;
  controlRuntime: Control | null;
}): Readonly<{
  client: Control | null;
  connected: boolean;
  connectionState: ConnectionState;
  legacyManagesThreads: boolean;
}> {
  if (!input.controlClientConfigured || !input.controlConnected) {
    return {
      client: null,
      connected: false,
      connectionState: input.controlClientConfigured
        ? input.controlConnectionState
        : "disconnected",
      legacyManagesThreads: false,
    };
  }
  return {
    client: input.controlRuntime,
    connected: true,
    connectionState: "connected",
    legacyManagesThreads: false,
  };
}
