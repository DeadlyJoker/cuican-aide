import { validateGatewayId } from "./device-connection-route-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type DeviceGatewayRuntimeIdentity =
  | Readonly<{ kind: "team"; gatewayId: string }>
  | Readonly<{ kind: "standaloneWorkspace"; gatewayId: string }>
  | Readonly<{ kind: "standaloneToolOnly" }>;

/** Selects an explicit Team or local-only Workspace route identity. */
export function resolveDeviceGatewayRuntimeIdentity(
  environment: Environment,
  authority: "postgres" | "sqlite",
): DeviceGatewayRuntimeIdentity {
  const teamGatewayId = optionalEnvironment(
    environment,
    "CREWON_DEVICE_GATEWAY_ID",
  );
  const localWorkspaceGatewayId = optionalEnvironment(
    environment,
    "CREWON_DEVICE_GATEWAY_LOCAL_WORKSPACE_GATEWAY_ID",
  );
  if (teamGatewayId !== null && localWorkspaceGatewayId !== null) {
    throw new DeviceGatewayError("device_gateway_runtime_identity_invalid");
  }
  if (authority === "postgres") {
    if (teamGatewayId === null || localWorkspaceGatewayId !== null) {
      throw new DeviceGatewayError("device_gateway_runtime_identity_invalid");
    }
    return { kind: "team", gatewayId: validateGatewayId(teamGatewayId) };
  }
  if (teamGatewayId !== null) {
    throw new DeviceGatewayError("device_gateway_runtime_identity_invalid");
  }
  return localWorkspaceGatewayId === null
    ? { kind: "standaloneToolOnly" }
    : {
        kind: "standaloneWorkspace",
        gatewayId: validateGatewayId(localWorkspaceGatewayId),
      };
}

function optionalEnvironment(
  environment: Environment,
  name: string,
): string | null {
  const value = environment[name];
  return value === undefined || value.trim().length === 0 ? null : value.trim();
}
