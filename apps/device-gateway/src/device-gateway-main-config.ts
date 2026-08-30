import type { DeviceGatewayRuntimeIdentity } from "./device-gateway-runtime-config.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type DeviceGatewayListenConfig = Readonly<{
  host: string;
  port: number;
}>;

/** Allows an ephemeral port only for the explicit PC-local Workspace identity. */
export function resolveDeviceGatewayListenConfig(
  environment: Environment,
  identity: DeviceGatewayRuntimeIdentity,
): DeviceGatewayListenConfig {
  const host = environment.CREWON_DEVICE_GATEWAY_HOST?.trim() || "127.0.0.1";
  const value = environment.CREWON_DEVICE_GATEWAY_PORT?.trim() || "8443";
  if (!/^\d{1,5}$/u.test(value)) {
    throw new Error("CREWON_DEVICE_GATEWAY_PORT_invalid");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("CREWON_DEVICE_GATEWAY_PORT_invalid");
  }
  if (
    port === 0 &&
    (identity.kind !== "standaloneWorkspace" || host !== "127.0.0.1")
  ) {
    throw new Error("CREWON_DEVICE_GATEWAY_PORT_ephemeral_forbidden");
  }
  if (identity.kind === "standaloneWorkspace" && host !== "127.0.0.1") {
    throw new Error("CREWON_DEVICE_GATEWAY_HOST_invalid");
  }
  return { host, port };
}

export function deviceGatewayReadinessLine(
  address: Readonly<{ host: string; port: number; path: string }>,
  identity: DeviceGatewayRuntimeIdentity,
): string {
  if (
    !Number.isSafeInteger(address.port) ||
    address.port < 1 ||
    address.port > 65_535 ||
    address.path !== "/device/v1" ||
    address.host.length < 1 ||
    address.host.length > 253 ||
    /[\u0000-\u0020\u007f/\\[\]]/u.test(address.host) ||
    (identity.kind === "standaloneWorkspace" && address.host !== "127.0.0.1")
  ) {
    throw new Error("device_gateway_ready_address_invalid");
  }
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `CrewON Device Gateway listening on wss://${host}:${address.port}/device/v1`;
}
