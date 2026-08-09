import type { ConnectionState } from "../shared/connectionState";

export function selectThreadRuntimeAuthority<Legacy, Control>(input: {
  controlClientConfigured: boolean;
  controlConnected: boolean;
  controlRuntime: Control | null;
  legacyConnected: boolean;
  legacyConnectionState: ConnectionState;
  legacyRuntime: Legacy | null;
}): Readonly<{
  client: Legacy | Control | null;
  connected: boolean;
  connectionState: ConnectionState;
  legacyManagesThreads: boolean;
}> {
  if (!input.controlClientConfigured) {
    return {
      client: input.legacyRuntime,
      connected: input.legacyConnected,
      connectionState: input.legacyConnectionState,
      legacyManagesThreads: true,
    };
  }
  return {
    client: input.controlConnected ? input.controlRuntime : null,
    connected: input.controlConnected,
    connectionState: input.controlConnected ? "connected" : "connecting",
    legacyManagesThreads: false,
  };
}
